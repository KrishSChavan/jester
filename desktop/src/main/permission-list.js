/**
 * What Jester needs from the operating system, and where each stands.
 *
 * Pure: the OS statuses come in (permissions.js reads them), checklist items
 * come out, so the wording and the rules can be tested without Electron.
 */

/**
 * `needed`: nothing works without it. `recommended`: a whole feature does.
 * `later`: only a feature that hasn't shipped yet.
 */
export const PERMISSIONS = {
  camera: {
    label: 'Camera',
    why: 'Sees your hands and face to read gestures and where you look. Frames never leave this computer.',
    tier: 'needed',
    platforms: ['darwin', 'win32']
  },
  accessibility: {
    label: 'Accessibility',
    why: 'Lets Jester move the cursor, click and type for you, and read what is under the cursor to aim.',
    tier: 'needed',
    platforms: ['darwin']
  },
  microphone: {
    label: 'Microphone',
    why: 'Hears voice commands, on this computer only, while a voice gesture or shortcut has the mic open.',
    tier: 'recommended',
    platforms: ['darwin', 'win32']
  },
  screen: {
    label: 'Screen Recording',
    why: 'Lets the voice assistant look at one window when the words on screen aren’t enough. Not used yet.',
    tier: 'later',
    platforms: ['darwin']
  }
};

/** What the button does for a status: ask (the OS shows its prompt) or send you to Settings. */
function action(id, status, platform) {
  if (status === 'granted') return null;
  // macOS prompts only for media it hasn't asked about; Accessibility's
  // prompt adds Jester to the list and points at Settings, every time.
  if (platform === 'darwin' && (id === 'camera' || id === 'microphone') && status === 'not-determined') return 'request';
  if (platform === 'darwin' && id === 'accessibility') return 'request';
  return 'open-settings';
}

/**
 * @param {string} platform  process.platform
 * @param {Record<string, string>} statuses  'granted' | 'not-determined' | 'denied' | 'restricted' | 'unknown'
 */
export function permissionItems(platform, statuses) {
  return Object.entries(PERMISSIONS)
    .filter(([, permission]) => permission.platforms.includes(platform))
    .map(([id, permission]) => {
      const status = statuses?.[id] || 'unknown';
      return { id, ...permission, status, granted: status === 'granted', action: action(id, status, platform) };
    });
}

/** The `needed` ones still missing: while any are, Settings opens by itself. */
export function missingNeeded(items) {
  return items.filter((item) => item.tier === 'needed' && !item.granted);
}
