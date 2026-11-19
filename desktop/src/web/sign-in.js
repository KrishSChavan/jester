// Signing in to his website (sign-in.html): the pasted link's key, or a sign-in link's code, taken to the server,
// which keeps it as a cookie and opens him.

const $ = (id) => document.getElementById(id);

/** The address to sign in at, from what was pasted: his link (?key=), a sign-in link (?install=), or the key alone. */
export function signInAddress(text) {
  const said = String(text || '').trim();
  try {
    const url = new URL(said);
    const key = url.searchParams.get('key');
    if (key) return `/?key=${encodeURIComponent(key)}`;
    const code = url.searchParams.get('install');
    if (code) return `/?install=${encodeURIComponent(code)}`;
  } catch {
    // Not a link: the key on its own, perhaps.
  }
  return /^[A-Za-z0-9_-]{16,128}$/.test(said) ? `/?key=${encodeURIComponent(said)}` : '';
}

// The page itself: not when a test imports this for signInAddress.
if (globalThis.document) {
  // Turned away with one in the address: it wasn't this Jester's, or it's run out. The address loses it.
  const asked = new URLSearchParams(location.search);
  if (asked.has('key')) $('error').textContent = 'That link’s key isn’t this Jester’s. Paste the newest one.';
  else if (asked.has('install')) $('error').textContent = 'That sign-in link has run out. Paste your Jester link instead.';
  if (asked.has('key') || asked.has('install')) history.replaceState(null, '', '/');

  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  $('app-note').hidden = !standalone;

  $('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const address = signInAddress($('link').value);
    if (!address) {
      $('error').textContent = 'That isn’t a Jester link: it ends in ?key= and a long code.';
      return;
    }
    location.href = address;
  });

  // With a password set, that's what's asked for: the link is the other way in.
  const showLink = (on) => {
    $('password-form').hidden = on;
    $('form').hidden = !on;
    $('link-intro').hidden = !on;
  };
  fetch('/sign-in.json')
    .then((response) => response.json())
    .then((state) => {
      // Sent here by a link that didn't work: the link's box stays, with why.
      if (state?.password && !$('error').textContent) {
        showLink(false);
        $('password').focus();
      }
    })
    .catch(() => undefined);
  $('use-link').addEventListener('click', () => showLink(true));
  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('password-form').querySelector('button[type="submit"]');
    button.disabled = true;
    $('password-error').textContent = '';
    try {
      const response = await fetch('/sign-in', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
      const reply = await response.json().catch(() => ({}));
      if (reply.ok) return void (location.href = '/');
      $('password-error').textContent = reply.error || 'That didn’t work.';
      $('password').select();
    } catch {
      $('password-error').textContent = 'Jester couldn’t be reached. Try again.';
    }
    button.disabled = false;
  });

  if (navigator.clipboard?.readText) {
    $('paste').hidden = false;
    $('paste').addEventListener('click', async () => {
      try {
        $('link').value = (await navigator.clipboard.readText()).trim();
        $('form').requestSubmit();
      } catch {
        $('error').textContent = 'Couldn’t read what’s copied: paste it into the box instead.';
      }
    });
  }
}
