/**
 * Build flags, read from the `.env` file that sits beside manifest.json.
 *
 * Deliberately fetched at runtime rather than compiled into a module by the
 * build script: editing `.env` and hitting Reload on chrome://extensions is the
 * whole loop, with no generated module that can silently fall out of step with
 * the file you just edited.
 *
 * Two paths are tried, in order, because it is not settled whether Chrome will
 * serve a *dotfile* out of an extension folder — reports go both ways and it
 * can't be checked from here, since Chrome 137 dropped `--load-extension`:
 *
 *   .env      the file you edit. If Chrome serves it, edits land on Reload with
 *             no build step at all.
 *   env.txt   a byte-for-byte mirror that build-zip.ps1 keeps in step. Same
 *             format, same parser — it exists only so that a Chrome which
 *             refuses the dotfile still gets the flags.
 *
 * `source` says which one answered, and the options page shows it, so a stale
 * mirror is visible rather than silent.
 *
 * Every extension *page* reads this directly through `loadEnv()` — the service
 * worker, the offscreen document, the popup and the options page all can. The
 * content script can't (it isn't a module and doesn't share the extension
 * origin's module graph), so anything it needs arrives inside a message.
 */

/** First hit wins. @see the note above on why there are two. */
const ENV_PATHS = ['.env', 'env.txt'];

/** Used when `.env` is missing or unreadable — i.e. leave things as they are. */
const FALLBACK = { CURSOR: 'true', AI: '' };

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSY = new Set(['0', 'false', 'no', 'off', 'n', '']);

/**
 * What we can say about the AI key without talking to anyone. Provider-agnostic
 * on purpose: which service it belongs to isn't decided yet, so this only rules
 * out the values that cannot be a key under any of them.
 */
export const AI_KEY = {
  MISSING: 'missing',
  PLACEHOLDER: 'placeholder',
  MALFORMED: 'malformed',
  SHORT: 'short',
  OK: 'ok'
};

/** Values people leave behind after copying a template. */
const PLACEHOLDERS = [
  'your-api-key',
  'your_api_key',
  'yourapikey',
  'apikey',
  'api-key',
  'api_key',
  'changeme',
  'change-me',
  'replace-me',
  'todo',
  'tbd',
  'xxx',
  'none',
  'null',
  'undefined'
];

/** The shortest real key any major provider issues is comfortably past this. */
const MIN_KEY_LENGTH = 20;

/**
 * Parses the dotenv subset that actually turns up in one of these files:
 * `KEY=value`, blank lines, `#` comments, optional `export`, and quoted values.
 *
 * An unquoted value may carry a trailing comment; a quoted one may not, because
 * inside quotes a `#` is just a character — which matters for API keys.
 */
export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[key] = value;
  }
  return values;
}

/**
 * @returns the flag's value, or `fallback` when it's absent or unreadable — a
 *          typo must not quietly switch a feature off.
 */
export function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return fallback;
}

export function classifyAiKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key) return AI_KEY.MISSING;

  const bare = key.toLowerCase().replace(/[<>[\]{}'"]/g, '');
  if (PLACEHOLDERS.includes(bare) || /^(sk-)?(x{3,}|\.{3,})$/.test(bare)) {
    return AI_KEY.PLACEHOLDER;
  }
  // No key from any provider contains whitespace; one that does is a copy that
  // picked up a line break or a stray quote that survived parsing.
  if (/\s/.test(key) || /^["']|["']$/.test(key)) return AI_KEY.MALFORMED;
  if (key.length < MIN_KEY_LENGTH) return AI_KEY.SHORT;
  return AI_KEY.OK;
}

/** One sentence, written for whoever has to fix it. */
export function describeAiKey(state) {
  switch (state) {
    case AI_KEY.MISSING:
      return 'No AI key set. Add one as AI= in the extension’s .env file.';
    case AI_KEY.PLACEHOLDER:
      return 'The AI key in .env is still the placeholder from the template.';
    case AI_KEY.MALFORMED:
      return 'The AI key in .env has spaces or stray quotes in it — it looks like a bad paste.';
    case AI_KEY.SHORT:
      return `The AI key in .env is too short to be a real key (under ${MIN_KEY_LENGTH} characters).`;
    default:
      return 'AI key found.';
  }
}

/** True for everything the user needs telling about. */
export const aiKeyIsUsable = (state) => state === AI_KEY.OK;

function build(values, source, error) {
  const state = classifyAiKey(values.AI);
  return {
    ok: !error,
    /** Why no flag file could be read, or `''`. Flags fall back when this is set. */
    error: error || '',
    /** Which file answered — `.env`, `env.txt`, or `''` when neither did. */
    source,
    /** True when the flags came from the mirror, so `.env` edits may not be live. */
    mirrored: source === 'env.txt',
    cursor: parseBoolean(values.CURSOR, true),
    aiKey: String(values.AI ?? '').trim(),
    aiState: state,
    aiOk: aiKeyIsUsable(state),
    aiMessage: describeAiKey(state),
    values
  };
}

let pending = null;

/**
 * Reads and caches the flags. Cached for the lifetime of the context that calls
 * it, which is the right granularity: a service worker restart or an extension
 * reload re-reads, and nothing else should see the file change underneath it.
 */
export function loadEnv() {
  if (!pending) {
    pending = (async () => {
      const failures = [];
      for (const path of ENV_PATHS) {
        try {
          const response = await fetch(chrome.runtime.getURL(path));
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return build(parseEnv(await response.text()), path, '');
        } catch (err) {
          failures.push(`${path}: ${err?.message || err}`);
        }
      }
      return build(
        { ...FALLBACK },
        '',
        `Could not read the flag file from the extension folder (${failures.join('; ')}). ` +
          'Falling back to CURSOR=true with no AI key.'
      );
    })();
  }
  return pending;
}

/** Drops the cache, so the next `loadEnv()` re-reads the file. */
export function forgetEnv() {
  pending = null;
}
