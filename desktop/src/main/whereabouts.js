/**
 * Where the user is. Either this computer's own location: on a Mac, Location
 * Services (Wi-Fi positioning, to tens of metres), which Jester asks himself
 * (mac-location.js), elsewhere Chromium's, for a page of his (main.js
 * locateByPage); or a place they
 * named in Settings, for a computer that can't tell or a user who'd rather not;
 * or nowhere, which is how it starts, so macOS's question comes only when they
 * choose it.
 *
 * A position is asked for when Jester's talked to and the last is more than 15
 * minutes old, and once the computer wakes or unlocks: never on a timer, so
 * Location Services rests while he does. The turn that asked uses the last one
 * meanwhile, unless it's about where they are ("where am I?", "anything good near
 * me?"), which waits a moment for a new one.
 *
 * A position is put into words (street, town, region) by OpenStreetMap's
 * Nominatim, once it's moved more than 150 m from the last one named: its rules
 * ask for no more than a request a second, and a name for the app.
 */

const REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const AGENT = 'Jester-Desktop/0.1 (+https://github.com/KrishSChavan/jester)';
/** A position older than this is asked for again, when he's talked to. */
export const STALE_MS = 15 * 60 * 1000;
/** Asked where they are, one older than this is waited for. */
const FRESH_MS = 2 * 60 * 1000;
/** A position from Settings may wait for macOS's question to be answered. */
const PATIENT_MS = 90 * 1000;
const QUICK_MS = 25 * 1000;
/** After a position that couldn't be had, the next try is this far off (unless Settings asks). */
const RETRY_MS = 2 * 60 * 1000;
/** Moved less than this, and the last name still holds. */
const RENAME_M = 150;
const NAMING_GAP_MS = 60 * 1000;
const ASK_MS = 8000;

/** Metres between two points, near enough. */
export function distance(a, b) {
  const rad = Math.PI / 180;
  const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
}

/** Nominatim's answer, as the parts of a place. */
export function placeParts(data) {
  const a = data?.address || {};
  const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.suburb || a.county || '';
  const area = [a.neighbourhood, a.quarter, a.suburb].find((part) => part && part !== city) || '';
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const spot = typeof data?.name === 'string' && data.name && ![a.road, city, area].includes(data.name) ? data.name : '';
  return {
    city,
    area,
    street,
    spot,
    postcode: a.postcode || '',
    region: a.state || a.region || a.province || '',
    regionCode: String(a['ISO3166-2-lvl4'] || '').split('-')[1] || '',
    country: a.country || '',
    countryCode: String(a.country_code || '').toUpperCase()
  };
}

/** "State College, Pennsylvania"; "Paris, France". */
export const townOf = (place) => [place.city, place.countryCode === 'US' ? place.region : place.country].filter(Boolean).join(', ');

/** "Information Technology Services, Pattee Mall, State College, Pennsylvania 16802". */
export const addressOf = (place) =>
  [place.spot, place.street, place.area, place.city, [place.countryCode === 'US' ? place.region : [place.region, place.country].filter(Boolean).join(', '), place.postcode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');

/**
 * What a failed position says, for Settings and for him. And 'asking': the question of whether Jester may know
 * (macOS's, or a browser's for his website) is up and hasn't been answered, which is no failure: the next time a
 * position's wanted it's asked for again at once, rather than after the usual wait.
 */
const PROBLEMS = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };

/**
 * @param {object} deps
 * @param {(options:{timeoutMs:number, patient?:boolean, fresh?:boolean}) => Promise<{ok:boolean, lat?:number, lon?:number, accuracy?:number, ageMs?:number, code?:number, message?:string, asking?:boolean}>} deps.locate
 *   this computer's position (mac-location.js, or main.js locateByPage); on a server, a device's (device-location.js),
 *   which may be one it kept from earlier, `ageMs` old
 * @param {() => {source:'off'|'here'|'place', place?:object|null}} deps.setting  what Settings says
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {() => void} [deps.onChange]  for Settings
 * @param {(() => string) | null} [deps.device]  on a server, which device a position would come from now (device-location.js):
 *   one from another device is no longer where they are, however new
 */
export function createWhereabouts({ locate, setting, fetchImpl = globalThis.fetch, log = () => undefined, now = Date.now, onChange = () => undefined, device = null }) {
  /** The last position: {lat, lon, accuracy, at, device, key}: on a server, the device it came from, as said and as known. */
  let fix = null;
  /** Its name, and where that was: {lat, lon, place}. */
  let named = null;
  let namedAt = 0;
  /** Why there's no position: 'denied', 'unavailable', 'timeout', or what else went wrong. */
  let problem = '';
  let failedAt = 0;
  /** On a server, the device that couldn't say: another can be asked at once. */
  let failedKey = '';
  /** There's been a position since this source was chosen: macOS has said yes. */
  let located = false;
  let pending = null;

  const source = () => {
    const chosen = setting()?.source;
    return chosen === 'here' || chosen === 'place' ? chosen : 'off';
  };

  async function name(at) {
    if (named && distance(named, at) < RENAME_M) return;
    if (now() - namedAt < NAMING_GAP_MS) return;
    namedAt = now();
    try {
      const query = new URLSearchParams({ format: 'jsonv2', lat: at.lat.toFixed(6), lon: at.lon.toFixed(6), zoom: '18', addressdetails: '1', 'accept-language': 'en' });
      const response = await fetchImpl(`${REVERSE}?${query}`, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.timeout(ASK_MS) });
      if (!response.ok) throw new Error(`OpenStreetMap answered ${response.status}`);
      const place = placeParts(await response.json());
      if (place.city || place.region || place.country) named = { lat: at.lat, lon: at.lon, place };
    } catch (err) {
      log('location: couldn’t name the place:', err.message);
    }
  }

  /**
   * A new position from this computer, and its name. One at a time; and after one that failed, not again for two
   * minutes unless Settings asks (`patient`), or every turn would wait on Location Services saying no again.
   */
  function refresh({ patient = false, fresh = false } = {}) {
    if (source() !== 'here') return Promise.resolve(null);
    if (!patient && !pending && failedAt && now() - failedAt < RETRY_MS && (!device || failedKey === device())) return Promise.resolve(null);
    pending ||= (async () => {
      try {
        // Until there's been a position, macOS's question may be up, from whichever asked first.
        const got = await locate({ timeoutMs: patient || !located ? PATIENT_MS : QUICK_MS, patient, fresh });
        if (!got?.ok || !Number.isFinite(got.lat) || !Number.isFinite(got.lon)) {
          problem = got?.asking ? 'asking' : PROBLEMS[got?.code] || got?.message || 'unavailable';
          failedAt = got?.asking ? 0 : now();
          failedKey = device?.() || '';
          log('location: none:', problem);
          return null;
        }
        // One the device kept from earlier is as old as it is: asked where they are, it's asked for anew.
        fix = { lat: got.lat, lon: got.lon, accuracy: Number(got.accuracy) || 0, at: now() - Math.max(0, Number(got.ageMs) || 0), device: String(got.device || ''), key: String(got.key || '') };
        located = true;
        problem = '';
        failedAt = 0;
        await name(fix);
        return fix;
      } catch (err) {
        problem = err.message || 'unavailable';
        failedAt = now();
        log('location: couldn’t get it:', problem);
        return null;
      } finally {
        pending = null;
        onChange();
      }
    })();
    return pending;
  }

  /** The place, as he's told it, from a position and what's known of it. */
  function described(at, place, from) {
    return { lat: at.lat, lon: at.lon, accuracy: at.accuracy || 0, at: at.at || 0, source: from, ...(place || {}), town: place ? townOf(place) : '', address: place ? addressOf(place) : '' };
  }

  return {
    /** Something to go on: this computer's location, or a place. */
    get connected() {
      return source() !== 'off';
    },
    get source() {
      return source();
    },
    /**
     * Where the user is, or null. A position more than 15 minutes old is asked for again; meanwhile the old one is
     * given, unless it's fresh that's wanted, which waits up to waitMs.
     * @param {{fresh?:boolean, waitMs?:number}} [options]
     */
    async here({ fresh = false, waitMs = 0 } = {}) {
      const from = source();
      if (from === 'place') {
        const place = setting()?.place;
        return place && Number.isFinite(place.lat) ? described({ lat: place.lat, lon: place.lon }, { city: place.name, region: place.region || '', country: place.country || '', countryCode: place.countryCode || '' }, 'place') : null;
      }
      if (from !== 'here') return null;
      // Another device in use (his website, on a phone now, not the Mac): it's somewhere else, so it's asked at once.
      const switched = !!device && !!fix?.key && !!device() && device() !== fix.key;
      const age = fix ? now() - fix.at : Infinity;
      if (age > STALE_MS || switched || (fresh && age > FRESH_MS)) {
        const asking = refresh({ fresh: fresh && age > FRESH_MS });
        if (!fix || fresh || switched) {
          let timer;
          await Promise.race([asking, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
          clearTimeout(timer);
        }
      }
      if (!fix) return null;
      return described(fix, named && distance(named, fix) < RENAME_M * 2 ? named.place : null, 'here');
    },
    /** Asked again: from Settings, waiting for macOS's question to be answered; after a wake, in the background. */
    locate: (options) => refresh(options),
    /** The source changed in Settings: a position from before means nothing now. */
    reset() {
      fix = null;
      named = null;
      namedAt = 0;
      problem = '';
      failedAt = 0;
      located = false;
      onChange();
    },
    /** For Settings. */
    state() {
      const from = source();
      const place = from === 'place' ? setting()?.place : named?.place;
      return {
        source: from,
        locating: !!pending,
        problem: from === 'here' ? problem : '',
        town: from === 'place' ? [place?.name, place?.countryCode === 'US' ? place?.region : place?.country].filter(Boolean).join(', ') : place ? townOf(place) : '',
        accuracy: from === 'here' && fix ? Math.round(fix.accuracy) : 0,
        at: from === 'here' ? fix?.at || 0 : 0,
        // On a server: the device it came from ("your iPhone").
        device: from === 'here' ? fix?.device || '' : ''
      };
    }
  };
}
