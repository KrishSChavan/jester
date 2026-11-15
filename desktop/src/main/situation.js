/**
 * What's going on around the user, for Jester to know as he answers: where they
 * are, the weather there, and what's on their calendars, all of them combined.
 * conversation.js sets it before what they said, with what his memory recalls.
 *
 * Some of it every turn, so he knows their day as a friend would ("you've got
 * 465 at four"): the town, the weather now and today's, and their calendars for
 * the rest of today and tomorrow. More when their words ask for it: about the
 * weather, the hours and the week ahead; about their schedule, the week (or as
 * far as the words reach: "next week", "December 3rd"), and the week before for
 * "what did I have on Monday"; about where they are, the street, a fresh position
 * and how sure it is; about another place's weather ("in Chicago"), that place's.
 * Words decide it, as they do what's recalled from the vault: a model asking for
 * more would cost a second turn.
 *
 * An event's title is someone's words, often someone else's (an invitation), so a
 * turn told any is one whose commands ask first when they could do harm, as one
 * told the user's own notes is (conversation.js).
 *
 * Asked how long they've been at the computer, or away from it, or whether
 * it's time for a break, he's told when they sat down (presence.js), and only
 * then: it's nothing to bring up unasked.
 */

import { AHEAD_DAYS, BACK_DAYS } from './calendars.js';
import { PRESENCE_WORDS } from './presence.js';
import { placeName, weatherLines } from './weather.js';

/** Events said with no question about the schedule, and at most with one. */
const NEAR_EVENTS = 10;
const MAX_EVENTS = 40;
/** Asked where they are, or with no position yet, a new one is waited for this long. */
const PLACE_WAIT_MS = 3000;

export const WEATHER_WORDS =
  /\b(?:weather|forecast|temperature|temp|degrees|rain(?:ing|y|s)?|drizzl\w*|snow(?:ing|y|s)?|umbrella|jacket|coat|hoodie|sweater|shorts|cold|hot|warm|chilly|freezing|humid(?:ity)?|sunny|sun|cloudy|clouds?|windy?|storm(?:s|y|ing)?|thunder\w*|hail|sleet|fog(?:gy)?|sunrise|sunset|uv|outside|out there|nice out)\b/i;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const SCHEDULE_WORDS = new RegExp(
  String.raw`\b(?:calendars?|schedul\w*|agenda|plans?|planned|busy|free|available|availability|meetings?|appointments?|class(?:es)?|lectures?|labs?|exams?|midterms?|finals?|quiz(?:zes)?|deadlines?|due|events?|today|tonight|tomorrow|yesterday|weekend|week|month|morning|afternoon|evening|later|next|upcoming|when|what time|o['’]?clock|\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|birthday|party|dinner|lunch|breakfast|flight|trip|practice|shift|holiday|${WEEKDAYS.join('|')})\b`,
  'i'
);
export const PLACE_WORDS = /\b(?:where am i|where i am|where are we|my location|current location|location|near me|nearby|near here|close by|around here|around me|this area|neighbou?rhood|how far|address|what city|which city|what town|what street|directions?)\b/i;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\b/gi;
const MONTH_ONLY = new RegExp(String.raw`\b(?:in|during|for|this|next|all of|through|until|till|by)\s+(${MONTHS.join('|')})\b`, 'gi');
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})\b/g;

/** Midnight, `days` from the day `at` falls on, by this computer's clock. */
const dayStart = (at, days = 0) => {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};

/**
 * The stretch of days the user's words ask about: the coming week, unless they reach further ("next week", "this
 * month", "December 3rd") or back ("yesterday", "last Monday"). Never beyond what's kept (calendars.js).
 * @returns {{from:number, to:number}}
 */
export function scheduleRange(text, at) {
  const line = String(text ?? '').toLowerCase();
  const today = dayStart(at);
  let from = today;
  let to = dayStart(at, 7);
  const reach = (end) => (to = Math.max(to, Math.min(end, dayStart(at, AHEAD_DAYS))));
  if (/\b(?:yesterday|last (?:week|night|weekend|\w+day)|earlier this week|this past|days? ago|the other day)\b/.test(line)) from = dayStart(at, -BACK_DAYS);
  if (/\b(?:next week|week after|two weeks|2 weeks|fortnight)\b/.test(line)) reach(dayStart(at, 14));
  if (/\b(?:this month|next month|(?:in|for) (?:a|one|two|three|four|\d+) (?:weeks|months)|weeks from now|rest of the (?:month|semester|term))\b/.test(line)) reach(dayStart(at, 45));
  const now = new Date(at);
  const thisYear = (month, day) => {
    let target = new Date(now.getFullYear(), month, day).getTime();
    if (target < dayStart(at, -BACK_DAYS)) target = new Date(now.getFullYear() + 1, month, day).getTime();
    return target;
  };
  for (const match of line.matchAll(MONTH_SHORT)) {
    const name = (match[1] || match[4]).slice(0, 3);
    const month = MONTHS.findIndex((item) => item.startsWith(name));
    const day = Number(match[2] || match[3]);
    if (month >= 0 && day >= 1 && day <= 31) reach(dayStart(thisYear(month, day), 1));
  }
  for (const match of line.matchAll(MONTH_ONLY)) {
    const month = MONTHS.indexOf(match[1]);
    if (month >= 0) reach(new Date(new Date(thisYear(month, 1)).getFullYear(), month + 1, 1).getTime());
  }
  for (const match of line.matchAll(NUMERIC_DATE)) {
    const [month, day] = [Number(match[1]) - 1, Number(match[2])];
    if (month >= 0 && month < 12 && day >= 1 && day <= 31) reach(dayStart(thisYear(month, day), 1));
  }
  return { from, to };
}

/** Not a place: "rain in the afternoon", "cold in here", "weather for tomorrow". */
const NOT_A_PLACE =
  /^(?:the|a|an|my|our|your|his|her|their|this|that|these|those|here|there|it|all|any|some|case|general|bed|class|school|work|home|town|time|celsius|fahrenheit|degrees|today|tonight|tomorrow|now|right|next|last|first|least|most|once|night|noon|midnight|morning|afternoon|evening|lunch|dinner|breakfast|sunrise|sunset|an?\s+(?:hour|minute|bit|while|few))\b/i;
const WHEN_AFTER = /\s+(?:today|tonight|tomorrow|this\s+\w+|next\s+\w+|right now|now|later|at\s+\d.*|on\s+\w+|over the\s+\w+|in the\s+\w+|like|be like|going to be|gonna be|look like|looking)\s*$/i;

/**
 * Another place whose weather is asked about ("what's it like in Chicago tomorrow?" → "Chicago"), or ''. Whether
 * it's a place at all is the place search's to say.
 */
export function placeAsked(text) {
  const match = /\b(?:in|at|for|over in|out in)\s+([\p{L}][\p{L}\p{N} .,'’-]{1,60})/iu.exec(String(text ?? ''));
  if (!match) return '';
  let place = match[1].replace(/[?.!;]+.*$/, '').trim();
  for (let i = 0; i < 3; i++) place = place.replace(WHEN_AFTER, '').trim();
  place = place.replace(/,\s*$/, '');
  if (!place || NOT_A_PLACE.test(place) || place.split(/\s+/).length > 6) return '';
  return place;
}

/** What the user's words ask about. */
export function asksAbout(text) {
  const line = String(text ?? '');
  const weather = WEATHER_WORDS.test(line);
  return { weather, schedule: SCHEDULE_WORDS.test(line), place: PLACE_WORDS.test(line), elsewhere: weather ? placeAsked(line) : '' };
}

/** "4:00 PM", with a plain space: ICU's is a narrow no-break one. */
const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');

/** "Today", "Tomorrow", "Yesterday", or "Thursday, Nov 13". */
export function dayName(ms, at) {
  const gap = Math.round((dayStart(ms) - dayStart(at)) / 864e5);
  if (gap === 0) return 'Today';
  if (gap === 1) return 'Tomorrow';
  if (gap === -1) return 'Yesterday';
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/** "4:00–5:15 PM", "11:00 AM–12:30 PM", "10:00 PM to Saturday, Nov 15 2:00 AM". */
function span(start, end, at) {
  if (end <= start) return clock(start);
  const [a, b] = [clock(start), clock(end)];
  if (dayStart(start) !== dayStart(end)) return `${a} to ${dayName(end, at)} ${b}`;
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

/** One event, as a line: "- Today 4:00–5:15 PM (happening now): CMPSC 465, at Westgate E201 (Penn State)". */
export function eventLine(event, at, { calendars = true } = {}) {
  const when = event.allDay
    ? dayStart(event.end - 1) > dayStart(event.start)
      ? `${dayName(event.start, at)} to ${dayName(event.end - 1, at)}, all day`
      : `${dayName(event.start, at)}, all day`
    : `${dayName(event.start, at)} ${span(event.start, event.end, at)}`;
  const now = !event.allDay && event.start <= at && event.end > at ? ' (happening now)' : '';
  const where = event.place ? `, at ${event.place}` : '';
  return `- ${when}${now}: ${event.title}${where}${calendars ? ` (${event.calendars.join(', ')})` : ''}`;
}

const ago = (ms) => {
  const minutes = Math.round(ms / 60000);
  return minutes < 1 ? 'just now' : minutes === 1 ? 'a minute ago' : minutes < 60 ? `${minutes} minutes ago` : 'over an hour ago';
};

/**
 * @param {object} deps
 * @param {ReturnType<import('./whereabouts.js').createWhereabouts>} deps.whereabouts
 * @param {ReturnType<import('./weather.js').createWeather>} deps.weather
 * @param {ReturnType<import('./calendars.js').createCalendars>} deps.calendars
 * @param {() => 'fahrenheit'|'celsius'} deps.units
 * @param {string} [deps.computer]  "Mac", or "computer": what he says the location is from
 * @param {{lines:() => string}} [deps.presence]  when they sat down at the computer (presence.js)
 * @param {() => number} [deps.now]
 */
export function createSituation({ whereabouts, weather, calendars, units, computer = 'computer', presence = null, now = Date.now }) {
  function whereLine(here, asked, at) {
    if (!here) {
      const { problem } = whereabouts.state();
      return problem === 'denied'
        ? `Where the user is isn't known: this ${computer}'s Location Services are off for Jester, so neither is the weather there.`
        : `Where the user is isn't known just now: this ${computer} couldn't find its location, so neither is the weather there.`;
    }
    const from = here.source === 'place' ? 'the place they set in Settings, not a live location' : `this ${computer}'s location`;
    const coords = `${here.lat.toFixed(5)}, ${here.lon.toFixed(5)}`;
    if (!asked) return `Where the user is: ${here.town || `near ${coords}`} (by ${from}).`;
    if (here.source === 'place') return `Where the user is: ${here.town} (by ${from}, so you don't know their street).`;
    const sure = here.accuracy ? ` to within ${Math.round(here.accuracy)} m` : '';
    return `Where the user is, by ${from}${sure}, ${ago(at - here.at)}: ${here.address || 'a place with no name on the map'} (${coords}).`;
  }

  function calendarPart(asked, text, at) {
    const names = calendars.names();
    const range = asked.schedule ? scheduleRange(text, at) : { from: at, to: dayStart(at, 2), near: true };
    const events = calendars.between(range.from, range.to);
    const shown = events.slice(0, asked.schedule ? MAX_EVENTS : NEAR_EVENTS);
    const stretch = range.near ? 'for the rest of today and tomorrow' : `from ${dayName(range.from, at)} through ${dayName(range.to - 1, at)}`;
    const many = names.length > 1;
    const lines = [`Their calendars, all combined (${names.join(', ')}), ${stretch}:${shown.length ? '' : ' nothing.'}`];
    lines.push(...shown.map((event) => eventLine(event, at, { calendars: many })));
    if (events.length > shown.length) lines.push(`- and ${events.length - shown.length} more.`);
    const next = calendars.nextAfter(range.to);
    if (next && (!events.length || range.near)) lines.push(`Next after that: ${eventLine(next, at, { calendars: many }).slice(2)}`);
    const unread = calendars.unread();
    if (unread.length) lines.push(`(${unread.join(', ')} couldn't be read just now, so ${unread.length > 1 ? 'they aren\'t' : 'it isn\'t'} in this.)`);
    return { lines, told: shown.length > 0 || !!next, count: shown.length };
  }

  return {
    /** What's connected, for his prompt: what he can speak to as fact. */
    live: () => ({ where: whereabouts.connected, calendars: calendars.connected }),
    /**
     * What to tell him with what the user said.
     * @returns {Promise<{block:string, untrusted:boolean, summary:string}>}  untrusted: it holds calendar events,
     *   which are other people's words; summary: for dev.log, with no place or event in it
     */
    async brief(text) {
      const at = now();
      const asked = asksAbout(text);
      const lines = [];
      const summary = [];
      if (whereabouts.connected) {
        // Waited for only when there's no position yet, or it's where they are that's asked.
        const here = await whereabouts.here({ fresh: asked.place, waitMs: PLACE_WAIT_MS }).catch(() => null);
        lines.push(whereLine(here, asked.place, at));
        summary.push(here ? `${here.source}${here.accuracy ? ` ±${Math.round(here.accuracy)} m` : ''}` : 'nowhere');
        // Asked about somewhere else, it's that place's weather that's given in full, and theirs as it always is.
        const there = asked.elsewhere ? await weather.findPlace(asked.elsewhere).catch(() => null) : null;
        if (here) {
          try {
            lines.push(...weatherLines(await weather.forecast({ lat: here.lat, lon: here.lon, units: units() }), { now: at, where: 'where the user is', detail: asked.weather && !there }));
            summary.push(asked.weather && !there ? 'weather in detail' : 'weather');
          } catch {
            lines.push('The weather where the user is couldn’t be fetched just now.');
          }
        }
        if (there) {
          try {
            lines.push(...weatherLines(await weather.forecast({ lat: there.lat, lon: there.lon, units: units() }), { now: at, where: `in ${placeName(there)}`, detail: true, days: 4 }));
            summary.push('weather elsewhere');
          } catch {
            lines.push(`The weather in ${placeName(there)} couldn’t be fetched just now.`);
          }
        }
      }
      if (presence && PRESENCE_WORDS.test(text)) {
        const sitting = presence.lines();
        if (sitting) {
          lines.push(sitting);
          summary.push('how long they’ve sat');
        }
      }
      let untrusted = false;
      if (calendars.connected) {
        const part = calendarPart(asked, text, at);
        lines.push(...part.lines);
        untrusted = part.told;
        summary.push(`${part.count} events`);
      }
      return { block: lines.join('\n'), untrusted, summary: summary.join(', ') };
    }
  };
}
