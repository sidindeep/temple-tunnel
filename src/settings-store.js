const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function createSettingsStore(file, io = fs) {
  let lastGood = null;

  async function replace(target, contents) {
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await io.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      await io.rename(temporary, target);
    } finally {
      await io.rm(temporary, { force: true }).catch(() => {});
    }
  }

  return {
    async read() {
      try { return await io.readFile(file, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    accept(contents) { lastGood = contents; },
    async hasValidBackup(validate) {
      try {
        const contents = await io.readFile(`${file}.bak`, 'utf8');
        validate(contents);
        return true;
      } catch { return false; }
    },
    async save(contents) {
      await io.mkdir(path.dirname(file), { recursive: true });
      if (lastGood !== null) await replace(`${file}.bak`, lastGood);
      await replace(file, contents);
      lastGood = contents;
    },
    async restore(validate) {
      const contents = await io.readFile(`${file}.bak`, 'utf8');
      validate(contents);
      const damaged = `${file}.damaged-${Date.now()}-${crypto.randomUUID()}`;
      let moved = false;
      try {
        await io.rename(file, damaged);
        moved = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await replace(file, contents); }
      catch (error) {
        if (moved) await io.rename(damaged, file).catch(() => {});
        throw error;
      }
      lastGood = contents;
      return moved ? damaged : null;
    }
  };
}

module.exports = { createSettingsStore };
