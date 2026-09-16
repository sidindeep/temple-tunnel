const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const VERSION = /^\d+\.\d+\.\d+$/;
function compare(a,b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('Некорректная версия пакета.');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i=0;i<3;i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function verifyEnvelope(bytes, publicKey, appVersion, rollback = false) {
  if (bytes.length > 65536) throw new Error('Манифест обновления слишком большой.');
  let envelope, manifest;
  try {
    envelope = JSON.parse(bytes.toString('utf8'));
    const payload = Buffer.from(envelope.payload,'base64');
    if (!crypto.verify(null,payload,publicKey,Buffer.from(envelope.signature,'base64'))) throw Error();
    manifest = JSON.parse(payload.toString('utf8'));
  } catch { throw new Error('Подпись пакета обновления недействительна.'); }
  if (manifest.product !== 'temple-tunnel' || manifest.schema !== 1 || !['cores','app'].includes(manifest.kind)
      || !VERSION.test(manifest.version) || !VERSION.test(manifest.minApp)
      || compare(appVersion,manifest.minApp) < 0) throw new Error('Пакет несовместим с этой версией приложения.');
  if (manifest.kind === 'cores' && (!VERSION.test(manifest.maxApp) || compare(appVersion,manifest.maxApp) > 0))
    throw new Error('Ядра не проверены для этой версии приложения.');
  if (manifest.kind === 'app' && !rollback && compare(manifest.version,appVersion) < 0)
    throw new Error('Эта версия уже установлена или старее текущей.');
  const expected = manifest.kind === 'cores' ? ['sing-box.exe','xray.exe'] : ['setup.exe'];
  if (!Array.isArray(manifest.files) || manifest.files.length !== expected.length) throw new Error('Неполный пакет обновления.');
  const seen = new Set();
  for (const file of manifest.files) {
    if (!expected.includes(file.name) || seen.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 512*1024*1024
        || (manifest.kind === 'cores' && !VERSION.test(file.version))) throw new Error('Некорректный список файлов пакета.');
    seen.add(file.name);
  }
  return manifest;
}
async function hash(file) {
  const digest = crypto.createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; digest.update(chunk); }
  return { sha256: digest.digest('hex'), size };
}
async function verifyFiles(directory, manifest) {
  const root = await fs.realpath(directory);
  for (const file of manifest.files) {
    const target = path.join(root,file.name);
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size
        || path.dirname(await fs.realpath(target)).toLowerCase() !== root.toLowerCase()) throw new Error('Файл пакета подменён или имеет неверный размер.');
    const actual = await hash(target);
    if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw new Error('Контрольная сумма пакета не совпадает.');
  }
}
function createUpdates(root, publicKey, appVersion) {
  const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
  async function readGeneration(id, rollback = true) {
    if (!validId(id)) throw new Error('Некорректная сохранённая версия.');
    const directory = path.join(root,id);
    const bytes = await fs.readFile(path.join(directory,'update.json'));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Манифест был изменён.');
    const manifest = verifyEnvelope(bytes,publicKey,appVersion,rollback);
    await verifyFiles(directory,manifest);
    return { id, directory, manifest };
  }
  async function pointer(kind) {
    try { return JSON.parse(await fs.readFile(path.join(root,`${kind}.json`),'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async function publish(kind, value) {
    const temp = path.join(root,`${kind}-${crypto.randomUUID()}.tmp`);
    try { await fs.writeFile(temp,JSON.stringify(value),{flag:'wx'}); await fs.rename(temp,path.join(root,`${kind}.json`)); }
    finally { await fs.rm(temp,{force:true}); }
  }
  return {
    async stage(file) {
      if ((await fs.stat(file)).size > 65536) throw new Error('Манифест слишком большой.');
      const bytes = await fs.readFile(file), manifest = verifyEnvelope(bytes,publicKey,appVersion);
      await verifyFiles(path.dirname(file),manifest);
      await fs.mkdir(root,{recursive:true});
      const id = crypto.createHash('sha256').update(bytes).digest('hex');
      const directory = path.join(root,id);
      try { return await readGeneration(id,false); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const staging = await fs.mkdtemp(path.join(root,'stage-'));
      try {
        for (const entry of manifest.files) await pipeline(createReadStream(path.join(path.dirname(file),entry.name)),createWriteStream(path.join(staging,entry.name),{flags:'wx'}));
        await fs.writeFile(path.join(staging,'update.json'),bytes,{flag:'wx'});
        await verifyFiles(staging,manifest);
        await fs.rename(staging,directory);
        return {id,directory,manifest};
      } finally { await fs.rm(staging,{recursive:true,force:true}); }
    },
    async current(kind) { const saved = await pointer(kind); return saved.current ? readGeneration(saved.current) : null; },
    async activate(generation) {
      const fresh = await readGeneration(generation.id);
      const saved = await pointer(fresh.manifest.kind);
      if (saved.current === fresh.id) return fresh;
      await publish(fresh.manifest.kind,{current:fresh.id,previous:saved.current || null});
      return fresh;
    },
    async previous(kind) { const saved = await pointer(kind); return saved.previous ? readGeneration(saved.previous) : null; },
    async rollbackCores() {
      const saved = await pointer('cores');
      const previous = saved.previous ? await readGeneration(saved.previous) : null;
      await publish('cores',{current:previous?.id || null,previous:saved.current || null});
      return previous;
    },
    readGeneration
  };
}
module.exports = { compare, verifyEnvelope, verifyFiles, hash, createUpdates };
