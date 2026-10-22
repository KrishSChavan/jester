/**
 * `chrome.storage`-shaped areas for the main process.
 *
 * `local` is a JSON file in the app's data folder, written whole and renamed
 * into place so a crash mid-write can't leave half a settings file. `session`
 * lives in memory: Chrome clears it when the browser closes, the app when it
 * quits.
 *
 * `sealed` keys (API keys) are written encrypted, by functions the caller
 * supplies (Electron's safeStorage: the macOS Keychain, Windows DPAPI).
 */

import fs from 'node:fs';
import path from 'node:path';

function pick(data, keys) {
  if (keys === null || keys === undefined) return structuredClone(data);
  if (typeof keys === 'string') keys = [keys];
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])]));
  }
  // An object names the keys and supplies a default for each.
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, structuredClone(Object.hasOwn(data, key) ? data[key] : fallback)]));
}

/**
 * @param {object} [options]
 * @param {string|null} [options.file]
 * @param {(changes:object) => void} [options.onChanged]
 * @param {{keys:string[], seal:(text:string) => string, unseal:(sealed:string) => string}|null} [options.sealed]
 */
export function createStorageArea({ file = null, onChanged = () => undefined, sealed = null } = {}) {
  let data = {};
  if (file) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not read ${file}; starting empty:`, err.message);
    }
  }
  for (const key of sealed?.keys || []) {
    if (typeof data[key]?.sealed !== 'string') continue;
    try {
      data[key] = JSON.parse(sealed.unseal(data[key].sealed));
    } catch (err) {
      // Sealed on another machine or account: unreadable here, so forgotten.
      console.error(`Could not unseal ${key}:`, err.message);
      delete data[key];
    }
  }
  let writing = Promise.resolve();

  function persist() {
    if (!file) return Promise.resolve();
    const onDisk = { ...data };
    for (const key of sealed?.keys || []) {
      if (Object.hasOwn(onDisk, key)) onDisk[key] = { sealed: sealed.seal(JSON.stringify(onDisk[key])) };
    }
    const snapshot = JSON.stringify(onDisk);
    writing = writing.then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, snapshot);
      await fs.promises.rename(temp, file);
    });
    return writing;
  }

  return {
    async get(keys) {
      return pick(data, keys);
    },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items || {})) {
        changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
        data[key] = structuredClone(value);
      }
      await persist();
      if (Object.keys(changes).length) onChanged(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of [keys].flat()) {
        if (!Object.hasOwn(data, key)) continue;
        changes[key] = { oldValue: data[key] };
        delete data[key];
      }
      await persist();
      if (Object.keys(changes).length) onChanged(changes);
    }
  };
}
