/**
 * The weather, from Open-Meteo: free for a person's own use, with no key or
 * account, worldwide, from national weather services' models. Asked for a place
 * at most every 10 minutes (its own data changes every 15); a forecast older than
 * that is still used while a newer one is fetched, up to 3 hours old. The place
 * goes to it to two decimals, about a kilometre: the weather is no different
 * across a street, and nobody else needs to know which street.
 *
 * Places named aloud ("what's it like in Chicago?") are found through
 * Open-Meteo's own place search, as is one typed in Settings.
 */

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
export const FRESH_MS = 10 * 60 * 1000;
/** Older than this, a forecast is waited for rather than used. */
const STALE_MS = 3 * 60 * 60 * 1000;
const ASK_MS = 8000;
const PLACES_KEPT = 200;

/** Countries whose people think in Fahrenheit. */
const FAHRENHEIT = new Set(['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW', 'FM', 'MH', 'PR', 'GU', 'VI', 'AS', 'MP']);

/** WMO weather codes, in words. */
export const CONDITIONS = Object.freeze({
  0: 'clear',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'foggy',
  48: 'freezing fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  56: 'light freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers',
  81: 'showers',
  82: 'heavy showers',
  85: 'light snow showers',
  86: 'snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with heavy hail'
});
const SNOWY = new Set([71, 73, 75, 77, 85, 86]);

/**
 * °F or °C: as Settings says, or by the country this computer is set to.
 * @param {'auto'|'fahrenheit'|'celsius'} [choice]
 * @param {string} [country]  ISO code: Electron's app.getLocaleCountryCode()
 */
export function unitsFor(choice = 'auto', country = '') {
  if (choice === 'fahrenheit' || choice === 'celsius') return choice;
  return FAHRENHEIT.has(String(country).toUpperCase()) ? 'fahrenheit' : 'celsius';
}

const condition = (code) => CONDITIONS[code] ?? 'unsettled';
const round = (value) => (Number.isFinite(value) ? Math.round(value) : null);

/** US state abbreviations, for "State College, PA". */
const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine',
  MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico'
};
const COUNTRY_WORDS = { usa: 'US', us: 'US', 'united states': 'US', america: 'US', uk: 'GB', 'united kingdom': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', britain: 'GB', 'great britain': 'GB' };

const plain = (text) => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * Which of the place search's answers is meant: the first (it puts big places first) that fits what came after a
 * comma, a state ("PA", "Pennsylvania") or a country ("UK", "France"), when something did.
 * @param {object[]} results  Open-Meteo's
 * @param {string} [within]
 */
export function pickPlace(results, within = '') {
  const list = Array.isArray(results) ? results.filter((item) => Number.isFinite(item?.latitude) && Number.isFinite(item?.longitude)) : [];
  const hint = plain(within).replace(/\./g, '');
  if (!hint) return list[0] || null;
  const state = STATES[hint.toUpperCase()] ? plain(STATES[hint.toUpperCase()]) : '';
  const country = COUNTRY_WORDS[hint] || (hint.length === 2 ? hint.toUpperCase() : '');
  return (
    list.find((item) => {
      const region = plain(item.admin1);
      return (state && region === state) || region === hint || plain(item.country) === hint || (country && String(item.country_code).toUpperCase() === country);
    }) || null
  );
}

/** How a found place is said: "Chicago, Illinois", "Paris, France". */
export function placeName(place) {
  if (!place) return '';
  const region = place.countryCode === 'US' ? place.region : place.country;
  return [place.name, region && region !== place.name ? region : ''].filter(Boolean).join(', ');
}

/**
 * A forecast in lines for the model.
 * @param {object} forecast  forecast() below
 * @param {object} options
 * @param {number} options.now
 * @param {string} options.where  "where the user is", "in Chicago, Illinois"
 * @param {boolean} [options.detail]  asked about the weather: the hours ahead and the week, not just now and today
 * @param {number} [options.days]  how many days to give, asked about
 */
export function weatherLines(forecast, { now, where, detail = false, days = detail ? 7 : 2 }) {
  if (!forecast?.current) return [];
  const f = forecast.units === 'fahrenheit';
  const deg = (value) => `${round(value)}°${f ? 'F' : 'C'}`;
  const speed = (value) => `${round(value)} ${f ? 'mph' : 'km/h'}`;
  const offset = forecast.offset * 1000;
  // The place's own clock: Chicago's 5 PM is 5 PM there, wherever the user is.
  const local = (seconds) => new Date(seconds * 1000 + offset);
  const hourName = (seconds) => {
    const hour = local(seconds).getUTCHours();
    return hour === 0 ? 'midnight' : hour === 12 ? 'noon' : `${hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
  };
  const clock = (seconds) => {
    const at = local(seconds);
    const hour = at.getUTCHours();
    return `${hour % 12 || 12}:${String(at.getUTCMinutes()).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  };
  const today = local(now / 1000);
  const dayName = (seconds, index) => {
    const at = local(seconds);
    const gap = Math.round((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 864e5);
    if (gap === 0) return 'Today';
    if (gap === 1) return 'Tomorrow';
    return at.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' }) || `Day ${index + 1}`;
  };
  const { current, daily = {}, hourly = {} } = forecast;
  const lines = [];
  const now_ = `${deg(current.temperature)}, ${condition(current.code)}${Math.abs(current.feelsLike - current.temperature) >= 3 ? `, feels like ${deg(current.feelsLike)}` : ''}`;
  const air = detail ? `, wind ${speed(current.wind)}${current.gusts - current.wind >= 8 ? ` gusting ${speed(current.gusts)}` : ''}, humidity ${round(current.humidity)}%` : '';
  lines.push(`Weather ${where} now (${hourName(current.time)} there): ${now_}${air}.`);
  if (detail && Array.isArray(hourly.time)) {
    const first = hourly.time.findIndex((time) => time > current.time);
    const hours = [];
    for (let i = first; i >= 0 && i < hourly.time.length && hours.length < 6; i += 2) {
      const chance = hourly.chance?.[i];
      hours.push(`${hourName(hourly.time[i])} ${deg(hourly.temperature[i])} ${condition(hourly.code[i])}${chance >= 20 ? ` (${chance}% chance of ${SNOWY.has(hourly.code[i]) ? 'snow' : 'rain'})` : ''}`);
    }
    if (hours.length) lines.push(`The next hours: ${hours.join('; ')}.`);
  }
  const count = Math.min(days, daily.time?.length || 0);
  for (let i = 0; i < count; i++) {
    const chance = daily.chance?.[i];
    const total = daily.total?.[i] > 0 ? Number(daily.total[i].toFixed(f ? 2 : 1)) : 0;
    const wet = chance >= 20 ? `, ${chance}% chance of ${SNOWY.has(daily.code[i]) ? 'snow' : 'rain'}${total ? ` (${total} ${f ? 'in' : 'mm'})` : ''}` : '';
    lines.push(`${dayName(daily.time[i], i)}: ${condition(daily.code[i])}, high ${deg(daily.high[i])}, low ${deg(daily.low[i])}${wet}.`);
  }
  if (detail && daily.sunrise?.[0]) lines.push(`Sunrise ${clock(daily.sunrise[0])}, sunset ${clock(daily.sunset[0])}, UV index up to ${round(daily.uv?.[0]) ?? '?'}.`);
  return lines;
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {(...parts:any[]) => void} [deps.log]
 */
export function createWeather({ fetchImpl = globalThis.fetch, now = Date.now, log = () => undefined } = {}) {
  /** Forecasts by place and units: {at, value, pending}. */
  const kept = new Map();
  const places = new Map();

  async function ask(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(ASK_MS) });
    if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}`);
    return response.json();
  }

  async function fetchForecast(lat, lon, units) {
    const f = units === 'fahrenheit';
    const query = new URLSearchParams({
      latitude: lat.toFixed(2),
      longitude: lon.toFixed(2),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m',
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max',
      timezone: 'auto',
      forecast_days: '8',
      timeformat: 'unixtime',
      temperature_unit: f ? 'fahrenheit' : 'celsius',
      wind_speed_unit: f ? 'mph' : 'kmh',
      precipitation_unit: f ? 'inch' : 'mm'
    });
    const data = await ask(`${FORECAST}?${query}`);
    const c = data.current || {};
    const d = data.daily || {};
    const h = data.hourly || {};
    return {
      units,
      offset: Number(data.utc_offset_seconds) || 0,
      timezone: String(data.timezone || ''),
      current: { time: c.time, temperature: c.temperature_2m, feelsLike: c.apparent_temperature, humidity: c.relative_humidity_2m, code: c.weather_code, wind: c.wind_speed_10m, gusts: c.wind_gusts_10m },
      hourly: { time: h.time || [], temperature: h.temperature_2m || [], chance: h.precipitation_probability || [], code: h.weather_code || [] },
      daily: {
        time: d.time || [],
        code: d.weather_code || [],
        high: d.temperature_2m_max || [],
        low: d.temperature_2m_min || [],
        chance: d.precipitation_probability_max || [],
        total: d.precipitation_sum || [],
        sunrise: d.sunrise || [],
        sunset: d.sunset || [],
        uv: d.uv_index_max || []
      }
    };
  }

  return {
    /**
     * The forecast for a place: kept for 10 minutes; older than that, still given (up to 3 hours old) while a new
     * one is fetched. Throws only with nothing to give.
     * @param {{lat:number, lon:number, units:'fahrenheit'|'celsius'}} place
     */
    async forecast({ lat, lon, units }) {
      const key = `${lat.toFixed(2)},${lon.toFixed(2)},${units}`;
      const entry = kept.get(key) || {};
      kept.set(key, entry);
      const age = now() - (entry.at || 0);
      if (entry.value && age < FRESH_MS) return entry.value;
      entry.pending ||= fetchForecast(lat, lon, units)
        .then((value) => {
          entry.value = value;
          entry.at = now();
          return value;
        })
        .catch((err) => {
          log('weather: couldn’t fetch it:', err.message);
          throw err;
        })
        .finally(() => {
          entry.pending = null;
        });
      if (entry.value && age < STALE_MS) {
        entry.pending.catch(() => undefined);
        return entry.value;
      }
      return entry.pending;
    },
    /**
     * A place by name, "Chicago", "State College, PA", "Paris, France", or null when there's none.
     * @returns {Promise<{name:string, region:string, country:string, countryCode:string, lat:number, lon:number, timezone:string}|null>}
     */
    async findPlace(text) {
      const [name, ...rest] = String(text ?? '').split(',').map((part) => part.trim());
      if (!name || name.length < 2) return null;
      const key = plain(text);
      if (places.has(key)) return places.get(key);
      const data = await ask(`${GEOCODE}?${new URLSearchParams({ name, count: '10', language: 'en', format: 'json' })}`);
      const found = pickPlace(data.results, rest.join(' '));
      const place = found
        ? { name: found.name, region: found.admin1 || '', country: found.country || '', countryCode: String(found.country_code || '').toUpperCase(), lat: found.latitude, lon: found.longitude, timezone: found.timezone || '' }
        : null;
      if (places.size >= PLACES_KEPT) places.delete(places.keys().next().value);
      places.set(key, place);
      return place;
    }
  };
}
