/**
 * The apps a spoken name can mean. On macOS: what is installed (the
 * Applications folders) and what is running (jester-driver's `apps`). On
 * Windows: what is running; the Start menu's search finds the rest.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAC_FOLDERS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
/** Kept elsewhere, and still asked for by name. */
const MAC_EXTRA = ['/System/Library/CoreServices/Finder.app'];

/** Every .app in the Applications folders, and one folder down (Microsoft Office, Adobe …). */
export function installedApps(platform = process.platform, folders = MAC_FOLDERS) {
  if (platform !== 'darwin') return [];
  const found = [];
  const look = (folder, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.name.endsWith('.app')) found.push({ name: entry.name.slice(0, -4), path: full });
      else if (depth > 0 && entry.isDirectory()) look(full, depth - 1);
    }
  };
  for (const folder of folders) look(folder, 1);
  if (folders === MAC_FOLDERS) for (const app of MAC_EXTRA) if (fs.existsSync(app)) found.push({ name: path.basename(app, '.app'), path: app });
  return found;
}

/**
 * One entry per app, under every name it goes by: its file's ("Visual Studio
 * Code") and the one it runs under ("Code").
 * @param {{name:string, path:string}[]} installed
 * @param {{name:string, pid:number, path?:string, active?:boolean}[]} running  from jester-driver
 * @returns {{names:string[], path:string|null, pid?:number, running:boolean, active?:boolean}[]}
 */
export function appCatalog(installed = [], running = []) {
  const byPath = new Map();
  const entries = [];
  for (const app of installed) {
    if (byPath.has(app.path)) continue;
    const entry = { names: [app.name], path: app.path, running: false };
    byPath.set(app.path, entry);
    entries.push(entry);
  }
  for (const app of running) {
    if (!app?.name) continue;
    const entry = app.path ? byPath.get(app.path) : null;
    const state = { pid: app.pid, running: true, active: !!app.active };
    if (!entry) entries.push({ names: [app.name], path: app.path || null, ...state });
    else {
      if (!entry.names.includes(app.name)) entry.names.push(app.name);
      Object.assign(entry, state);
    }
  }
  return entries;
}

/** The app a matched name belongs to, a running one first. */
export function findApp(catalog, name) {
  const matches = catalog.filter((entry) => entry.names.includes(name));
  return matches.find((entry) => entry.running) || matches[0] || null;
}
