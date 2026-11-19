/**
 * What Jester needs from the operating system, and where each stands.
 *
 * Pure: the OS statuses come in (permissions.js reads them), checklist items
 * come out, so the wording and the rules can be tested without Electron.
 */

/**
 * `needed`: nothing works without it. `recommended`: a whole feature does.
 * `optional`: a fallback that everything works without.
 *
 * `cant`: what he can't do without it, as he'd say it ("I can't hear you"). `whenKnown`: listed only once it's in
 * use and its status is known (Location, once Settings says to use this computer's; Bluetooth, with the watch on;
 * a folder, when a vault's been chosen that macOS won't let him into).
 *
 * None is asked for up front. Each is asked for when what needs it is first turned on or used (main.js `need`),
 * and one he's asked to use and hasn't got is said, with where it's allowed (`refusal`).
 */
export const PERMISSIONS = {
  camera: {
    label: 'Camera',
    why: 'Sees your hands and face to read gestures and where you look. Frames never leave this computer.',
    tier: 'needed',
    platforms: ['darwin', 'win32'],
    cant: 'see your hands',
    thing: 'the camera'
  },
  accessibility: {
    label: 'Accessibility',
    why: 'Lets Jester move the cursor, click and type for you, and read what is under the cursor to aim.',
    tier: 'needed',
    platforms: ['darwin'],
    cant: 'click, type or read what’s on the screen'
  },
  microphone: {
    label: 'Microphone',
    why: 'Hears voice commands, on this computer only, while a voice gesture or shortcut has the mic open.',
    tier: 'recommended',
    platforms: ['darwin', 'win32'],
    cant: 'hear you',
    thing: 'the microphone'
  },
  screen: {
    label: 'Screen Recording',
    why: 'Lets the voice assistant send a model that reads pictures one of the window it’s working in, when the window’s words aren’t enough. Up to three a task, never with a password field showing.',
    tier: 'optional',
    platforms: ['darwin'],
    cant: 'look at a picture of the window'
  },
  location: {
    label: 'Location',
    why: 'Where this computer is, for the weather and what’s near you. Used only while Location is set to this computer, in Settings › Weather and calendars.',
    tier: 'optional',
    platforms: ['darwin', 'win32'],
    whenKnown: true,
    cant: 'tell where you are',
    thing: 'this computer’s location'
  },
  bluetooth: {
    label: 'Bluetooth',
    why: 'How your Apple Watch reaches this Mac, to move the pointer.',
    tier: 'optional',
    platforms: ['darwin'],
    whenKnown: true,
    cant: 'reach your Apple Watch'
  },
  files: {
    label: 'Files and Folders',
    why: 'The folder your Obsidian vault is in, so he can read your notes and keep what he remembers there.',
    tier: 'optional',
    platforms: ['darwin'],
    whenKnown: true,
    cant: 'open the folder your vault is in'
  }
};

/** The pane of System Settings each is allowed in, as its title there reads. */
const MAC_PANES = {
  camera: 'Camera',
  microphone: 'Microphone',
  accessibility: 'Accessibility',
  screen: 'Screen Recording',
  location: 'Location Services',
  bluetooth: 'Bluetooth',
  files: 'Files and Folders',
  automation: 'Automation'
};
const WINDOWS_PANES = { camera: 'Camera', microphone: 'Microphone', location: 'Location' };

/**
 * Where a permission is allowed, as a path someone can follow: "System Settings › Privacy & Security › Camera".
 * '' where the OS has no switch for it.
 * @param {string} id
 * @param {string} [platform]
 * @param {{macMajor?:number}} [options]  macMajor: macOS's version (15 is Sequoia), which renamed Screen Recording
 */
export function allowedIn(id, platform = process.platform, { macMajor = 15 } = {}) {
  if (platform === 'darwin') {
    const pane = id === 'screen' && macMajor >= 15 ? 'Screen & System Audio Recording' : MAC_PANES[id];
    return pane ? `System Settings › Privacy & Security › ${pane}` : '';
  }
  if (platform === 'win32') return WINDOWS_PANES[id] ? `Windows Settings › Privacy & security › ${WINDOWS_PANES[id]}` : '';
  return '';
}

/** Those macOS asks about with a plain Allow / Don't Allow; the others it sends to System Settings to switch on. */
const PLAIN_ASK = new Set(['camera', 'microphone', 'location', 'bluetooth', 'files']);

/**
 * What's said when something asked of him needs a permission he hasn't got: what he can't do, that the OS hasn't
 * allowed it, and where it's allowed (the user, 2026-11-19: "have him say so and point the person to where in
 * settings"). `say` is his, aloud or written; `note` is the same for a toast or a line in Settings.
 * @param {string} id
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {boolean} [options.asking]  the OS's own question has just been put up: the answer is there, not in Settings
 * @param {string} [options.listedAs]  the name the OS lists him under, when it isn't Jester (listedAsFor)
 * @param {number} [options.macMajor]
 * @returns {{say:string, note:string, where:string}}
 */
export function refusal(id, { platform = process.platform, asking = false, listedAs = '', macMajor = 15 } = {}) {
  const cant = PERMISSIONS[id]?.cant || 'do that';
  const where = allowedIn(id, platform, { macMajor });
  const name = listedAs || 'Jester';
  if (platform === 'darwin') {
    // Only where macOS puts a plain question: for Accessibility and the screen it's a switch in System Settings, and
    // whether its own dialog comes up as well isn't something he can know.
    if (asking && PLAIN_ASK.has(id)) {
      const thing = PERMISSIONS[id]?.thing || 'it';
      return { where, say: `I can’t ${cant} until macOS allows it, and it’s asking you now: choose Allow.`, note: `macOS is asking whether ${name} may use ${thing}: choose Allow.` };
    }
    return { where, say: `I can’t ${cant}: macOS hasn’t allowed it. Switch ${name} on in ${where}, then ask me again.`, note: `Jester can’t ${cant}: switch ${name} on in ${where}.` };
  }
  if (platform === 'win32' && where) {
    return { where, say: `I can’t ${cant}: Windows hasn’t allowed it. In ${where}, let desktop apps use it, then ask me again.`, note: `Jester can’t ${cant}: in ${where}, let desktop apps use it.` };
  }
  return { where, say: `I can’t ${cant}: this computer hasn’t allowed it.`, note: `Jester can’t ${cant}: this computer hasn’t allowed it.` };
}

/** What the button does for a status: ask (the OS shows its prompt) or send you to Settings. */
function action(id, status, platform) {
  if (status === 'granted') return null;
  // macOS prompts only for media it hasn't asked about (Screen Recording's
  // prompt also puts Jester in its list); Accessibility's prompt adds Jester
  // to the list and points at Settings, every time.
  if (platform === 'darwin' && ['camera', 'microphone', 'screen', 'location'].includes(id) && status === 'not-determined') return 'request';
  if (platform === 'darwin' && id === 'accessibility') return 'request';
  return 'open-settings';
}

/**
 * The name System Settings lists this app under, when it isn't "Jester": on a Mac, the app bundle the
 * executable is in. Run from source it's Jester.app (scripts/jester-app.mjs), but `npx electron .` runs npm's
 * own Electron.app, which macOS lists as "Electron". '' when it's Jester, or not a Mac.
 * @param {string} execPath  process.execPath
 * @param {string} platform  process.platform
 */
export function listedAsFor(execPath, platform) {
  if (platform !== 'darwin') return '';
  const bundle = /([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''))?.[1] || '';
  return bundle && bundle !== 'Jester' ? bundle : '';
}

/**
 * @param {string} platform  process.platform
 * @param {Record<string, string>} statuses  'granted' | 'not-determined' | 'denied' | 'restricted' | 'unknown'
 * @param {{listedAs?:string}} [options]  listedAs: the name System Settings shows for Jester, when it isn't
 *   "Jester" (listedAsFor)
 */
export function permissionItems(platform, statuses, { listedAs = '' } = {}) {
  return Object.entries(PERMISSIONS)
    .filter(([id, permission]) => permission.platforms.includes(platform) && (!permission.whenKnown || !!statuses?.[id]))
    .map(([id, { cant, thing, whenKnown, ...permission }]) => {
      const status = statuses?.[id] || 'unknown';
      return { id, ...permission, status, granted: status === 'granted', action: action(id, status, platform), where: allowedIn(id, platform), ...(listedAs ? { listedAs } : {}) };
    });
}

/** The `needed` ones still missing, whatever's switched off. */
export function missingNeeded(items) {
  return items.filter((item) => item.tier === 'needed' && !item.granted);
}

/**
 * What he can't do without as he's set up, and hasn't got: while any are, his window says so. The `needed` ones,
 * but not the camera for someone with gestures off; and the microphone for someone who talks to him, whatever tier
 * the list gives it.
 * @param {{id:string, tier:string, granted:boolean}[]} items
 * @param {{gesturesEnabled?:boolean, voiceEnabled?:boolean}} [settings]
 */
export function missingFor(items, settings) {
  return items.filter((item) => {
    if (item.granted) return false;
    if (item.id === 'camera') return item.tier === 'needed' && settings?.gesturesEnabled !== false;
    if (item.id === 'microphone') return settings?.voiceEnabled !== false;
    return item.tier === 'needed';
  });
}
