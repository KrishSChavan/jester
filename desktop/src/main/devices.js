/**
 * Where he's open, on a server (main.js JESTER_SERVER): the user's devices (the user, 2026-11-18: "Jester should know
 * where he is open and if he is not and what he is being used for").
 *
 * A device is a browser or his Home Screen app, known by an id it keeps for itself (web/shim.js), or one of the
 * user's computers running Jester (cloud-link.js), known by its own. A computer's own window, which is his website
 * there, is that computer, not another device. Each is named from what it says it is ("iPhone", "Safari on a Mac",
 * "Krish’s MacBook Pro"), until the user names it. Those ever seen are kept, so one he isn't open on now can be said
 * to be closed, and since when.
 *
 * What's known of each: whether he's open there, whether its page is in front, which of his screens it shows, when
 * it was last used, and for a computer what its hands are doing (remote-hands.js). It's told to him with the user's
 * words (`lines`), shown in Settings (`list`), and decides where a chat lives (main.js: a chat per device).
 */

import crypto from 'node:crypto';

const KEPT = 24;
const NAME_CHARS = 40;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
/** A device not seen for this long is forgotten. */
const FORGET_MS = 60 * 24 * 60 * 60 * 1000;
const SCREENS = { main: 'talking with you', chats: 'looking through earlier chats', chat: 'reading an earlier chat', tasks: 'on the tasks list', controls: 'on Controls (their scripts)', setup: 'on Getting started' };

/** What a browser is, from what it says of itself: a name to call it by, and its kind. */
export function describeAgent(agent = '', { app = false } = {}) {
  const said = String(agent);
  const browser = /\bEdg\//.test(said) ? 'Edge' : /\bFirefox\//.test(said) ? 'Firefox' : /\bChrome\//.test(said) || /\bCriOS\//.test(said) ? 'Chrome' : /\bSafari\//.test(said) ? 'Safari' : 'a browser';
  const phone = /\biPhone\b/.test(said) ? 'iPhone' : /\biPad\b/.test(said) ? 'iPad' : /\bAndroid\b/.test(said) ? (/\bMobile\b/.test(said) ? 'Android phone' : 'Android tablet') : '';
  if (phone) return { name: app ? phone : `${phone} (${browser})`, kind: /phone/i.test(phone) ? 'phone' : 'tablet' };
  const system = /\bMacintosh\b/.test(said) ? 'a Mac' : /\bWindows\b/.test(said) ? 'Windows' : /\bCrOS\b/.test(said) ? 'a Chromebook' : /\bLinux\b/.test(said) ? 'Linux' : 'a computer';
  return { name: app ? `Jester app on ${system}` : `${browser} on ${system}`, kind: 'browser' };
}

/** "3 minutes ago", "2 hours ago", "yesterday", "5 days ago". */
export function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * @param {object} deps
 * @param {{get:Function, set:Function}} deps.storage   storage.local: the `devices` key
 * @param {() => object[]} deps.computers   the computers connected, as remote-hands.js lists them
 * @param {() => object|null} deps.voiceClient   the client he's being talked through (web-gateway.js)
 * @param {() => void} [deps.onChange]
 */
export function createDevices({ storage, computers = () => [], voiceClient = () => null, onChange = () => undefined, now = Date.now, log = () => undefined }) {
  /** Every device seen and still remembered: id → { id, name, kind, app, named, firstAt, lastAt }. */
  const known = new Map();
  /** The clients connected now. */
  const clients = new Set();
  let saving = null;

  function save() {
    clearTimeout(saving);
    saving = setTimeout(() => storage.set({ devices: [...known.values()] }).catch((err) => log('devices: couldn’t be kept:', err.message)), 500);
    saving.unref?.();
  }

  /** The computer a client is on, when it's one of them: by where it connects from, or the only one there is. */
  function hostOf(client) {
    const macs = [...clients].filter((other) => other.role === 'mac');
    return (client.from && macs.find((mac) => mac.from === client.from)) || (client.macWindow && macs.length === 1 ? macs[0] : null);
  }

  /** Which device a client is: a computer's own window is that computer. */
  function idOf(client) {
    if (!client) return '';
    if (client.role === 'mac') return String(client.device?.id || `mac-${client.id}`);
    if (client.macWindow) return idOf(hostOf(client)) || `window-${client.id}`;
    return ID.test(String(client.device?.id || '')) ? client.device.id : `page-${client.id}`;
  }

  function remember(client) {
    const id = idOf(client);
    // A window whose computer hasn't connected yet, or a page that kept no id: not worth keeping.
    if (!id || /^(window|page)-/.test(id)) return null;
    const at = now();
    const was = known.get(id);
    let fresh;
    if (client.role === 'mac') fresh = { name: String(client.device?.name || 'Mac').slice(0, NAME_CHARS), kind: 'computer', app: true };
    else if (client.macWindow) fresh = null;
    else {
      const described = describeAgent(client.agent, { app: client.device?.app === true });
      const host = hostOf(client);
      // A browser on a computer that runs Jester too: said to be on it.
      fresh = { name: (host && described.kind === 'browser' ? `${described.name.split(' on ')[0]} on ${known.get(idOf(host))?.name || 'your Mac'}` : described.name).slice(0, NAME_CHARS), kind: described.kind, app: client.device?.app === true };
    }
    if (!was && !fresh) return null;
    const next = was ? { ...was, ...(fresh && !was.named ? fresh : fresh ? { kind: fresh.kind, app: fresh.app } : {}), lastAt: at } : { id, ...fresh, named: false, firstAt: at, lastAt: at };
    known.set(id, next);
    if (known.size > KEPT) known.delete([...known.values()].sort((a, b) => a.lastAt - b.lastAt)[0].id);
    save();
    return next;
  }

  /** A device as it stands now. */
  function state(device, { viewer = '' } = {}) {
    const mine = [...clients].filter((client) => idOf(client) === device.id);
    const pages = mine.filter((client) => client.role !== 'mac');
    const front = pages.filter((client) => client.visible !== false);
    const page = front.sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0))[0] || pages[0] || null;
    const computer = computers().find((entry) => entry.id === device.id) || null;
    const usedAt = Math.max(0, ...mine.map((client) => client.activeAt || 0), computer && Number.isFinite(computer.idleSeconds) ? now() - computer.idleSeconds * 1000 : 0);
    return {
      id: device.id,
      name: device.name,
      kind: device.kind,
      app: !!device.app,
      // Connected at all; and with one of his pages there to be seen.
      open: mine.length > 0,
      front: front.length > 0,
      screen: page?.screen || '',
      usedAt,
      lastAt: mine.length ? now() : device.lastAt,
      here: !!viewer && viewer === device.id,
      voice: idOf(voiceClient()) === device.id,
      computer: computer && { running: computer.running, asking: computer.asking, doing: computer.doing, engine: computer.engine, switches: computer.switches, idleSeconds: computer.idleSeconds }
    };
  }

  const all = (options) => [...known.values()].map((device) => state(device, options)).sort((a, b) => Number(b.open) - Number(a.open) || b.usedAt - a.usedAt || b.lastAt - a.lastAt);

  return {
    async start() {
      const kept = (await storage.get('devices')).devices;
      for (const device of Array.isArray(kept) ? kept : []) {
        if (!device || typeof device.id !== 'string' || now() - (device.lastAt || 0) > FORGET_MS) continue;
        known.set(device.id, { id: device.id, name: String(device.name || 'A device').slice(0, NAME_CHARS), kind: ['phone', 'tablet', 'computer', 'browser'].includes(device.kind) ? device.kind : 'browser', app: device.app === true, named: device.named === true, firstAt: Number(device.firstAt) || 0, lastAt: Number(device.lastAt) || 0 });
      }
    },
    /** An id for a browser that has none yet. */
    newId: () => crypto.randomBytes(12).toString('base64url'),
    idOf,
    /** A client connected (and said what it is), or said so again. */
    join(client) {
      clients.add(client);
      // A computer that's just come: its own window, here before it, is it.
      for (const other of clients) remember(other);
      onChange();
    },
    leave(client) {
      if (!clients.delete(client)) return;
      const device = known.get(idOf(client));
      if (device) known.set(device.id, { ...device, lastAt: now() });
      save();
      onChange();
    },
    /** A client's page came to the front or went behind, or shows another of his screens. */
    seen(client, { visible, screen } = {}) {
      if (!clients.has(client)) return;
      const before = `${client.visible}|${client.screen}`;
      if (typeof visible === 'boolean') client.visible = visible;
      if (typeof screen === 'string') client.screen = screen.slice(0, 40);
      if (before !== `${client.visible}|${client.screen}`) onChange();
    },
    /** Every device, the ones he's open on first. `viewer`: the device asking, marked `here`. */
    list: all,
    get: (id) => (known.has(id) ? state(known.get(id)) : null),
    /** The clients of a device that are his pages, connected now. */
    pagesOf: (id) => [...clients].filter((client) => client.role !== 'mac' && idOf(client) === id),
    /** Whether any page of a device is in front: its user is looking at him there. */
    inFront: (id) => [...clients].some((client) => client.role !== 'mac' && client.visible !== false && idOf(client) === id),
    rename(id, name) {
      const device = known.get(id);
      const next = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_CHARS);
      if (!device || !next) return false;
      known.set(id, { ...device, name: next, named: true });
      save();
      onChange();
      return true;
    },
    /** A device he isn't open on, forgotten. */
    forget(id) {
      if ([...clients].some((client) => idOf(client) === id) || !known.delete(id)) return false;
      save();
      onChange();
      return true;
    },
    /**
     * For him, with the user's words: where he's open and what each is being used for, and where he isn't.
     * @param {string} from  the device these words came from
     */
    lines(from = '') {
      const devices = all();
      if (!devices.length) return '';
      const out = ['Where you are open on the user’s devices right now (you are one Jester on all of them; each has its own chat with you):'];
      for (const device of devices.slice(0, 8)) {
        const parts = [];
        if (device.id === from) parts.push('these words came from here');
        if (device.open) {
          const what = device.kind === 'computer' && !device.screen ? '' : SCREENS[device.screen] || (device.screen.startsWith('settings') ? 'in your Settings' : '');
          parts.push(device.front ? `open and in front${what ? `, ${what}` : ''}` : device.kind === 'computer' ? 'connected, your window there closed or behind' : 'open, behind something else');
          if (device.voice) parts.push('the one you hear and speak through');
          if (device.computer) {
            parts.push('your hands: it does what’s asked on a computer');
            if (device.computer.running) parts.push(`at work on a task${device.computer.doing ? ` (“${device.computer.doing}”)` : ''}`);
            if (device.computer.asking) parts.push('waiting on a yes or no');
            if (device.computer.engine === 'sleeping') parts.push('your gestures there asleep');
            if (Number.isFinite(device.computer.idleSeconds)) parts.push(device.computer.idleSeconds < 90 ? 'being used now' : `last touched ${ago(device.computer.idleSeconds * 1000)}`);
          } else if (device.usedAt) parts.push(`last used ${ago(now() - device.usedAt)}`);
        } else parts.push(`not open; last open ${ago(now() - device.lastAt)}`);
        out.push(`- ${device.name}${device.kind === 'computer' ? ' (a computer running Jester)' : device.app ? ' (your app on its Home Screen)' : ''}: ${parts.join('; ')}.`);
      }
      return out.join('\n');
    }
  };
}
