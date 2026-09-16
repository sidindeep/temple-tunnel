const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const SOURCES = {
  geoipRu: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-ru.srs',
  geositeRu: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ru.srs'
};
const LIMIT = 8 * 1024 * 1024;

async function validateRule(executable, file) {
  await run(executable, ['rule-set', 'decompile', file, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
}

function pathsFor(root, generation) {
  return Object.fromEntries(Object.keys(SOURCES).map(key => [key, path.join(root, generation, `${key}.srs`)]));
}

async function loadCachedRules(root, validate) {
  try {
    const generation = (await fs.readFile(path.join(root, 'current.json'), 'utf8'));
    const { id } = JSON.parse(generation);
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const paths = pathsFor(root, id);
    for (const file of Object.values(paths)) await validate(file);
    return paths;
  } catch { return null; }
}

async function download(url, fetchImpl) {
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(15000), redirect:'error'});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > LIMIT) throw new Error('Rule set too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > LIMIT) throw new Error('Rule set too large');
    chunks.push(Buffer.from(chunk));
  }
  if (size < 4) throw new Error('Empty rule set');
  return Buffer.concat(chunks);
}

async function updateRules(root, validate, fetchImpl = require('./bootstrap-dns').fetchWithProtection) {
  await fs.mkdir(root, { recursive: true });
  const contents = [];
  for (const [key, url] of Object.entries(SOURCES)) contents.push([key, await download(url, fetchImpl)]);
  const id = crypto.createHash('sha256');
  for (const [key, data] of contents) id.update(key).update(data);
  const generation = id.digest('hex');
  const target = path.join(root, generation);
  const staging = await fs.mkdtemp(path.join(root, 'download-'));
  const pointer = path.join(root, `current-${crypto.randomUUID()}.tmp`);
  try {
    for (const [key, data] of contents) {
      const file = path.join(staging, `${key}.srs`);
      await fs.writeFile(file, data);
      await validate(file);
    }
    try { await fs.rename(staging, target); }
    catch (error) {
      if (!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code)) throw error;
      // Existing immutable generation must still be valid before publishing it.
      for (const file of Object.values(pathsFor(root, generation))) await validate(file);
    }
    await fs.writeFile(pointer, JSON.stringify({id:generation, updatedAt:new Date().toISOString()}));
    await fs.rename(pointer, path.join(root, 'current.json'));
    return pathsFor(root, generation);
  } finally {
    await fs.rm(staging, {recursive:true,force:true});
    await fs.rm(pointer, {force:true});
  }
}

module.exports = {SOURCES, validateRule, loadCachedRules, updateRules};
