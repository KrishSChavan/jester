/**
 * `chrome.storage`-shaped areas for the main process.
 *
 * `local` is a JSON file in the app's data folder, written whole and renamed
 * into place so a crash mid-write can't leave half a settings file. `session`
 * lives in memory: Chrome clears it when the browser closes, the app when it
 * quits.
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

export function createStorageArea({ file = null, onChanged = () => undefined } = {}) {
  let data = {};
  if (file) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Could not read ${file}; starting empty:`, err.message);
    }
  }
  let writing = Promise.resolve();

  function persist() {
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify(data);
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
