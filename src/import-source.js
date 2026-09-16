const fs = require('node:fs/promises');
const { parseSubscription } = require('./subscription');
const MAX_FILE = 8 * 1024 * 1024;
function imageDimensions(data) {
  if (data.length >= 24 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii',12,16) === 'IHDR')
    return {width:data.readUInt32BE(16),height:data.readUInt32BE(20)};
  if (data.length > 4 && data[0] === 255 && data[1] === 216) {
    let offset=2;
    while(offset+4<=data.length) {
      if(data[offset++]!==255)break;
      while(data[offset]===255)offset++;
      const marker=data[offset++];
      if(marker===217 || marker===218)break;
      if(marker===1 || (marker>=208 && marker<=215))continue;
      if(offset+2>data.length)break;
      const size=data.readUInt16BE(offset);
      if(size<2 || offset+size>data.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size>=8)
        return {height:data.readUInt16BE(offset+3),width:data.readUInt16BE(offset+5)};
      offset+=size;
    }
  }
  throw new Error('Выберите корректное изображение PNG или JPEG.');
}
function validateSource(source) {
  const text = String(source || '').replace(/^\uFEFF/, '').trim();
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Содержимое импорта превышает 256 КиБ.');
  if (/^https:\/\/\S+$/i.test(text)) {
    const url = new URL(text);
    if (url.username || url.password) throw new Error('Ссылка не должна содержать имя пользователя или пароль URL.');
    return { source: text, report: 'HTTPS-подписка. Серверы будут загружены после добавления.' };
  }
  const servers = parseSubscription(text);
  const report = servers.importReport;
  return { source: text, report: `Распознано: ${servers.length}. Пропущено: ${report.skipped}. Повторов: ${report.duplicates}.` };
}
async function readImport(file, image, nativeImage, decode = require('jsqr')) {
  const handle = await fs.open(file, 'r');
  let data;
  try {
    if ((await handle.stat()).size > MAX_FILE) throw new Error('Файл превышает 8 МиБ.');
    data = await handle.readFile();
    if (data.length > MAX_FILE) throw new Error('Файл превышает 8 МиБ.');
  } finally { await handle.close(); }
  if (!image) return validateSource(data.toString('utf8'));
  const dimensions = imageDimensions(data);
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > 24000000)
    throw new Error('Изображение слишком большое или повреждено. Обрежьте его до QR-кода.');
  let bitmap = nativeImage.createFromBuffer(data);
  if (bitmap.isEmpty()) throw new Error('Не удалось открыть изображение. Выберите PNG или JPEG.');
  let { width, height } = bitmap.getSize();
  if (width * height > 24000000) throw new Error('Изображение слишком большое. Обрежьте его до QR-кода.');
  if (Math.max(width, height) > 2400) {
    bitmap = bitmap.resize(width >= height ? { width: 2400 } : { height: 2400 });
    ({ width, height } = bitmap.getSize());
  }
  const bgra = bitmap.toBitmap();
  const rgba = new Uint8ClampedArray(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    // NativeImage on Windows uses premultiplied BGRA. Composite onto white.
    const white = 255 - bgra[i + 3];
    rgba[i] = Math.min(255, bgra[i + 2] + white);
    rgba[i + 1] = Math.min(255, bgra[i + 1] + white);
    rgba[i + 2] = Math.min(255, bgra[i] + white); rgba[i + 3] = 255;
  }
  const result = decode(rgba, width, height, { inversionAttempts: 'attemptBoth' });
  if (!result) throw new Error('QR-код не найден. Обрежьте картинку до одного чёткого QR-кода с белой рамкой.');
  return validateSource(result.data);
}
module.exports = { validateSource, readImport, imageDimensions };
