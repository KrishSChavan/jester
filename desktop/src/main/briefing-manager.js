/** Saved briefing snapshots and the offer/read lifecycle. No page or UI actions
 * happen here: a user must select Read, Later, Dismiss or an individual item. */
import { randomUUID } from 'node:crypto';
import { sourceAddress } from './research-sources.js';
import { secretIn } from './vault-memory.js';

export const BRIEFING_KEY = 'briefingSnapshots';
export const BRIEFING_KEEP_MS = 7 * 24 * 3600_000;
export const BRIEFING_LATER_MS = 10 * 60_000;
/** `replaced`: an update was asked for, and made; the old one is kept to read again, never offered. */
const STATES = new Set(['ready', 'offered', 'reading', 'read', 'later', 'dismissed', 'replaced']);
const KINDS = new Set(['morning', 'evening', 'custom']);
const clone = (value) => value == null ? value : structuredClone(value);
const tidy = (value, most = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, most) : '';
const safe = (value, most = 200) => { const text = tidy(value, most); return text && !secretIn(text) ? text : ''; };
/** Longer words with a secret in them (a meeting's passcode, a sign-in code) lose only the sentences that hold it. */
const safeText = (value, most) => {
  const text = tidy(value, most);
  if (!text || !secretIn(text)) return text;
  const kept = text.split(/(?<=[.!?…])\s+/).filter((sentence) => !secretIn(sentence)).join(' ');
  return secretIn(kept) ? '' : kept;
};
const dayOf = (at) => { const date = new Date(at); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
const startOf = (at) => { const date = new Date(at); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
const abort = (signal) => { if (signal?.aborted) throw Object.assign(new Error('Briefing cancelled.'), { name: 'AbortError' }); };

const KIND_WORD = String.raw`(?:morning|evening|nightly|daily|day's|end of day|custom|new|fresh|updated|latest|quick|short|full|canvas|class(?:es)?|course|school|mail|email|inbox|calendar|events?|tasks?|news|upcoming)`;
const OWNER = String.raw`(?:my|the|a|an|your|today's|yesterday's|tonight's)`;
/**
 * "Brief" the noun: a briefing, "brief me", "my morning brief". Never the adjective: "keep it brief", "a brief
 * history of Rome", "a brief break", "the brief for the essay" (a topic takes "briefing", or "brief on/about").
 */
const BRIEF_NOUN = new RegExp(String.raw`^brief me\b|\bbriefings?\b|\b(?:${OWNER}\s+(?:${KIND_WORD}\s+){0,2}|(?:${KIND_WORD}\s+){1,2})brief(?=\s*$|\s+(?:on|about|today|tonight|yesterday|so far|again|now|since|from)\b)`, 'i');

/** Parse only a direct request, never a reminder or a request to send a brief.
 * Dates remain semantic here; the manager resolves them against its clock. */
export function briefingRequest(value) {
  let line = String(value ?? '').replace(/[’‘]/g, "'").trim().replace(/[.!?]+$/, '')
    .replace(/^(?:(?:hey|okay|ok)\s+)?jester[,!]?\s+/i, '')
    .replace(/^(?:please\s+)?(?:(?:can|could|would|will) you(?: please)?|I (?:want|need)(?: you)? to)\s+/i, '')
    .replace(/^please\s+/i, '').replace(/\s+please$/i, '').trim();
  if (!line || /^(?:remind|remember|forget|send|email|share|open|delete|schedule|don't|do not|stop|cancel|how (?:do|can|should))\b/i.test(line)) return null;
  const recap = /^(?:wrap up (?:my|the) day|recap (?:my|the) day|how did my day go)$/i.test(line);
  if (!recap && !BRIEF_NOUN.test(line)) return null;
  if (!recap && !/^(?:(?:read|reread|re-read|replay|repeat|give|show|tell|make|create|prepare|generate|update|refresh|get|brief me)\b|what(?:'s| is| was)\b|let(?:'s| me) hear\b|can I (?:get|have|hear)\b|I(?:'d| would) like\b|(?:(?:my|the|a|an|today's|yesterday's)\s+)?(?:morning|evening|nightly|daily|day's|end of day|Canvas|mail|email|calendar|events|news|brief(?:ing)?)\b)/i.test(line)) return null;
  const date = line.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]
    || (/\byesterday(?:'s)?\b/i.test(line) ? 'yesterday' : /\btoday(?:'s)?\b/i.test(line) ? 'today' : '');
  const range = /\b(?:today so far|whole day|day so far|all day|start of (?:the |my )?day|from (?:this )?morning)\b/i.test(line) ? 'today' : 'since-last';
  const refresh = /^(?:make|create|prepare|generate|update|refresh)\b/i.test(line) || /\b(?:updated|fresh|new|latest)\s+brief(?:ing)?\b/i.test(line);
  // "Brief me", "my briefing": the one he has for today, if there is one (requested); else, as ever, the morning's.
  const bare = /^(?:brief me|(?:my|the) brief(?:ing)?)$/i.test(line);
  let kind = recap || /\b(?:evening|nightly|wrap[- ]?up|recap|end of day)\b/i.test(line) ? 'evening'
    : /\b(?:morning|daily|day's)\b/i.test(line) || bare ? 'morning' : 'custom';
  let topic = kind === 'custom' ? line
    .replace(/^(?:read(?: me)?|reread|re-read|replay|repeat|give me|show me|tell me|make(?: me)?|create(?: me)?|prepare(?: me)?|generate(?: me)?|update|refresh|get(?: me)?|what(?:'s| is| was)|let(?:'s| me) hear|can I (?:get|have|hear)|I(?:'d| would) like|brief me)\s*/i, '')
    .replace(/\b(?:since (?:the )?(?:last time (?:we (?:talked|spoke)|I (?:talked|spoke)(?: to you)?)|our last (?:conversation|chat)|we last (?:talked|spoke))|today so far|the whole day(?: so far)?|whole day(?: so far)?|all day|day so far|from (?:the )?start of (?:the |my )?day|from (?:this )?morning)\b/ig, '')
    .replace(/\b(?:today|yesterday)(?:'s)?\b|\b\d{4}-\d{2}-\d{2}\b/ig, '')
    .replace(/\b(?:briefing|brief)\b/ig, '')
    .replace(/^(?:(?:my|the|a|an|updated|fresh|new|latest)\s+)+/i, '')
    .replace(/^(?:on|about|for|of)\s+/i, '').trim().replace(/\s+(?:on|about|for|of)$/i, '') : '';
  topic = safe(topic, 200);
  const latest = !refresh && (bare || (kind === 'custom' && !topic && range !== 'today'));
  return { kind, topic, range, refresh, ...(date ? { date } : {}), ...(latest ? { latest: true } : {}) };
}

function itemsOf(value) {
  const items = [];
  const seen = new Set();
  for (const [index, item] of (Array.isArray(value) ? value : []).slice(0, 80).entries()) {
    if (!item || typeof item !== 'object') continue;
    const title = safe(item.title, 200);
    if (!title) continue;
    const kind = ['event', 'task', 'mail', 'page', 'activity'].includes(item.kind) ? item.kind : 'activity';
    let id = tidy(item.id, 160) || `item-${index + 1}`;
    if (seen.has(id)) id = `${id.slice(0, 140)}-${index + 1}`;
    seen.add(id);
    const url = sourceAddress(item.url);
    // A subscription is a credential, never the event's Open destination.
    const address = url && !/(?:\.ics$|\/(?:ical|feeds?)(?:\/|$))/i.test(url.pathname) ? url.href : '';
    const detail = safeText(item.detail, 3000);
    items.push({ kind, id, title, ...(detail ? { detail } : {}),
      ...(safe(item.source, 200) ? { source: safe(item.source, 200) } : {}),
      ...(tidy(item.taskId, 160) ? { taskId: tidy(item.taskId, 160) } : {}),
      ...(typeof item.mailId === 'string' && /^[\da-f]{6,64}$/i.test(item.mailId) ? { mailId: item.mailId } : {}),
      ...(Number.isFinite(item.start) ? { start: item.start } : {}), ...(Number.isFinite(item.end) ? { end: item.end } : {}),
      ...(address ? { url: address } : {}) });
    if (items.length === 24) break;
  }
  return items;
}

const dateFor = (input, at) => {
  if (!input || input === 'today') return startOf(at);
  if (input === 'yesterday') { const date = new Date(at); return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime(); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return NaN;
  const date = new Date(`${input}T00:00:00`);
  return Number.isFinite(date.getTime()) && dayOf(date.getTime()) === input ? date.getTime() : NaN;
};

function historyOf(value, at) {
  return (Array.isArray(value) ? value : []).slice(-2000).map((entry) => ({ ...entry, time: typeof entry?.at === 'number' ? entry.at : Date.parse(entry?.at) }))
    .filter((entry) => !entry.hidden && Number.isFinite(entry.time) && entry.time <= at && ['you', 'jester'].includes(entry.who))
    .sort((a, b) => a.time - b.time);
}

function rangeFor(request, at, history) {
  const day = dateFor(request.date, at);
  if (!Number.isFinite(day)) throw new Error('That briefing date is not valid.');
  const next = new Date(day); next.setDate(next.getDate() + 1);
  const to = Math.min(at, next.getTime());
  if (day > at) throw new Error('A briefing cannot recap events that have not happened yet.');
  if (request.range === 'today' || day !== startOf(at)) return { from: day, to, mode: 'today', label: day === startOf(at) ? 'Today so far' : new Date(day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) };
  const latest = history.at(-1);
  let prior = [];
  if (latest?.chat) {
    const chats = new Map();
    for (const entry of history) {
      if (!entry.chat || entry.chat === latest.chat) continue;
      if (!chats.has(entry.chat)) chats.set(entry.chat, []);
      chats.get(entry.chat).push(entry);
    }
    // A timer, mail alert or briefing offer alone is not a conversation with
    // the user. Otherwise an unsolicited line would silently move the range.
    prior = [...chats.values()].filter((entries) => entries.some((entry) => entry.who === 'you'))
      .sort((a, b) => a.at(-1).time - b.at(-1).time).at(-1) || [];
  }
  else {
    // Logs predating chat IDs can still distinguish an earlier conversation by
    // the same long pause used to separate ordinary conversational sessions.
    const sessions = [];
    for (const entry of history) {
      if (!sessions.length || entry.time - sessions.at(-1).at(-1).time >= 30 * 60_000) sessions.push([]);
      sessions.at(-1).push(entry);
    }
    prior = sessions.slice(0, -1).filter((entries) => entries.some((entry) => entry.who === 'you')).at(-1) || [];
  }
  const from = prior.at(-1)?.time;
  return Number.isFinite(from) && from < at
    ? { from, to, mode: 'since-last', label: `Since our last conversation, ${new Date(from).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` }
    : { from: day, to, mode: 'since-last', fallback: true, label: 'Today so far; no earlier conversation was available' };
}

/** All authoritative content lives in main; renderers receive an immutable card
 * and send its ID back. Storage writes are ordered, including Forget. */
export function createBriefingManager({ storage, compose, composeCustom, history = () => [], now = Date.now, onChange = () => {}, given = async () => {}, newId = randomUUID }) {
  let records = [];
  let generation = 0;
  let writes = Promise.resolve();
  let starting = null;
  let ready = false;
  const composing = new Map();

  const notify = () => { try { onChange(); } catch { /* A view cannot undo a saved briefing. */ } };
  const current = (id) => records.find((record) => record.id === id);
  const prune = () => { records = records.filter((record) => record.createdAt >= now() - BRIEFING_KEEP_MS && record.createdAt <= now() + 60_000).slice(-60); };
  const persist = () => {
    prune();
    const mine = generation;
    const snapshot = clone(records);
    writes = writes.catch(() => undefined).then(() => mine === generation ? storage.set({ [BRIEFING_KEY]: { version: 1, records: snapshot } }) : undefined);
    return writes;
  };
  const card = (record, { offer = record?.status === 'offered' } = {}) => record ? ({ kind: 'brief', id: record.id, title: record.title,
    lines: [...record.lines], items: clone(record.items), offer: !!offer, status: record.status, ...(record.day ? { day: record.day } : {}) }) : null;
  const answer = (record, ok = true, reason = '') => ({ ok, record: clone(record), card: card(record), ...(reason ? { reason } : {}) });
  const saved = (request, day) => [...records].reverse().find((record) => record.day === day && record.kind === request.kind
    && (request.kind !== 'custom' || record.topic.toLowerCase() === tidy(request.topic).toLowerCase()
      && (request.range !== 'today' || record.range.mode === 'today')));

  function sound(record) {
    if (!record || typeof record !== 'object' || !KINDS.has(record.kind) || !tidy(record.id, 160) || !Number.isFinite(record.createdAt)) return null;
    const from = Number(record.range?.from), to = Number(record.range?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
    const text = safeText(record.text, 16000);
    const state = STATES.has(record.status) ? record.status : 'ready';
    return { id: tidy(record.id, 160), kind: record.kind, topic: safe(record.topic, 200), title: safe(record.title, 200) || 'Your briefing', text,
      plain: safeText(record.plain, 16000) || text,
      lines: (Array.isArray(record.lines) ? record.lines : []).map((line) => safeText(line, 2000)).filter(Boolean).slice(0, 24),
      items: itemsOf(record.items), mailIds: (Array.isArray(record.mailIds) ? record.mailIds : []).filter((id) => typeof id === 'string' && /^[\da-f]{6,64}$/i.test(id)).slice(0, 100),
      untrusted: record.untrusted === true, createdAt: record.createdAt, updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : record.createdAt,
      day: /^\d{4}-\d{2}-\d{2}$/.test(record.day || '') ? record.day : dayOf(record.createdAt),
      range: { from, to, mode: record.range.mode === 'today' ? 'today' : 'since-last', label: safe(record.range.label, 300), ...(record.range.fallback ? { fallback: true } : {}) },
      status: state === 'reading' ? 'ready' : state,
      ...(Number.isFinite(record.laterUntil) ? { laterUntil: record.laterUntil } : {}),
      ...(Number.isFinite(record.offeredAt) ? { offeredAt: record.offeredAt } : {}),
      ...(Number.isFinite(record.readAt) ? { readAt: record.readAt } : {}),
      ...(record.unready ? { unready: true } : {}), ...(record.missing ? { missing: true } : {}),
      // How many things the day holds ("three things today"), and the work he offered with it (offers.js).
      ...(Number.isInteger(record.count) && record.count >= 0 ? { count: Math.min(record.count, 99) } : {}),
      ...(Array.isArray(record.offerIds) && record.offerIds.length ? { offerIds: record.offerIds.filter((id) => typeof id === 'string' && id.length <= 80).slice(0, 3) } : {}),
      ...(Array.isArray(record.coverage) ? { coverage: record.coverage.map((line) => safeText(line, 2000)).filter(Boolean).slice(0, 24) }
        : safeText(record.coverage, 2000) ? { coverage: safeText(record.coverage, 2000) } : {}) };
  }

  async function start() {
    if (!starting) {
      const mine = generation;
      starting = Promise.resolve(storage.get(BRIEFING_KEY)).then((stored) => {
        if (mine !== generation) return;
        const value = stored?.[BRIEFING_KEY];
        records = (Array.isArray(value) ? value : Array.isArray(value?.records) ? value.records : []).map(sound).filter(Boolean);
        prune(); ready = true; notify();
      });
    }
    await starting;
  }

  async function make(request, { signal } = {}) {
    await start(); abort(signal);
    const at = now();
    const dayAt = dateFor(request.date, at);
    if (!Number.isFinite(dayAt)) throw new Error('That briefing date is not valid.');
    if (dayAt > at) throw new Error('A briefing cannot recap events that have not happened yet.');
    const day = dayOf(dayAt);
    const found = saved(request, day);
    if (found && !request.refresh && found.text && !found.unready) return clone(found);
    const key = JSON.stringify([request.kind, tidy(request.topic).toLowerCase(), request.range || 'since-last', day]);
    // Caller cancellation is independent: share only preparations with the same
    // signal, so an aborted older request cannot cancel a new request.
    const underway = composing.get(key);
    if (underway && underway.signal === signal) return clone(await underway.promise);
    const mine = generation;
    const run = (async () => {
      // Only a briefing of their own asking looks back over the conversations: the day's two never do.
      const entries = request.kind === 'custom' ? historyOf(await history(), at) : [];
      const range = request.kind === 'custom' ? rangeFor(request, at, entries)
        : { from: dayAt, to: Math.min(at, new Date(new Date(dayAt).getFullYear(), new Date(dayAt).getMonth(), new Date(dayAt).getDate() + 1).getTime()), mode: 'today', label: day === dayOf(at) ? 'Today' : new Date(dayAt).toLocaleDateString('en-US') };
      const latestChat = entries.at(-1)?.chat;
      const recent = entries.filter((entry) => entry.time >= range.from && entry.time <= range.to && (!latestChat || entry.chat !== latestChat))
        .slice(-300).map(({ who, text, at: when, chat }) => ({ who, text: safe(text, 4000), at: when, ...(chat ? { chat } : {}) })).filter((entry) => entry.text);
      abort(signal);
      let made;
      if (request.kind !== 'custom' && day !== dayOf(at)) {
        made = { text: `I don't have a saved ${request.kind} briefing for ${new Date(dayAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}.`, missing: true };
      } else made = request.kind === 'custom'
        ? await composeCustom({ topic: request.topic || '', from: range.from, to: range.to, rangeLabel: range.label, range, history: recent, request: clone(request), signal })
        : await compose(request.kind, { range, topic: request.topic || '', request: clone(request), signal });
      abort(signal);
      if (mine !== generation) throw Object.assign(new Error('Briefing was forgotten.'), { name: 'AbortError' });
      const record = sound({ ...made, id: newId(), kind: request.kind, topic: request.topic || '', title: made?.card?.title || made?.title || (request.kind === 'custom' ? request.topic ? `${request.topic} briefing` : 'Your briefing' : `Your ${request.kind} briefing`),
        lines: made?.card?.lines || made?.lines || [], items: made?.items || made?.card?.items || [],
        createdAt: at, updatedAt: now(), day, range, status: 'ready' });
      if (!record) throw new Error('The briefing could not be saved.');
      // Nothing to say (or the weather not in yet, to be tried again), or only that there's none saved for that day:
      // given back to be said, never kept, so no empty card waits on the shelf and nothing is offered.
      if (!record.text || record.missing) return { ...clone(record), id: '' };
      records.push(record);
      // An update replaces the one before it: off the shelf, never offered again, still there to read.
      const replaced = [];
      if (request.refresh) {
        for (const older of records) {
          if (older === record || older.day !== day || older.kind !== record.kind || !['ready', 'offered', 'later'].includes(older.status)) continue;
          if (request.kind === 'custom' && older.topic.toLowerCase() !== record.topic.toLowerCase()) continue;
          older.status = 'replaced'; older.updatedAt = now(); delete older.laterUntil;
          replaced.push(older.id);
        }
      }
      await persist();
      if (signal?.aborted && mine === generation && current(record.id) === record) {
        records = records.filter((entry) => entry !== record);
        await persist();
      }
      abort(signal);
      if (mine !== generation) throw Object.assign(new Error('Briefing was forgotten.'), { name: 'AbortError' });
      notify(); return { ...clone(record), ...(replaced.length ? { replaced } : {}) };
    })();
    composing.set(key, { signal, promise: run });
    try { return await run; } finally { if (composing.get(key)?.promise === run) composing.delete(key); }
  }

  async function respond(id, op, { token } = {}) {
    await start();
    const record = current(String(id));
    if (!record) return { ok: false, reason: 'This briefing is no longer saved.', record: null, card: null };
    if (token && token !== record.readToken) return answer(record, false, 'That reading has already ended.');
    const mine = generation;
    let complete = false;
    if (op === 'read') {
      if (record.status === 'reading') return answer(record, false, 'This briefing is already being read.');
      record.status = 'reading'; record.readToken = newId(); delete record.laterUntil;
    } else if (op === 'later') {
      // Read, dismissed, replaced or being read: nothing to ask about again.
      if (!['ready', 'offered', 'later'].includes(record.status)) return answer(record, false, 'This briefing isn’t waiting to be read.');
      record.status = 'later'; record.laterUntil = now() + BRIEFING_LATER_MS;
    } else if (op === 'dismiss') {
      // While it's being read, the reading goes on and ends it (read-complete or interrupted).
      if (record.status === 'reading') return answer(record, false, 'This briefing is being read.');
      record.status = 'dismissed'; delete record.laterUntil;
    } else if (op === 'interrupted') {
      if (record.status !== 'reading') return answer(record, false, 'This briefing is not being read.');
      record.status = 'ready'; delete record.readToken;
    } else if (op === 'read-complete') {
      if (record.status !== 'reading') return answer(record, record.status === 'read', 'This briefing is not being read.');
      record.status = 'read'; record.readAt = now(); complete = true;
    } else return answer(record, false, 'That briefing action is not supported.');
    record.updatedAt = now();
    const reading = record.readToken;
    await persist();
    if (mine !== generation || current(record.id) !== record) return { ok: false, reason: 'This briefing was forgotten.', record: null, card: null };
    if (complete && record.status === 'read' && record.readToken === reading && !record.missing) await given(record.kind, clone(record));
    if (mine !== generation || current(record.id) !== record) return { ok: false, reason: 'This briefing was forgotten.', record: null, card: null };
    notify(); return answer(record);
  }

  return {
    start,
    get ready() { return ready; },
    prepare: (kind, options = {}) => make({ kind: kind === 'evening' ? 'evening' : 'morning', topic: '', range: 'today', refresh: false }, options),
    async requested(request, options = {}) {
      if (!request || !KINDS.has(request.kind)) throw new Error('That is not a briefing request.');
      await start();
      if (request.latest && (!request.date || request.date === 'today')) {
        // At nine in the evening, "the briefing" is the evening's, once there is one.
        const today = dayOf(now());
        const kept = [...records].reverse().find((record) => record.day === today && record.kind !== 'custom' && record.text && record.status !== 'replaced');
        if (kept) return clone(kept);
      }
      return make({ kind: request.kind, topic: safe(request.topic, 200), range: request.range === 'today' ? 'today' : 'since-last', refresh: request.refresh === true, ...(request.date ? { date: String(request.date) } : {}) }, options);
    },
    async offer(id) {
      await start();
      const record = current(String(id));
      if (!record || !record.text || ['read', 'dismissed', 'reading', 'replaced'].includes(record.status) || record.status === 'later' && record.laterUntil > now()) return record ? clone(record) : null;
      record.status = 'offered'; record.offeredAt = now(); record.updatedAt = now(); delete record.laterUntil;
      const mine = generation;
      await persist();
      if (mine !== generation || current(record.id) !== record) return null;
      notify(); return clone(record);
    },
    respond,
    get: (id) => clone(current(String(id)) || null),
    list: () => { prune(); return clone([...records].reverse()); },
    pending: () => clone([...records].reverse().find((record) => record.status === 'offered') || null),
    card,
    async forgetAll() {
      generation++; records = []; composing.clear(); ready = true; notify();
      writes = writes.catch(() => undefined).then(() => typeof storage.remove === 'function' ? storage.remove(BRIEFING_KEY) : storage.set({ [BRIEFING_KEY]: { version: 1, records: [] } }));
      await writes;
    }
  };
}
