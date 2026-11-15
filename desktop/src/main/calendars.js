/**
 * The user's calendars, all of them combined. Each is read from the link its
 * calendar app gives for it: an iCalendar feed (Google's "secret address in iCal
 * format", Outlook's published ICS link, an iCloud public calendar, Canvas's
 * calendar feed). A link reads a calendar without signing in to anything, works
 * the same on Windows, and covers every calendar app there is; but anyone holding
 * one can read that calendar, so links are kept sealed (chrome-bridge.js
 * PRIVATE_KEYS) and never go back to a page: Settings is shown a calendar's name
 * and site.
 *
 * Each is read when it's added, then every 15 minutes. Its events from a week ago
 * to three months ahead are kept, recurring ones expanded (ical.js), and one that
 * appears on two calendars (a meeting on both a Google and a school calendar) is
 * kept once, with both calendars named. Only an event's title, times, place and
 * calendar are kept: descriptions run long, and they're other people's words.
 */

import crypto from 'node:crypto';
import ICAL from 'ical.js';

/** How often every calendar is read again. Google's own feed lags its calendar by hours at worst: no sooner helps. */
export const REFRESH_MS = 15 * 60 * 1000;
const FETCH_MS = 20000;
/** Years of a busy calendar come to a few megabytes. */
const MAX_BYTES = 25 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** What's kept: from a week back (“what did I have on Monday?”) to three months ahead. */
export const BACK_DAYS = 7;
export const AHEAD_DAYS = 90;
/** One recurring event's occurrences in that window: a daily one has about a hundred. */
const PER_SERIES = 400;
/** Steps through one recurring event at most, whatever its rule: an hourly one from years ago stops here. */
const STEPS = 20000;
const TITLE_CHARS = 120;
const PLACE_CHARS = 90;
const NAME_CHARS = 60;

/** Each calendar app's name, by its feed's site. */
const APPS = [
  [/(^|\.)google\.com$/, 'Google Calendar'],
  [/(^|\.)(outlook\.office365\.com|outlook\.office\.com|outlook\.live\.com|office365\.com|live\.com)$/, 'Outlook'],
  [/(^|\.)icloud\.com$/, 'iCloud'],
  [/(^|\.)instructure\.com$/, 'Canvas'],
  [/(^|\.)fastmail\.com$/, 'Fastmail'],
  [/(^|\.)proton\.me$/, 'Proton Calendar'],
  [/(^|\.)yahoo\.com$/, 'Yahoo Calendar']
];

/**
 * A pasted link as the address to read: webcal:// is https://, and plain http is
 * made https, as the link is a key to the calendar and shouldn't cross a network
 * in the clear. Throws, in words for Settings, when it can't be a feed.
 */
export function feedUrl(input) {
  const text = String(input ?? '').trim().replace(/^webcals?:\/\//i, 'https://');
  if (!text) throw new Error('Paste the calendar’s link first.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That isn’t a link. Paste the whole address: it starts with https:// or webcal://.');
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') throw new Error('That isn’t a calendar link: it should start with https:// or webcal://.');
  return url.href;
}

/** The site a feed is read from, and its calendar app's name when it's a known one. */
export function siteOf(url) {
  const host = new URL(url).hostname.toLowerCase();
  return { host, app: APPS.find(([pattern]) => pattern.test(host))?.[1] || '' };
}

/**
 * Whose calendar a Google feed is, from its address (/calendar/ical/<their address>/private-…/basic.ics), so an
 * invitation they declined isn't counted as theirs to go to. Other feeds don't say: '' for those.
 */
export function ownerOf(url) {
  const { hostname, pathname } = new URL(url);
  if (!/(^|\.)google\.com$/i.test(hostname)) return '';
  const id = /\/calendar\/ical\/([^/]+)\//.exec(pathname)?.[1];
  try {
    const owner = id ? decodeURIComponent(id).toLowerCase() : '';
    return owner.includes('@') ? owner : '';
  } catch {
    return '';
  }
}

const clip = (text, chars) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > chars ? `${line.slice(0, chars - 1).trimEnd()}…` : line;
};

/** UTC offset of a zone at an instant, by the clock Intl keeps for it. One formatter per zone. */
const formatters = new Map();
function offsetAt(ms, zone) {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(zone, format);
  }
  const part = Object.fromEntries(format.formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - Math.floor(ms / 1000) * 1000;
}

/** Whether Intl knows a zone by that name (an IANA one: "America/New_York"). */
function knownZone(zone) {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant an iCalendar time stands for. A date is midnight on this computer's clock; a time with a zone the feed
 * defines (its VTIMEZONE), or UTC, is ical.js's to work out; one naming a zone the feed doesn't define is worked out
 * by Intl, which ical.js would otherwise read as UTC; and a floating one is this computer's clock.
 * @param {ICAL.Time} time
 * @param {string} [tzid]  the TZID its property named, for a zone the feed doesn't define
 */
export function instantOf(time, tzid = '') {
  if (time.isDate) return new Date(time.year, time.month - 1, time.day).getTime();
  const zone = time.zone;
  if (zone === ICAL.Timezone.utcTimezone || (zone && zone.component)) return time.toUnixTime() * 1000;
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  if (knownZone(tzid)) {
    // Twice: the offset at the guess can differ from the one at the answer, across a clock change.
    let guess = wall - offsetAt(wall, tzid);
    guess = wall - offsetAt(guess, tzid);
    return guess;
  }
  return new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second).getTime();
}

const tzidOf = (component, name) => component.getFirstProperty(name)?.getParameter('tzid') || '';

/** Whether whoever's calendar it is said no to it. */
function declined(component, owner) {
  if (!owner) return false;
  return component.getAllProperties('attendee').some((attendee) => {
    const who = String(attendee.getFirstValue() ?? '').replace(/^mailto:/i, '').toLowerCase();
    return who === owner && String(attendee.getParameter('partstat') ?? '').toUpperCase() === 'DECLINED';
  });
}

const cancelled = (component) => String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';

/** A one-off event's end: DTEND, or DTSTART and DURATION, or a day for a date and nothing for a time. */
function endOf(component, start, startAt) {
  const dtend = component.getFirstPropertyValue('dtend');
  if (dtend) return Math.max(startAt, instantOf(dtend, tzidOf(component, 'dtend') || tzidOf(component, 'dtstart')));
  const duration = component.getFirstPropertyValue('duration');
  if (duration) {
    if (!start.isDate) return startAt + duration.toSeconds() * 1000;
    const end = start.clone();
    end.addDuration(duration);
    return instantOf(end);
  }
  return start.isDate ? new Date(start.year, start.month - 1, start.day + 1).getTime() : startAt;
}

const eventOf = (component, start, end, allDay) => ({
  uid: String(component.getFirstPropertyValue('uid') ?? ''),
  title: clip(component.getFirstPropertyValue('summary'), TITLE_CHARS) || '(no title)',
  place: clip(component.getFirstPropertyValue('location'), PLACE_CHARS),
  start,
  end,
  allDay
});

const overlaps = (start, end, from, to) => start < to && Math.max(end, start + 1) > from;

/**
 * Where to start stepping through a recurring event so that its occurrences from `from` on are all reached, without
 * walking every one since it began: ical.js steps from the first, and a class meeting three times a week since 2022
 * is 600 steps before today (150 such took 2.4 s, against 50 ms from here). Only a rule counting its occurrences
 * (COUNT) has to start at the beginning, as do months begun past the 28th, which a whole number of months away might
 * not have. Moved by whole periods of the rule, so the occurrences that follow are the ones it always had.
 */
function startNear(dtstart, rules, from) {
  if (rules.length !== 1) return dtstart;
  const [rule] = rules;
  if (rule.count || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) return dtstart;
  const interval = Math.max(1, rule.interval || 1);
  // A period's grace before `from`, measured in days on the event's own clock.
  const days = Math.floor((from - Date.UTC(dtstart.year, dtstart.month - 1, dtstart.day)) / DAY_MS) - 2;
  if (days <= 0) return dtstart;
  const begin = dtstart.clone();
  if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
    const step = interval * (rule.freq === 'WEEKLY' ? 7 : 1);
    const periods = Math.floor(days / step) - 1;
    if (periods <= 0) return dtstart;
    begin.adjust(periods * step, 0, 0, 0);
    return begin;
  }
  if (dtstart.day > 28) return dtstart;
  const step = interval * (rule.freq === 'YEARLY' ? 12 : 1);
  const periods = Math.floor(days / 31 / step) - 1;
  if (periods <= 0) return dtstart;
  const month = dtstart.year * 12 + (dtstart.month - 1) + periods * step;
  begin.year = Math.floor(month / 12);
  begin.month = (month % 12) + 1;
  return begin;
}

/** A recurring event's occurrences between from and to, its moved and cancelled ones as they now are. */
function occurrences(master, exceptions, { from, to, owner }) {
  const event = new ICAL.Event(master, { exceptions, strictExceptions: false });
  const tzid = tzidOf(master, 'dtstart');
  const rules = master.getAllProperties('rrule').map((property) => property.getFirstValue());
  const expansion = new ICAL.RecurExpansion({ component: master, dtstart: startNear(event.startDate, rules, from) });
  const found = [];
  const seen = new Set();
  const add = (details) => {
    const item = details.item.component;
    if (cancelled(item) || declined(item, owner)) return;
    const zone = details.item === event ? tzid : tzidOf(item, 'dtstart') || tzid;
    const start = instantOf(details.startDate, zone);
    const end = Math.max(start, instantOf(details.endDate, zone));
    if (overlaps(start, end, from, to)) found.push(eventOf(item, start, end, details.startDate.isDate));
  };
  let next;
  for (let steps = 0; steps < STEPS && found.length < PER_SERIES && (next = expansion.next()); steps++) {
    // An occurrence a day before `from` can still be under way at it; one starting after `to` ends the walk.
    if (instantOf(next, tzid) >= to) break;
    seen.add(next.toString());
    add(event.getOccurrenceDetails(next));
  }
  // An occurrence moved into the window from outside it was never stepped on.
  for (const exception of exceptions) {
    const id = exception.getFirstPropertyValue('recurrence-id');
    if (!id || seen.has(id.toString())) continue;
    const start = exception.getFirstPropertyValue('dtstart');
    if (!start) continue;
    const startAt = instantOf(start, tzidOf(exception, 'dtstart'));
    const endAt = endOf(exception, start, startAt);
    if (!cancelled(exception) && !declined(exception, owner) && overlaps(startAt, endAt, from, to)) found.push(eventOf(exception, startAt, endAt, start.isDate));
  }
  return found;
}

/**
 * A feed's name and its events between from and to.
 * @param {string} text  the feed, as read
 * @param {{from:number, to:number, owner?:string}} window
 * @returns {{name:string, events:{uid:string, title:string, place:string, start:number, end:number, allDay:boolean}[]}}
 */
export function readFeed(text, { from, to, owner = '' }) {
  const body = String(text ?? '');
  if (!/BEGIN:VCALENDAR/i.test(body.slice(0, 4096))) {
    throw new Error(/<(?:!doctype|html)/i.test(body.slice(0, 1024)) ? 'That link opens a web page, not the calendar itself. Use its iCal or ICS link.' : 'That link doesn’t lead to a calendar.');
  }
  let parsed;
  try {
    parsed = ICAL.parse(body);
  } catch (err) {
    throw new Error(`That calendar couldn’t be read: ${err.message}`);
  }
  const roots = (typeof parsed[0] === 'string' ? [parsed] : parsed).map((jcal) => new ICAL.Component(jcal));
  const name = clip(roots.map((root) => root.getFirstPropertyValue('x-wr-calname')).find(Boolean), NAME_CHARS);
  const events = [];
  for (const root of roots) {
    const all = root.getAllSubcomponents('vevent');
    const moved = new Map();
    for (const component of all) {
      if (!component.hasProperty('recurrence-id')) continue;
      const uid = String(component.getFirstPropertyValue('uid') ?? '');
      moved.set(uid, [...(moved.get(uid) || []), component]);
    }
    const masters = new Set();
    for (const component of all) {
      if (component.hasProperty('recurrence-id')) continue;
      const uid = String(component.getFirstPropertyValue('uid') ?? '');
      const start = component.getFirstPropertyValue('dtstart');
      if (!start) continue;
      if (component.hasProperty('rrule') || component.hasProperty('rdate')) {
        masters.add(uid);
        try {
          events.push(...occurrences(component, moved.get(uid) || [], { from, to, owner }));
        } catch {
          // A rule ical.js can't follow costs that event, not the calendar.
        }
        continue;
      }
      if (cancelled(component) || declined(component, owner)) continue;
      const startAt = instantOf(start, tzidOf(component, 'dtstart'));
      const endAt = endOf(component, start, startAt);
      if (overlaps(startAt, endAt, from, to)) events.push(eventOf(component, startAt, endAt, start.isDate));
    }
    // One occurrence of someone else's series, with no series: an invitation to just that one.
    for (const [uid, list] of moved) {
      if (masters.has(uid)) continue;
      for (const component of list) {
        const start = component.getFirstPropertyValue('dtstart');
        if (!start || cancelled(component) || declined(component, owner)) continue;
        const startAt = instantOf(start, tzidOf(component, 'dtstart'));
        const endAt = endOf(component, start, startAt);
        if (overlaps(startAt, endAt, from, to)) events.push(eventOf(component, startAt, endAt, start.isDate));
      }
    }
  }
  return { name, events };
}

const sameTitle = (title) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Every calendar's events as one list, in order. The same event on two calendars (the same invitation, or the same
 * title at the same times) is one, naming both.
 * @param {{calendar:string, events:object[]}[]} lists
 * @returns {{title:string, place:string, start:number, end:number, allDay:boolean, calendars:string[]}[]}
 */
export function combine(lists) {
  const kept = new Map();
  const byUid = new Map();
  for (const { calendar, events } of lists) {
    for (const event of events) {
      const key = `${sameTitle(event.title)}|${event.start}|${event.end}`;
      const uidKey = event.uid ? `${event.uid}|${event.start}` : '';
      const already = kept.get(key) || (uidKey && byUid.get(uidKey));
      if (already) {
        if (!already.calendars.includes(calendar)) already.calendars.push(calendar);
        if (!already.place && event.place) already.place = event.place;
        continue;
      }
      const entry = { title: event.title, place: event.place, start: event.start, end: event.end, allDay: event.allDay, calendars: [calendar] };
      kept.set(key, entry);
      if (uidKey) byUid.set(uidKey, entry);
    }
  }
  return [...kept.values()].sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
}

/** What a read that failed says, for Settings. */
function failure(status) {
  if (status === 401 || status === 403) return 'The calendar turned Jester away: its link may have been reset, or made private.';
  if (status === 404 || status === 410) return 'Nothing is at that link any more: it may have been reset. Copy it again.';
  return `Its site answered with an error (${status}).`;
}

/**
 * @param {object} deps
 * @param {{get:Function, set:Function}} deps.storage  where the links are kept: sealed (chrome-bridge.js PRIVATE_KEYS)
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {() => void} [deps.onChange]  the calendars or what's known of them changed: for Settings
 * @param {number} [deps.every]  how often they're read again
 */
export function createCalendars({ storage, fetchImpl = globalThis.fetch, log = () => undefined, now = Date.now, onChange = () => undefined, every = REFRESH_MS }) {
  /** @type {{id:string, url:string, name:string, added:number}[]} */
  let feeds = [];
  /** What each has given: its events, when, and what went wrong last time. */
  const read = new Map();
  let combined = [];
  let loaded = null;
  let timer = null;
  let reading = Promise.resolve();

  const windowFrom = () => {
    const today = new Date(now());
    return { from: new Date(today.getFullYear(), today.getMonth(), today.getDate() - BACK_DAYS).getTime(), to: new Date(today.getFullYear(), today.getMonth(), today.getDate() + AHEAD_DAYS).getTime() };
  };

  const nameOf = (feed) => feed.name || read.get(feed.id)?.name || siteOf(feed.url).app || siteOf(feed.url).host;

  function recombine() {
    combined = combine(feeds.map((feed) => ({ calendar: nameOf(feed), events: read.get(feed.id)?.events || [] })));
  }

  function load() {
    loaded ||= storage.get({ calendarFeeds: [] }).then(({ calendarFeeds }) => {
      feeds = (Array.isArray(calendarFeeds) ? calendarFeeds : []).filter((feed) => feed && typeof feed.url === 'string' && feed.id);
    });
    return loaded;
  }

  const persist = () => storage.set({ calendarFeeds: feeds.map(({ id, url, name, added }) => ({ id, url, name, added })) });

  async function fetchFeed(url) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'User-Agent': 'Jester-Desktop' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_MS) });
    } catch (err) {
      throw new Error(err?.name === 'TimeoutError' ? 'Its site didn’t answer in time.' : 'Its site couldn’t be reached.');
    }
    if (!response.ok) throw new Error(failure(response.status));
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('That calendar is too big to read.');
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error('That calendar is too big to read.');
    return text;
  }

  /** Reads one calendar; what it had before stays, when this read fails. */
  async function readOne(feed) {
    const at = now();
    try {
      const { name, events } = readFeed(await fetchFeed(feed.url), { ...windowFrom(), owner: ownerOf(feed.url) });
      read.set(feed.id, { name, events, at, error: '' });
      return { name, events };
    } catch (err) {
      const before = read.get(feed.id);
      read.set(feed.id, { name: before?.name || '', events: before?.events || [], at: before?.at || 0, error: err.message, failedAt: at });
      log('calendar: couldn’t read', siteOf(feed.url).host, '-', err.message);
      throw err;
    }
  }

  /** Every calendar, again, one at a time: the main process has a cursor to run between them. */
  function refresh() {
    reading = reading.then(async () => {
      await load();
      for (const feed of [...feeds]) {
        await readOne(feed).catch(() => undefined);
        await new Promise((resolve) => setImmediate(resolve));
      }
      recombine();
      onChange();
    });
    return reading;
  }

  return {
    /** Reads them now and every 15 minutes from now on. */
    async start() {
      await load();
      if (!timer && feeds.length) {
        timer = setInterval(refresh, every);
        timer.unref?.();
      }
      if (feeds.length) await refresh();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    /** Reads them all again now: after the computer wakes, say, when 15 minutes may have been hours. */
    refresh,
    /** There's at least one. */
    get connected() {
      return feeds.length > 0;
    },
    /** Each calendar as Settings shows it: never its link. */
    list() {
      return feeds.map((feed) => {
        const state = read.get(feed.id);
        const { host, app } = siteOf(feed.url);
        const events = state?.events || [];
        return { id: feed.id, name: nameOf(feed), site: app || host, host, events: events.filter((event) => event.end > now()).length, at: state?.at || 0, error: state?.error || '', reading: !state };
      });
    },
    /** The calendars' names, as they're told apart in what he's told. */
    names: () => feeds.map(nameOf),
    /** Calendars whose last read failed and which have nothing from before it. */
    unread: () => feeds.filter((feed) => read.get(feed.id)?.error && !read.get(feed.id)?.at).map(nameOf),
    /**
     * Adds a calendar, once it's been read: a link that isn't one is turned away with why.
     * @returns {Promise<{name:string, events:number}>}
     */
    async add({ url: input, name = '' }) {
      await load();
      const url = feedUrl(input);
      if (feeds.some((feed) => feed.url === url)) throw new Error('That calendar is already connected.');
      const feed = { id: crypto.randomUUID(), url, name: clip(name, NAME_CHARS), added: now() };
      let got;
      try {
        got = await readOne(feed);
      } catch (err) {
        read.delete(feed.id);
        throw err;
      }
      feeds.push(feed);
      await persist();
      recombine();
      if (!timer) {
        timer = setInterval(refresh, every);
        timer.unref?.();
      }
      onChange();
      log('calendar: added one from', siteOf(url).host, '-', got.events.length, 'events');
      return { name: nameOf(feed), events: got.events.length };
    },
    async remove(id) {
      await load();
      feeds = feeds.filter((feed) => feed.id !== id);
      read.delete(id);
      await persist();
      recombine();
      if (!feeds.length) this.stop();
      onChange();
    },
    /** Its name, as the user wants it said. '' goes back to the calendar's own. */
    async rename(id, name) {
      await load();
      const feed = feeds.find((item) => item.id === id);
      if (!feed) return;
      feed.name = clip(name, NAME_CHARS);
      await persist();
      recombine();
      onChange();
    },
    /** Every calendar's events under way at some point between from and to, in order, each once. */
    between(from, to) {
      return combined.filter((event) => overlaps(event.start, event.end, from, to));
    },
    /** The first event to start after `at`, within the three months kept, or null. */
    nextAfter(at) {
      return combined.find((event) => event.start >= at) || null;
    }
  };
}
