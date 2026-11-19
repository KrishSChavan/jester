/**
 * Settings' card for his website as an app (the user, 2026-11-18: "make the website so that I can download it as a
 * PWA especially on my phone"), on his website only (web/shim.js sets jesterWeb; never in his own window, an app
 * already): how to put him on the Home Screen in the browser it's in; Install, where the browser has a button for it;
 * and a sign-in link to copy, for another device, or for his website on a Home Screen that asks (it keeps its own
 * sign-in, apart from the browser's). The link's code works for a day (main/web-gateway.js), and is never the key.
 */

const $ = (id) => document.getElementById(id);

/** What the card says, for a browser: [title, steps]. */
export function installWords({ agent = '', standalone = false, prompt = false, touch = 0 } = {}) {
  const ios = /\b(iPhone|iPad|iPod)\b/.test(agent) || (/\bMacintosh\b/.test(agent) && touch > 1);
  if (standalone) return ['Jester’s on your Home Screen', 'To sign in on another device, copy a sign-in link and open it there within a day.'];
  if (prompt) return ['Install Jester', 'He opens in a window of his own, with his own icon, from your Home Screen or your apps.'];
  if (ios) return ['Put Jester on your Home Screen', 'Tap Share, then Add to Home Screen. He opens full screen, like an app, and signs himself in the first time.'];
  if (/\bAndroid\b/.test(agent)) return ['Put Jester on your Home Screen', 'In your browser’s ⋮ menu, tap Add to Home screen, or Install app.'];
  if (/\bMacintosh\b/.test(agent) && /\bVersion\/\d+(\.\d+)* Safari\//.test(agent)) return ['Put Jester in your Dock', 'In Safari’s File menu, choose Add to Dock: he opens in a window of his own.'];
  return ['Install Jester', 'If your browser’s menu has Install or Add to Home Screen, he opens from there like an app.'];
}

export function startInstall() {
  const web = globalThis.jesterWeb;
  const card = $('install-card');
  if (!web || !card || /\bElectron\//.test(navigator.userAgent)) return;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function draw() {
    const [title, steps] = installWords({ agent: navigator.userAgent, standalone, prompt: !!web.installPrompt, touch: navigator.maxTouchPoints || 0 });
    $('install-title').textContent = title;
    $('install-steps').textContent = steps;
    $('install-now').hidden = standalone || !web.installPrompt;
    card.hidden = false;
  }

  $('install-now').addEventListener('click', async () => {
    const prompt = web.installPrompt;
    if (!prompt) return;
    web.installPrompt = null;
    await prompt.prompt();
    draw();
  });

  // The code is asked for as the button's pressed: Safari only lets a page copy while it's handling the press, so
  // what's copied is promised then, and filled in when the server answers.
  $('install-link').addEventListener('click', async () => {
    const button = $('install-link');
    const link = chrome.runtime.sendMessage({ type: 'jester/web-link' }).then((reply) => {
      if (!reply?.ok || !reply.code) throw new Error('no code');
      return `${location.origin}/?install=${encodeURIComponent(reply.code)}`;
    });
    try {
      if (globalThis.ClipboardItem && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': link.then((text) => new Blob([text], { type: 'text/plain' })) })]);
      } else {
        await navigator.clipboard.writeText(await link);
      }
      button.textContent = 'Copied: open it on the other device within a day';
    } catch {
      // Not copied: shown, to copy by hand.
      const text = await link.catch(() => '');
      $('install-steps').textContent = text ? `Copy this, and open it on the other device within a day: ${text}` : 'Jester couldn’t make a sign-in link just now.';
    }
    setTimeout(() => (button.textContent = 'Copy a sign-in link'), 4000);
  });

  addEventListener('jester-installable', draw);
  draw();
}
