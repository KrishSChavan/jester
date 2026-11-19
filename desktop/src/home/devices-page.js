/**
 * Settings › Devices, on his website (the user, 2026-11-18: "Jester should know where he is open and if he is not and
 * what he is being used for", and the phone as "a remote"): every device of the user's he's been opened on, whether
 * he's open there now and on what, and for a computer running Jester its own switches, thrown from here. And this
 * device's notifications, from his own app (main/push.js), which took ntfy's place.
 */

const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message).catch(() => null);

const SCREENS = { main: 'talking with him', chats: 'in Chats', chat: 'reading a chat', tasks: 'on Tasks', controls: 'on Controls', setup: 'on Getting started' };

function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** A device's state in a line: "Open, in front, talking with him", "Not open · last open 2 hours ago". */
export function deviceLine(device, now = Date.now()) {
  if (!device.open) return `Not open · last open ${ago(now - device.lastAt)}`;
  const parts = [];
  const computer = device.computer;
  if (computer) {
    parts.push('Connected: Jester’s hands');
    if (computer.running) parts.push(computer.doing ? `working on “${computer.doing}”` : 'working on a task');
    if (computer.asking) parts.push('waiting on a yes or no');
    if (computer.engine === 'sleeping') parts.push('asleep');
    if (Number.isFinite(computer.idleSeconds)) parts.push(computer.idleSeconds < 90 ? 'in use now' : `last touched ${ago(computer.idleSeconds * 1000)}`);
  } else {
    const screen = SCREENS[device.screen] || (String(device.screen).startsWith('settings') ? 'in Settings' : '');
    parts.push(device.front ? `Open, in front${screen ? `, ${screen}` : ''}` : 'Open, behind something else');
  }
  if (device.voice) parts.push('he hears and speaks here');
  return parts.join(' · ');
}

/** What this browser can do about notifications: '' if it can take them now, else why not, in words. */
export function pushProblem({ agent = navigator.userAgent, standalone = false, has = 'PushManager' in globalThis && 'serviceWorker' in navigator, permission = globalThis.Notification?.permission } = {}) {
  const ios = /\b(iPhone|iPad|iPod)\b/.test(agent) || (/\bMacintosh\b/.test(agent) && (navigator.maxTouchPoints || 0) > 1);
  if (/\bElectron\//.test(agent)) return 'On this Mac, Jester speaks and shows what he has to tell you himself.';
  if (ios && !standalone) return 'On an iPhone or iPad, notifications come to Jester on your Home Screen: add him there (Share › Add to Home Screen), open him from it, and turn them on here.';
  if (!has) return 'This browser can’t take notifications from a website.';
  if (permission === 'denied') return 'Notifications are turned off for Jester in this device’s settings. Allow them there, then turn them on here.';
  return '';
}

const keyBytes = (key) => Uint8Array.from(atob(String(key).replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (name === 'text') node.textContent = value;
    else if (name === 'class') node.className = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  node.append(...children.flat().filter(Boolean));
  return node;
}

export function createDevicesPage({ onChange = () => undefined } = {}) {
  let devices = [];
  let here = '';
  let pushOn = false;
  let note = '';
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  /** The computer whose switches the hand and the moon on his screen throw: this one, if it's one, else the one in use. */
  const computer = () => devices.find((device) => device.here && device.computer) || devices.find((device) => device.computer) || null;
  const throwSwitch = async (device, change) => {
    const reply = await ask({ type: 'jester/computer', device, change });
    if (reply?.ok === false && reply.why) note = reply.why;
    return load();
  };

  async function setPush(on) {
    note = '';
    try {
      const registration = await navigator.serviceWorker.ready;
      if (!on) {
        await (await registration.pushManager.getSubscription())?.unsubscribe();
        await ask({ type: 'jester/push', op: 'unsubscribe' });
      } else {
        // Asked for as the button's pressed: a browser only asks the user then.
        if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications weren’t allowed.');
        const { key } = (await ask({ type: 'jester/push', op: 'state' })) || {};
        if (!key) throw new Error('Jester’s server isn’t ready to send them yet.');
        const subscription = (await registration.pushManager.getSubscription()) || (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
        const reply = await ask({ type: 'jester/push', op: 'subscribe', subscription: subscription.toJSON() });
        if (!reply?.ok) throw new Error(reply?.error || 'Jester’s server didn’t take it.');
      }
    } catch (err) {
      note = err?.message || 'That didn’t work.';
    }
    return load();
  }

  function draw() {
    const list = $('devices-list');
    if (!list) return;
    const mine = devices.find((device) => device.here);
    const problem = pushProblem({ standalone: standalone() });
    $('push-hint').textContent = problem || (pushOn ? 'On: what he has to tell you while you’re away from your devices, a task finishing, or a yes-or-no he needs, comes here. A line that looks like a password is never sent.' : 'What he has to tell you while you’re away from your devices (a reminder, a timer, a word before class), a task finishing, or a yes-or-no he needs, can come to this device as a notification.');
    $('push-note').textContent = note;
    $('push-on').hidden = !!problem || pushOn;
    $('push-off').hidden = !pushOn;
    $('push-test').hidden = !pushOn;
    $('device-name').value = document.activeElement === $('device-name') ? $('device-name').value : mine?.name || '';
    $('device-name').disabled = !mine;
    list.replaceChildren(
      ...devices.map((device) => {
        const row = el('div', { class: 'row device' },
          el('span', {}, el('strong', { text: `${device.name}${device.here ? ' (this one)' : ''}` }), el('small', { text: `${deviceLine(device)}${device.notifies ? ' · takes notifications' : ''}` })));
        const buttons = el('span', { class: 'buttons' });
        const switches = device.computer?.switches;
        if (device.computer && device.open) {
          const asleep = device.computer.engine === 'sleeping';
          buttons.append(
            el('button', { type: 'button', text: asleep ? 'Wake' : 'Sleep', title: asleep ? 'Wake Jester on it' : 'Camera and mic off on it until he’s woken', onclick: () => throwSwitch(device.id, { sleep: !asleep }) }),
            el('button', { type: 'button', text: switches?.gestures === false ? 'Gestures on' : 'Gestures off', onclick: () => throwSwitch(device.id, { gestures: switches?.gestures === false }) }),
            device.computer.running ? el('button', { type: 'button', text: 'Stop its task', onclick: () => throwSwitch(device.id, { stop: true }) }) : null
          );
        }
        if (!device.open) buttons.append(el('button', { type: 'button', text: 'Forget', title: 'Take it off this list', onclick: async () => (await ask({ type: 'jester/devices', op: 'forget', id: device.id }), load()) }));
        if (buttons.childElementCount) row.append(buttons);
        return row;
      })
    );
    $('devices-none').hidden = devices.length > 0;
    const open = devices.filter((device) => device.open).length;
    if ($('sum-devices')) $('sum-devices').textContent = devices.length ? `${open} open` : '';
  }

  async function load() {
    const [reply, push] = await Promise.all([ask({ type: 'jester/devices', op: 'list' }), ask({ type: 'jester/push', op: 'state' })]);
    if (reply?.ok) {
      devices = reply.devices || [];
      here = reply.here || '';
    }
    pushOn = !!push?.on;
    draw();
    onChange();
  }

  $('push-on')?.addEventListener('click', () => setPush(true));
  $('push-off')?.addEventListener('click', () => setPush(false));
  $('push-test')?.addEventListener('click', async () => {
    const reply = await ask({ type: 'jester/push', op: 'test' });
    note = reply?.ok ? 'Sent. It shows when Jester isn’t in front, so close him or lock the screen to see it.' : reply?.error || 'It didn’t go.';
    draw();
  });
  // The password that signs a new device in (main/web-login.js): set here, on a device that's signed in.
  let login = { set: false };
  const drawLogin = (note = '') => {
    if (!$('login-hint')) return;
    $('login-hint').textContent = login.set
      ? 'A password is set: a new device signs in with it, and the key link still works. Changing it needs the current one.'
      : 'None yet: only your key link signs a device in. Set one to sign in from any browser. At least 10 characters; a few words together is easy to type and hard to guess.';
    $('login-current').hidden = !login.set;
    $('login-save').textContent = login.set ? 'Change password' : 'Set password';
    $('login-note').textContent = note;
  };
  ask({ type: 'jester/web-login', op: 'state' }).then((reply) => {
    if (reply) login = reply;
    drawLogin();
  });
  $('login-save')?.addEventListener('click', async () => {
    const reply = await ask({ type: 'jester/web-login', op: 'set', current: $('login-current').value, password: $('login-new').value });
    if (reply) login = reply;
    if (reply?.ok) $('login-current').value = $('login-new').value = '';
    drawLogin(reply?.ok ? 'Saved. A new device can sign in with it now.' : reply?.error || 'That didn’t save.');
  });
  $('device-name')?.addEventListener('change', async () => {
    const name = $('device-name').value.trim();
    if (name && here) await ask({ type: 'jester/devices', op: 'rename', id: here, name });
    load();
  });

  return { load, computer, throwSwitch, get devices() { return devices; } };
}
