/**
 * Where the user is, on a server (main.js JESTER_SERVER): where the device they're using is (the user, 2026-11-18:
 * "make it so the website takes the location of the computer accessing it and send it to the server").
 *
 * A server can't tell where anyone is, so whereabouts.js's `locate` asks the device being used: the browser he's
 * talked through (the one last clicked or typed in: web-gateway.js voiceClient), else the page last heard from. A
 * browser answers from its own location (web/shim.js, the Geolocation API, once the user allows it for the site); the
 * Mac's own window, which is his website in Electron (no location of its own there), is answered by the Mac, from
 * Location Services (remote-hands.js `where`, mac-location.js), as the Mac's Jester does for itself.
 *
 * Which device a position came from is kept with it (`key`): another device being used is somewhere else, so its
 * position is asked for then, not after the usual 15 minutes (whereabouts.js `device`).
 */

/** A message from his worker, as a page's listener expects one. */
const SENDER = Object.freeze({ id: 'jester-desktop', url: 'jester://ext/_desktop/worker' });

/** "your iPhone": the device a browser's on, as he'd say it. */
export function deviceName(agent = '') {
  const said = String(agent);
  if (/\biPhone\b/.test(said)) return 'your iPhone';
  if (/\biPad\b/.test(said)) return 'your iPad';
  if (/\bAndroid\b/.test(said)) return /\bMobile\b/.test(said) ? 'your Android phone' : 'your Android tablet';
  if (/\bMacintosh\b/.test(said)) return 'a browser on a Mac';
  if (/\bWindows\b/.test(said)) return 'a browser on Windows';
  if (/\bCrOS\b/.test(said)) return 'your Chromebook';
  return 'your browser';
}

/** A browser's answer, as whereabouts.js takes one: a position on Earth, or why there isn't one. */
export function positionFrom(answer, client) {
  const lat = Number(answer?.lat);
  const lon = Number(answer?.lon);
  if (answer?.ok === true && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    return { ok: true, lat, lon, accuracy: Math.max(0, Number(answer.accuracy) || 0), device: deviceName(client?.agent), key: `page-${client?.id}` };
  }
  return { ok: false, code: [1, 2, 3].includes(answer?.code) ? answer.code : 2, message: String(answer?.message || '').slice(0, 200) };
}

/**
 * @param {object} deps
 * @param {{voiceClient:object|null, clients:object[]}} deps.gateway  web-gateway.js's
 * @param {{where:(timeoutMs:number) => Promise<object>}} deps.hands  remote-hands.js's: the Mac's own position
 */
export function createDeviceLocate({ gateway, hands, log = () => undefined }) {
  /** Asks a browser hasn't answered yet: id → { resolve, timer, client }. */
  const waiting = new Map();
  let nextId = 0;

  /** The device being used: the one talked through, else the page last heard from. */
  function current() {
    const voice = gateway.voiceClient;
    if (voice) return voice;
    return gateway.clients.filter((client) => client.role === 'page').sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0))[0] || null;
  }

  /** The Mac answers for itself, and for its own window: his website in Electron, which has no location there. */
  const isMac = (client) => client.role === 'mac' || client.macWindow === true;

  return {
    /** Which device a position would come from now: whereabouts.js asks again when it isn't the last one's. */
    device() {
      const client = current();
      return client ? (isMac(client) ? 'mac' : `page-${client.id}`) : '';
    },

    /** whereabouts.js's `locate`: the device being used, asked where it is. */
    async locate({ timeoutMs = 25000 } = {}) {
      const client = current();
      if (!client) return { ok: false, code: 2, message: 'No device is using Jester just now.' };
      if (isMac(client)) {
        const got = await hands.where(timeoutMs);
        return got?.ok ? { ...got, device: 'your Mac', key: 'mac' } : { ok: false, code: got?.code || 2, message: got?.message || '' };
      }
      const id = `where-${++nextId}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          log('location: the device didn’t say in time');
          resolve({ ok: false, code: 3, message: '' });
        }, timeoutMs);
        timer.unref?.();
        waiting.set(id, { resolve, timer, client });
        // Its browser asks the user, the first time, whether the site may know: a little less than the wait, so a
        // late answer is still its own.
        client.message({ type: 'jester/where-ask', id, timeoutMs: Math.max(3000, timeoutMs - 2000) }, SENDER);
      });
    },

    /** A browser's answer (web/shim.js): only the page that was asked answers its own question. */
    told(client, answer) {
      const id = String(answer?.id ?? '');
      const entry = waiting.get(id);
      if (!entry || entry.client !== client) return false;
      waiting.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(positionFrom(answer, client));
      return true;
    },

    /** A page went: what it was asked is answered for it, as nothing. */
    gone(client) {
      for (const [id, entry] of waiting) {
        if (entry.client !== client) continue;
        waiting.delete(id);
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, code: 2, message: '' });
      }
    }
  };
}
