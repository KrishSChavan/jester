/**
 * A Mac's Jester, moved to his server when the Mac links to it (the user, 2026-11-18, asked what linking should carry
 * over: "Everything, keys included"): so he's the same Jester there, with nothing to set up again.
 *
 * Once, the first time a Mac links to a server that nothing's been moved to: the Mac sends what its Jester keeps
 * (`collect`), over the same link everything else goes by (its own devices' network, encrypted), and the server
 * keeps it as its own (`apply`), sealing the keys with its own key file, then starts again with it. After that the
 * server's is the one that counts, and a Mac linking is told so (`already`), so nothing here overwrites it.
 *
 * What moves: the models' keys, the Gmail sign-in, calendars' links, taught phrases, the user's voiceprint, settings,
 * what's been told and offered, and the files for tasks, reminders, chats and what he recalls of them. What stays:
 * what's the Mac's alone (its scripts and scenes, which run there; the watch's key; the pointer's calibration; the
 * user's face, scanned for training mode, which only its camera uses; ntfy, which his own app replaces; this link
 * itself).
 */

import fs from 'node:fs';
import path from 'node:path';

export const MOVE_KEYS = Object.freeze(['settings', 'modelConnections', 'modelConnectionConfigured', 'modelSpend', 'calendarFeeds', 'google', 'mail', 'desktopLearned', 'voiceprint', 'voiceLearned', 'voiceTrained', 'briefDays', 'checkinsTold', 'workOffers', 'briefingSnapshots', 'setUpOnce']);
export const MOVE_FILES = Object.freeze(['tasks.json', 'jobs.json', 'chats.json', 'recollections.json', 'chat-learning.json']);
/** Settings that are a computer's own: the server keeps its own for these. */
const OWN_SETTINGS = ['cameraDeviceId', 'vaultPath', 'vault'];
const MOST_BYTES = 6 * 1024 * 1024;

/** What a Mac's Jester keeps, to send: { storage, files }. */
export async function collect({ storage, dataDir }) {
  const kept = await storage.get([...MOVE_KEYS]);
  const files = {};
  for (const name of MOVE_FILES) {
    try {
      files[name] = fs.readFileSync(path.join(dataDir, name), 'utf8');
    } catch {
      /* none of that yet */
    }
  }
  return { storage: Object.fromEntries(Object.entries(kept).filter(([key, value]) => MOVE_KEYS.includes(key) && value !== undefined)), files };
}

/**
 * What was sent, checked: only the keys and files above, each file JSON, none of it too big. Null if it isn't a move.
 */
export function checked(move) {
  if (!move || typeof move !== 'object' || typeof move.storage !== 'object' || typeof move.files !== 'object') return null;
  const storage = Object.fromEntries(Object.entries(move.storage || {}).filter(([key, value]) => MOVE_KEYS.includes(key) && value !== undefined && value !== null));
  const files = {};
  for (const [name, text] of Object.entries(move.files || {})) {
    if (!MOVE_FILES.includes(name) || typeof text !== 'string') continue;
    try {
      JSON.parse(text);
    } catch {
      continue;
    }
    files[name] = text;
  }
  if (JSON.stringify(storage).length + Object.values(files).reduce((sum, text) => sum + text.length, 0) > MOST_BYTES) return null;
  return { storage, files };
}

/**
 * A move kept as this server's own. Its own settings for what's a computer's stay; the files replace its own, the
 * ones there kept beside them (`.before-move`).
 * @returns {Promise<{ok:boolean, why?:string, moved?:string[]}>}
 */
export async function apply(move, { storage, dataDir, from = '', now = Date.now }) {
  if ((await storage.get('movedIn')).movedIn) return { ok: false, already: true, why: 'This server already has a Jester moved to it.' };
  const sent = checked(move);
  if (!sent) return { ok: false, why: 'That wasn’t a Jester’s things.' };
  const mine = (await storage.get('settings')).settings || {};
  const next = { ...sent.storage };
  if (next.settings && typeof next.settings === 'object') {
    next.settings = { ...next.settings };
    for (const key of OWN_SETTINGS) {
      delete next.settings[key];
      if (key in mine) next.settings[key] = mine[key];
    }
  }
  for (const [name, text] of Object.entries(sent.files)) {
    const file = path.join(dataDir, name);
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.before-move`);
    } catch {
      /* nothing to keep */
    }
    fs.writeFileSync(`${file}.moving`, text, { mode: 0o600 });
    fs.renameSync(`${file}.moving`, file);
  }
  await storage.set({ ...next, movedIn: { at: now(), from: String(from).slice(0, 40) } });
  return { ok: true, moved: [...Object.keys(next), ...Object.keys(sent.files)] };
}
