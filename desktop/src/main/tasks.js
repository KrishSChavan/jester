/**
 * The user's to-do list, reminders and timers, which Jester keeps: tasks.json
 * in the app's own folder, and his clock (clock.js) for anything with a time.
 *
 *   a task       something to do. It stays until the user ticks it off or
 *                removes it.
 *   a reminder   a task with a time: told when it comes (tell.js: said if
 *                they're there, held until they're back if not), and still on
 *                the list after, until they say it's done
 *   a day's task a task for a day with no time: nothing rings
 *   a timer      so many minutes from now: told when it's up, and then gone
 *
 * Only the user marks a task done: in the Tasks panel, or by saying so. The
 * model can ask for it ("task": {"op":"done"}), and it's done only when the
 * user's own words bear on that task, or say "done" right after its reminder
 * (bears()). The same goes for removing one and changing its time. A model
 * that picks the wrong task changes nothing.
 *
 * Timers are set, cancelled and asked after by the user's own words, with no
 * model in it (direct()): "set a timer for ten minutes" should work at once
 * and with any model. Everything else is the model's to put in "task", and
 * what's said back is how it went, from what was really kept, never the
 * model's own line: so the time he says is the time on the clock.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/** A task ticked off is shown for this long, then gone. */
export const DONE_KEPT_MS = 7 * 24 * 3600_000;
export const LONGEST_TIMER_MS = 24 * 3600_000;
/** After a reminder's told, what they say next may be about it ("done", "snooze ten minutes"). */
export const JUST_TOLD_MS = 3 * 60_000;
const MOST_TASKS = 300;
const MOST_TEXT = 200;
/** No reminder is set further ahead than a year. */
const LONGEST_IN_MIN = 366 * 24 * 60;
const MIN = 60_000;

const NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)`;
const UNIT = String.raw`(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)`;
/** "ten minutes", "an hour and a half", "1 hour 30 minutes", "two and a half minutes", "half an hour", "90 seconds". */
const DURATION = String.raw`(?:half an? ${UNIT}|${NUMBER}(?: and a half)? ?${UNIT}(?: and a half)?(?:(?:,? and|,)? ?${NUMBER} ?${UNIT}){0,2})`;

const numberOf = (word) => {
  const text = String(word).toLowerCase().trim();
  if (/^\d/.test(text)) return Number(text);
  return text.split(/[ -]/).reduce((sum, part) => sum + (NUMBERS[part] ?? NaN), 0);
};
const unitMs = (unit) => (/^s/i.test(unit) ? 1000 : /^m/i.test(unit) ? MIN : 3600_000);

/**
 * How long a phrase says: "ten minutes" → 600000, "an hour and a half" → 5400000.
 * @returns {number} ms, or NaN when it isn't a length of time
 */
export function durationOf(phrase) {
  const text = String(phrase ?? '').toLowerCase().trim();
  if (!new RegExp(`^${DURATION}$`, 'i').test(text)) return NaN;
  const half = /^half an? (\w+)$/.exec(text);
  if (half) return unitMs(half[1]) / 2;
  let total = 0;
  let last = 0;
  for (const part of text.matchAll(new RegExp(`(${NUMBER})( and a half)? ?(${UNIT})( and a half)?`, 'gi'))) {
    last = unitMs(part[3]);
    total += (numberOf(part[1]) + (part[2] ? 0.5 : 0)) * last + (part[4] ? last / 2 : 0);
  }
  return Number.isFinite(total) && total > 0 ? Math.round(total) : NaN;
}

/** "10 minutes", "1 hour 30 minutes", "45 seconds", "2 minutes 5 seconds": how long, said. */
export function spanWords(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  // Seconds only matter under ten minutes.
  const s = h || m >= 10 ? 0 : seconds % 60;
  const part = (n, word) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
  return [part(h, 'hour'), part(m, 'minute'), part(s, 'second')].filter(Boolean).join(' ') || '0 seconds';
}

/** A timer's name by its length: "10 minute timer", "1 hour 30 minute timer". */
const timerName = (ms) => `${spanWords(ms).replace(/s\b/g, '')} timer`;

/** Lower case, the recognizer's punctuation gone (a point between digits stays: "1.5"), "ten-minute" as two words. */
const plain = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/(?<!\d)\.|\.(?!\d)|[!?,;]+/g, ' ')
    .replace(/(\w)-(?=minute|second|hour|min|sec|hr)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
/** What may come before a request and change nothing about it. */
const POLITE = String.raw`(?:(?:hey|ok|okay|so|um|uh|jester|please|can you|could you|would you|will you|can we|let's|go ahead and) )*`;
const TIMER_VERB = String.raw`(?:set|start|begin|put on|put|give me|make|create|run|add|i need|i want|i'd like|i would like|we need)`;
const PLEASE = String.raw`(?: (?:please|thanks|thank you|now|starting now|on|up|going|running))*`;
/** Not what a timer is for: words that make the sentence a question, a denial or about something else. */
const NOT_A_NAME = /\b(?:what|which|why|how|who|is|are|was|did|does|do|don't|doesn't|didn't|not|no|any|that|this|every|each|it|has|have|had|you|your|i|we|he|she|they|there|set|start|stop|cancel|need|want)\b/;

/**
 * A timer asked for in the user's own words, and nothing else: "set a timer for ten minutes", "start a 5 minute
 * timer", "timer for 90 seconds", "set a pasta timer for 8 minutes". The whole sentence has to be the asking: one
 * that mentions a timer ("my oven has a ten minute timer"), denies one ("don't set a timer…"), asks about one, or
 * asks for more besides is the model's to make sense of.
 * @returns {{ms:number, name:string}|null}  name: what it's for, '' when not said
 */
export function timerAsked(text) {
  const line = plain(text);
  if (!/\btimer\b|\btime me\b/.test(line)) return null;
  const tail = String.raw`(?: (?:for|to) (?:the |my )?([a-z][a-z' ]{1,30}?))?${PLEASE}`;
  const forIt = new RegExp(`^${POLITE}(?:(${TIMER_VERB}) )?(?:(an?|another|one more|the|my) )?(?:([a-z']+(?: [a-z']+)?) )?timer (?:for|of) (${DURATION})${tail}$`).exec(line);
  const before = forIt ? null : new RegExp(`^${POLITE}(?:(${TIMER_VERB}) )?(?:(an?|another|one more|the|my) )?(${DURATION}) timer${tail}$`).exec(line);
  const timed = forIt || before ? null : new RegExp(`^${POLITE}time me (?:for )?(${DURATION})${PLEASE}$`).exec(line);
  const found = forIt ? { verb: forIt[1], article: forIt[2], called: forIt[3], span: forIt[4], purpose: forIt[5] } : before ? { verb: before[1], article: before[2], span: before[3], purpose: before[4] } : timed ? { verb: 'time', span: timed[1] } : null;
  if (!found) return null;
  // "The 5 minute timer", with nothing asked of it, is naming one, not asking for one.
  if (!found.verb && /^(?:the|my)$/.test(found.article || '')) return null;
  // "A second timer" is another one, not one second long.
  if (before && /^(?:a|one) second$/.test(found.span)) return null;
  const ms = durationOf(found.span);
  if (!Number.isFinite(ms) || ms < 1000 || ms > LONGEST_TIMER_MS) return null;
  const purpose = String(found.purpose || '').trim();
  // "For 45 minutes to an hour": two lengths is a question of which.
  if (purpose && (Number.isFinite(durationOf(purpose)) || NOT_A_NAME.test(purpose))) return /^(?:me|us)$/.test(purpose) ? { ms, name: '' } : null;
  const called = String(found.called || '').trim();
  if (called && NOT_A_NAME.test(called)) return null;
  const name = purpose || (/^(?:new|quick|short|second|third|little|other|extra|kitchen)$/.test(called) ? '' : called);
  return { ms, name };
}

/**
 * "Cancel the timer", "stop my timers", "cancel the pasta timer", and nothing else in the sentence.
 * @returns {{all:boolean, which:string}|null}
 */
export function timerCancelAsked(text) {
  const match = new RegExp(`^${POLITE}(?:cancel|stop|clear|delete|remove|kill|end|turn off|get rid of) (?:(all|both|every)(?: of)? ?)?(?:(?:the|my|that|those|this) )?(?:((?:[a-z0-9']+ ){1,3}?))?(timers?)${PLEASE}$`).exec(plain(text));
  if (!match) return null;
  const which = String(match[2] || '').trim();
  if (which && /\b(?:and|then|when|if|while|after|before|set|start|play|open|to|for|on|in|not)\b/.test(which)) return null;
  return { all: !!match[1] || (match[3] === 'timers' && !which), which };
}

/**
 * "How long is left on the timer", "how's the timer doing", "check the pasta timer"; or, `bare`, just "how long is
 * left?", which is about a timer only while one's running.
 * @returns {{which:string, bare:boolean}|null}
 */
export function timerLeftAsked(text) {
  const line = plain(text);
  const HOW = String.raw`how (?:long|much(?: time| longer)?)`;
  const WHICH = String.raw`(?:(?:the|my) )?(?:((?:[a-z0-9']+ ){1,3}?))?timers?`;
  const named =
    new RegExp(`^${POLITE}${HOW}(?: is| do i have| have i got| time is| is there)?(?: left| remaining| to go)? (?:on|for|in|with) ${WHICH}$`).exec(line) ||
    new RegExp(`^${POLITE}(?:how's|how is|how are|check on|check) ${WHICH}(?: doing| going)?$`).exec(line) ||
    new RegExp(`^${POLITE}${HOW} (?:does|do|has|have) ${WHICH} (?:have |got )?(?:left|remaining|to go)$`).exec(line);
  if (named) return /\b(?:and|then|when|if|should|set|start|not)\b/.test(named[1] || '') ? null : { which: String(named[1] || '').trim(), bare: false };
  return new RegExp(`^${POLITE}(?:${HOW}(?: is| do i have| have i got| is there)? (?:left|remaining|to go)|(?:what's |what is )?(?:the )?time (?:left|remaining))$`).test(line) ? { which: '', bare: true } : null;
}

/** Words that may be about the list, a reminder or a timer: then the model's shown them, and waited for before he speaks. */
export const TASK_WORDS =
  /\b(?:remind(?:er|ers|ed|ing)?|timers?|alarms?|to-do(?:s| list)?|todos?(?: list)?|to do list|tasks?|my list|the list|on my plate|checklist|snooze|overdue|tick(?:ed)?(?: that| it)? off|check(?:ed)?(?: that| it)? off|cross(?:ed)?(?: that| it)? off|mark(?:ed)? (?:it|that|them|\w+ )?(?:as )?(?:done|complete|finished)|what (?:do|did) i (?:have|need|still have|still need) to (?:do|get done)|what(?:'|’)?s left (?:to do|for me)|anything (?:due|to do|i need to do)|don(?:'|’)?t let me forget|make sure i|nudge me|ping me|wake me)\b/i;
/**
 * Asked for a task, reminder or timer, in the user's own words: only then is one made. "To do" alone is a verb ("so
 * much to do"), so it's the list that has to be named.
 */
const ADD_WORDS =
  /\b(?:remind (?:me|us)|(?:an?|another|the|my|new) (?:reminder|alarm|timer)|reminder (?:for|to|about)|timers?|alarm|(?:to|on|onto) (?:my|the|our) (?:to-do(?: list)?|to do list|todos?(?: list)?|list|tasks?|task list|checklist)|(?:my|the|our) (?:to-do list|to do list|todo list|task list)|as a task|new task|add (?:a |another )?task|don(?:'|’)?t let me forget|make sure i|nudge me|ping me|wake me|tell me (?:in|at|when)|let me know (?:in|at|when)|alert me|snooze)\b/i;
/** A list of another kind is a note, not his to-do list. */
const OTHER_LIST = /\b(?:shopping|grocery|groceries|packing|reading|watch|wish|play|guest|bucket|christmas|birthday)[- ]?lists?\b/i;
/** A question about the list isn't asking for something on it. */
const QUESTION = /^(?:what|how|when|where|which|who|why|is|are|am|does|did|do i|have i|has|any)\b/i;
/** His line offering one ("Want me to remind you?"), to which "yes" is asking. */
const OFFERED = /\b(?:remind(?:er)?|timer|alarm|to[- ]?do|your list|task)\b[^.!]*\?/i;
/** His own questions about one he's been asked for: whatever's said next is the answer. */
const HIS_QUESTION = /\b(?:What should I put on your list|When should it be|When should I remind you|When should that be for|How long should the timer be)\b/;
const YES = /^(?:yes|yeah|yep|yup|sure|please|ok(?:ay)?|do (?:it|that)|go ahead|sounds good|that(?:'|’)?d be great|absolutely|definitely)\b/i;
/** Asked to have something kept, in words that don't say where: a task, if the task is what they said. */
const KEEP_WORDS = /\b(?:write (?:\w+ )?down|jot|note (?:that|down)|make a note|keep track|put (?:\w+ )?down|add|put)\b/i;
/** A question, by how it starts or ends. */
const ASKING = /^(?:what|how|when|where|which|who|why|is|are|am|do|does|did|can|could|would|will|should|have|has|any)\b|\?\s*$/i;
/** Words that say a thing isn't done yet, whatever else they share with it. */
const NOT_DONE = /\b(?:not|never|still|yet|need to|needs to|have to|has to|got to|gotta|should|must|going to|gonna|want to|will|tomorrow|later)\b|n['’]t\b|\bi['’]ll\b/i;
const DONE_WORDS = /\b(?:done|did (?:it|that|them)|i(?:'ve|’ve| have)? (?:just |already |finally )?did|finished|completed?|tick(?:ed)?|check(?:ed)? (?:it|that) off|cross(?:ed)?|handled|sorted|took care|taken care)\b/i;
const DROP_WORDS = /\b(?:cancel|remove|delete|drop|scrap|never ?mind|forget|take (?:\w+ ){1,5}off|get rid|don(?:'|’)?t need)\b/i;
const MOVE_WORDS = /\b(?:snooze|later|again|push|move|postpone|reschedule|change|instead|make (?:it|that)|in (?:\w+ )?(?:minutes?|hours?)|remind me)\b/i;
/** Words that name nothing: said alone after a reminder, or to his question about one task, they're about that one. */
const PLAIN_WORDS = new Set(
  "ok okay yes yeah yep yup sure please thanks thank you cool great alright right fine good got it that this one it's its is i i've i'm have did do done finished all already just now the a an for in at to me my snooze again later remind push move postpone back by until till tomorrow tonight today morning afternoon evening noon midnight minutes minute hours hour half and seconds second mins min am pm o'clock cancel remove delete drop forget never mind scrap tick ticked check checked cross crossed mark marked off complete completed handled sorted jester hey with can could would on of make past quarter that's thats yea so well actually then too them those both was were been be there".split(' ')
);
const onlyPlain = (said) => {
  const words = plain(said).match(/[a-z0-9':.]+/g) || [];
  return words.length > 0 && words.length <= 10 && words.every((word) => PLAIN_WORDS.has(word) || /^\d[\d:.]*$/.test(word) || NUMBERS[word] !== undefined);
};

const FILLER = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'to', 'of', 'for', 'and', 'or', 'that', 'this', 'it', 'one', 'on', 'in', 'at', 'with', 'about', 'from', 'task', 'tasks', 'reminder', 'reminders', 'todo', 'list', 'thing', 'item', 'i', 'me', 'you', 'is', 'was', 'be', 'have', 'has', 'had', 'did', 'done', 'do', 'just', 'already', 'please', 'off', 'up', 'out', 'some', 'get', 'got', 'go', 'need', 'mark', 'tick', 'check', 'cancel', 'remove', 'delete', 'finished', 'again', 'later']);
const TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
/**
 * The words that say which task: the first four letters of each that isn't filler, so "called" meets "call". A
 * number is kept whole and as digits, so "the ten minute one" is the 10 minute timer and not the 20.
 */
export function stems(text) {
  const line = String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(new RegExp(`\\b(${TENS})[ -](one|two|three|four|five|six|seven|eight|nine)\\b`, 'g'), (_all, tens, units) => String(NUMBERS[tens] + NUMBERS[units]))
    .replace(/\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, (word) => String(NUMBERS[word]));
  return new Set(
    (line.match(/[a-z0-9']+/g) || [])
      .map((word) => word.replace(/'s$/, ''))
      .filter((word) => (word.length > 1 || /\d/.test(word)) && !FILLER.has(word))
      .map((word) => (/^\d+$/.test(word) ? word : word.slice(0, 4)))
  );
}
const shared = (a, b) => [...a].filter((word) => b.has(word)).length;

const clockWords = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ');
const dayStart = (ms, days = 0) => {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
};

/** "today", "tomorrow", "yesterday", "on Friday", "on Friday, Nov 27". */
export function dayWords(ms, at) {
  const gap = Math.round((dayStart(ms) - dayStart(at)) / 864e5);
  if (gap === 0) return 'today';
  if (gap === 1) return 'tomorrow';
  if (gap === -1) return 'yesterday';
  const day = new Date(ms).toLocaleDateString('en-US', { weekday: 'long' });
  return gap > 1 && gap < 7 ? `on ${day}` : `on ${day}, ${new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** When a task is for, said: "at 3:00 PM", "tomorrow at 9:00 AM", "on Friday". */
export function dueWords(task, at) {
  if (!Number.isFinite(task?.due)) return '';
  if (task.allDay) return dayWords(task.due, at);
  const day = dayWords(task.due, at);
  return day === 'today' ? `at ${clockWords(task.due)}` : `${day} at ${clockWords(task.due)}`;
}

/**
 * The time a model gave: `at` "YYYY-MM-DD HH:MM" (or with a T, or with AM/PM), or just the date for a day with no
 * time; or `in`, minutes from now. Read as this computer's own time.
 * @returns {{due:number, allDay:boolean}|null|'past'}  null: no time given, or not one that can be read
 * @param {{past?:boolean}} [options]  past: a time gone by is given like any other, not as 'past'
 */
function readWhen(request, now, { past = false } = {}) {
  const minutes = Number(request?.in);
  if (Number.isFinite(minutes) && minutes > 0 && minutes <= LONGEST_IN_MIN) return { due: now + Math.round(minutes * MIN), allDay: false };
  const text = String(request?.at ?? '').trim();
  if (!text) return null;
  // The whole of it has to be a date, a time or both: "2026-11-16 at 3pm", "2026-11-16, 15:00", "3pm".
  const match = /^(?:(\d{4})-(\d{1,2})-(\d{1,2}))?[T ,]*(?:at )?(?:(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(?:([ap])\.?m\.?)?)?$/i.exec(text);
  if (!match || (match[1] === undefined && match[4] === undefined)) return null;
  const today = new Date(now);
  const [year, month, day] = match[1] === undefined ? [today.getFullYear(), today.getMonth(), today.getDate()] : [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  // A day there isn't (February 30th) is no day, not the one it rolls over to.
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  if (match[4] === undefined) {
    const due = date.getTime();
    return due < dayStart(now) && !past ? 'past' : { due, allDay: true };
  }
  let hour = Number(match[4]);
  const minute = Number(match[5] || 0);
  const half = (match[6] || '').toLowerCase();
  if (half && (hour < 1 || hour > 12)) return null;
  if (half === 'p' && hour < 12) hour += 12;
  if (half === 'a' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const due = new Date(year, month, day, hour, minute).getTime();
  // A minute's grace: "now" by the time it's read. `past`: given all the same, for whenAsked to put right.
  return due < now - MIN && !past ? 'past' : { due, allDay: false, ...(half || hour >= 12 ? {} : { loose: true }), ...(match[1] === undefined ? { dateless: true } : {}) };
}

/**
 * The time a model gave, as when a task is due. See readWhen: this is it without its notes on how it was written.
 * @returns {{due:number, allDay:boolean}|null|'past'}
 */
export function whenOf(request, now, options) {
  const read = readWhen(request, now, options);
  return read && read !== 'past' ? { due: read.due, allDay: read.allDay } : read;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY = WEEKDAYS.join('|');
/** Their words give a time of day or a length of time: "at 3", "5 pm", "noon", "this evening", "in twenty minutes". */
const CLOCK_WORDS = new RegExp(String.raw`\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.?|p\.m\.?|o['’]?clock)|\bat (?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midnight)|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight|midday|morning|afternoon|evening|tonight|half past|quarter (?:to|past)|lunch(?:time)?|dinner(?:time)?|bedtime)\b|\b${DURATION}\b`, 'i');
/** …or a day: "tomorrow", "on Friday", "next week", "November 20th", "the 20th", "11/20", "in ten days". */
const DAY_WORDS = new RegExp(String.raw`\b(?:today|tonight|tomorrow|${DAY}|weekend|next (?:week|month)|this week|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}|\d{1,2}(?:st|nd|rd|th)|\d{1,2}/\d{1,2}|(?:in )?${NUMBER} (?:days?|weeks?|months?)(?: from (?:now|today))?)\b`, 'i');
const TODAY_WORDS = /\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i;
const REPEAT_WORDS = /\b(?:every|each|daily|weekly|nightly|every ?day|weekdays)\b/i;
/** Before this hour, "tomorrow" is the day that's about to dawn: said at half past midnight, it means after some sleep. */
const NIGHT_ENDS = 4;

/**
 * The day their words name, when they name just one plainly: "tomorrow", "the day after tomorrow", "tonight", "on
 * Friday", "Friday at 3". Then it's that day, whatever date a model worked out (qwen3.5:9b made "tomorrow" the day
 * after, 1 in 3).
 * @returns {number|null} that day's midnight; null when none is named, or more than one
 */
export function dayIn(said, at) {
  const line = String(said ?? '').toLowerCase();
  const found = new Set();
  // Counted from the day they're still in: at 12:30 AM that's yesterday's, so "tomorrow" is today by the calendar.
  const from = new Date(at).getHours() < NIGHT_ENDS ? at - NIGHT_ENDS * 3600_000 : at;
  if (/\bday after tomorrow\b/.test(line)) found.add(dayStart(from, 2));
  else if (/\btomorrow\b/.test(line)) found.add(dayStart(from, 1));
  if (TODAY_WORDS.test(line)) found.add(dayStart(at));
  const named = new RegExp(String.raw`\b(on|this|next|by|for|until|till|coming) (${DAY})\b|\b(${DAY}) (?:at|morning|afternoon|evening|night)\b`, 'g');
  for (const match of line.matchAll(named)) {
    const gap = (WEEKDAYS.indexOf(match[2] || match[3]) - new Date(at).getDay() + 7) % 7;
    // "This Sunday", said on a Sunday, is today; "on Sunday" or "next Sunday" is the one coming.
    found.add(dayStart(at, gap || (match[1] === 'this' ? 0 : 7)));
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * When a task is for, from what a model gave and what the user actually said. A model's time counts only when
 * their words (or his offer they said yes to) hold one, outside what the task itself is: asked to "add buy stamps
 * to my to-do list", qwen3.5:9b gave it this very minute. "In twenty minutes" is theirs, as they said it. A day
 * they named plainly is that day; a day with no time of day is the day, with no time; and a time already gone
 * today, when they didn't say today, is this evening's if it was given without AM or PM, or tomorrow's.
 * @param {string} [what]  the task's own words: a time in those ("buy a dinner gift") isn't when it's for
 * @returns {{due:number, allDay:boolean}|null|'past'|'unclear'}  null: they gave no time; 'unclear': they did, and
 *   the model's can't be read
 */
export function whenAsked(request, said, last, now, what = '') {
  const its = new Set((String(what).toLowerCase().match(/[a-z']{3,}/g) || []));
  const outside = String(said ?? '').replace(/[a-z'’]{3,}/gi, (word) => (its.has(word.toLowerCase()) ? ' ' : word));
  const words = `${outside} ${OFFERED.test(String(last ?? '')) || HIS_QUESTION.test(String(last ?? '')) ? last : ''}`;
  const clocky = CLOCK_WORDS.test(words);
  const day = dayIn(outside, now);
  if (!clocky && day === null && !DAY_WORDS.test(words)) return null;
  // "In ten minutes", "for ten minutes": theirs, as they said it, whatever a model made of it ("at":"in 10", or
  // 5:48 for 5:48 PM).
  const span = new RegExp(String.raw`\b(?:in|for) (${DURATION})\b`, 'i').exec(outside)?.[1];
  if (span && Number.isFinite(durationOf(span.toLowerCase()))) return { due: now + durationOf(span.toLowerCase()), allDay: false };
  const minutes = Number(request?.in);
  if (Number.isFinite(minutes) && minutes > 0) return whenOf(request, now) || 'unclear';
  const given = readWhen(request, now, { past: true });
  if (!given) return day === null || clocky ? 'unclear' : { due: day, allDay: true };
  const date = new Date(given.dateless || day !== null ? (day ?? dayStart(now)) : given.due);
  const time = new Date(given.due);
  if (given.allDay || !clocky) {
    const due = dayStart(date.getTime());
    return due < dayStart(now) ? 'past' : { due, allDay: true };
  }
  const on = (days, hours = 0) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, time.getHours() + hours, time.getMinutes()).getTime();
  let due = on(0);
  if (due < now - MIN && dayStart(due) === dayStart(now) && !TODAY_WORDS.test(words)) {
    // "At 5", said at a quarter past five: this evening's if it could be, else tomorrow's.
    const evening = given.loose && !/\b(?:am|a\.m\.?|morning)\b/i.test(words) ? on(0, 12) : NaN;
    due = evening > now ? evening : on(1);
  }
  return due < now - MIN ? 'past' : { due, allDay: false };
}

/** What "remind me … to …" is to remind them of, said back to them: "check the oven", "call your mom". '' when the words don't say. */
export function reminderText(said) {
  const rest = /\bremind me\b(.*)$/i.exec(String(said ?? ''))?.[1] ?? '';
  const what = /\b(?:to|about|that)\s+(.+)$/i.exec(rest)?.[1] ?? '';
  return what
    .replace(new RegExp(String.raw`\s+(?:in ${DURATION}|at \d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow|tonight|today|later)\W*$`, 'i'), '')
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bmyself\b/gi, 'yourself')
    .replace(/\bI['’]m\b/g, 'you’re')
    .replace(/\b(?:I|me)\b/g, 'you')
    .replace(/[.!?]+$/, '')
    .trim();
}

const tidy = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"“”'‘’-]+|[\s"“”'‘’.!-]+$/g, '')
    .slice(0, MOST_TEXT);
const capital = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/**
 * @param {object} deps
 * @param {string} deps.file  tasks.json
 * @param {{add:Function, remove:Function}} deps.clock  clock.js: a job of kind "task", {id}, for each one with a time
 * @param {() => void} [deps.onChange]  the list changed: his window's panel is told
 */
export function createTasks({ file, clock, fs = nodeFs, now = Date.now, log = () => undefined, onChange = () => undefined }) {
  /** @type {{id:string, text:string, made:number, due?:number, allDay?:boolean, timer?:number, told?:number, done?:number}[]} */
  let tasks = [];
  let serial = 0;
  /** The reminder told last, and when: what's said next may be about it. */
  let lastTold = { id: '', at: 0 };
  /** When he last asked them something about the list ("Which one?", "When should it be?"): what's said next answers it. */
  let askedAt = 0;
  /** He's asked which timer to cancel: the next few words may be just its name. */
  let cancelAskedAt = 0;

  function write() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const next = `${file}.tmp`;
      fs.writeFileSync(next, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(next, file);
    } catch (err) {
      log('tasks: couldn’t keep the list:', err.message);
    }
  }

  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(stored?.tasks)) tasks = stored.tasks.filter((task) => task && typeof task.id === 'string' && typeof task.text === 'string' && Number.isFinite(task.made));
  } catch {
    /* none yet */
  }

  const jobId = (id) => `task-${id}`;
  /** A task's place on the clock: on it while it's open with a time still to be told, off it otherwise. */
  function schedule(task) {
    const rings = !task.done && !task.told && Number.isFinite(task.due) && !task.allDay;
    if (rings) return !!clock.add({ id: jobId(task.id), kind: 'task', at: task.due, payload: { id: task.id } });
    clock.remove(jobId(task.id));
    return true;
  }

  function changed() {
    const limit = now() - DONE_KEPT_MS;
    tasks = tasks.filter((task) => !task.done || task.done >= limit);
    write();
    onChange();
  }

  const open = () => tasks.filter((task) => !task.done);
  const byDue = (a, b) => (a.due ?? Infinity) - (b.due ?? Infinity) || a.made - b.made;

  function add({ text, due, allDay = false, timer = 0 }) {
    const line = tidy(text);
    if (!line || open().length >= MOST_TASKS) return null;
    const task = { id: `${now().toString(36)}${(serial++).toString(36)}`, text: line, made: now(), ...(Number.isFinite(due) ? { due, ...(allDay ? { allDay: true } : {}) } : {}), ...(timer ? { timer } : {}) };
    tasks.push(task);
    // A clock with no room for it can't ring: then it isn't kept as if it would.
    if (!schedule(task)) {
      tasks = tasks.filter((item) => item !== task);
      log('tasks: the clock had no room, so that wasn’t kept');
      return null;
    }
    changed();
    return task;
  }

  function remove(id) {
    const task = tasks.find((item) => item.id === id);
    if (!task) return null;
    tasks = tasks.filter((item) => item !== task);
    clock.remove(jobId(id));
    changed();
    return task;
  }

  /**
   * Which open task `which` means: the one sharing most of its telling words, if one stands out.
   * @returns {{one:object|null, many:object[]}}
   */
  function match(which, pool = open()) {
    const want = stems(which);
    if (!want.size) return { one: null, many: [] };
    const scored = pool.map((task) => ({ task, hits: shared(want, stems(task.text)) })).filter((item) => item.hits > 0);
    if (!scored.length) return { one: null, many: [] };
    const best = Math.max(...scored.map((item) => item.hits));
    const top = scored.filter((item) => item.hits === best).map((item) => item.task);
    return top.length === 1 ? { one: top[0], many: [] } : { one: null, many: top.sort(byDue) };
  }

  /**
   * Whether the user's own words are about this task: they share a telling word with it, or they're the kind of
   * words `saying` looks for ("done", "snooze") said right after its reminder, or with his last line naming it.
   */
  function bears(task, said, last, saying, op) {
    const line = String(said);
    if (about(task, stems(line)) > 0) {
      // They name it. A question about it, or words that say it isn't done, don't tick it; taking it off or moving
      // it has to be asked for.
      if (QUESTION.test(line.trim())) return false;
      return op === 'done' ? !NOT_DONE.test(line) : saying.test(line);
    }
    // They don't name it: then only a few plain words, said right after its reminder or to his question naming it.
    if (!onlyPlain(line)) return false;
    if (String(last).includes(`“${task.text}”`)) return saying.test(line) || YES.test(line.trim()) || CLOCK_WORDS.test(line) || DAY_WORDS.test(line);
    // …or to a line of his that named this one and no other ("You still have call the dentist on your list").
    const his = stems(last);
    const namedByHim = open().filter((item) => about(item, his) > 0);
    if (namedByHim.length === 1 && namedByHim[0] === task) return saying.test(line);
    return lastTold.id === task.id && now() - lastTold.at <= JUST_TOLD_MS && saying.test(line);
  }

  function markDone(id, on = true) {
    const task = tasks.find((item) => item.id === id);
    if (!task || task.timer) return null;
    if (on) task.done = now();
    else {
      delete task.done;
      // Put back after its time: it's overdue, not something to be told about out of nowhere.
      if (Number.isFinite(task.due) && !task.allDay && task.due < now() && !task.told) task.told = now();
    }
    schedule(task);
    changed();
    return task;
  }

  function moveTo(id, { due, allDay = false }) {
    const task = tasks.find((item) => item.id === id);
    if (!task || task.timer || !Number.isFinite(due)) return null;
    task.due = due;
    if (allDay) task.allDay = true;
    else delete task.allDay;
    delete task.told;
    schedule(task);
    changed();
    return task;
  }

  /**
   * How far words are about a task: the share of its telling words they hold, and 0 unless that's half of them and
   * its last one is among them. The last is what it's of ("call the dentist", "call the bank"): "I called the
   * dentist" is about one of those, not both.
   */
  function about(task, words) {
    // A timer's last word is "timer", which says nothing of which: it's known by the rest.
    const its = [...stems(task.text)].filter((word) => !(task.timer && word === 'time'));
    if (!its.length || !words.has(its.at(-1))) return 0;
    const share = its.filter((word) => words.has(word)).length / its.length;
    return share >= 0.5 ? share : 0;
  }

  /** The one open task the user's own words are plainly about: they hold at least half its telling words, and more of its than of any other's. */
  function theirsIn(said, pool = open()) {
    const words = stems(said);
    const fits = pool
      .map((task) => ({ task, share: about(task, words) }))
      .filter((item) => item.share > 0);
    if (!fits.length) return null;
    const best = Math.max(...fits.map((item) => item.share));
    const top = fits.filter((item) => item.share === best);
    return top.length === 1 ? top[0].task : null;
  }

  const timers = () => open().filter((task) => task.timer).sort(byDue);
  const leftWords = (task) => (task.due > now() ? `${spanWords(task.due - now())} left` : 'up');
  const named = (task) => `“${task.text}”`;
  const either = (many) => (many.length === 2 ? `${named(many[0])} or ${named(many[1])}` : `${many.slice(0, 3).map(named).join(', ')}${many.length > 3 ? ', or another' : ''}`);

  function startTimer(ms, name = '') {
    const label = tidy(name);
    const task = add({ text: label ? `${capital(label)} timer` : capital(timerName(ms)), due: now() + ms, timer: ms });
    if (!task) return 'I couldn’t set that timer.';
    log(`tasks: a timer for ${spanWords(ms)}`);
    return `${capital(spanWords(ms))}${label ? `, for the ${label}` : ''}, starting now.`;
  }

  /** `asked`: {all, which} (timerCancelAsked). '' when it names a timer that isn't one of his: the model's, then. */
  function cancelTimers(asked) {
    const running = timers();
    if (!running.length) return asked.which ? '' : 'There’s no timer running.';
    const picked = asked.which ? match(asked.which, running).one : running.length === 1 ? running[0] : null;
    if (asked.which && !picked && !asked.all) return '';
    if (!asked.all && !picked) {
      cancelAskedAt = now();
      return `You have ${running.length} running: ${running.map((task) => `${task.text.replace(/ timer$/i, '')}, ${leftWords(task)}`).join('; ')}. Which one?`;
    }
    const gone = asked.all ? running : [picked];
    for (const task of gone) remove(task.id);
    log(`tasks: ${gone.length} timer(s) cancelled`);
    return gone.length === 1 ? `Cancelled, with ${leftWords(gone[0])}.` : `All ${gone.length} timers cancelled.`;
  }

  /** `asked`: {which, bare} (timerLeftAsked). */
  function timersLeft(asked) {
    const running = timers();
    if (!running.length) return asked.bare || asked.which ? '' : 'There’s no timer running.';
    const lower = (task) => task.text.replace(/^\w/, (letter) => letter.toLowerCase());
    if (asked.which) {
      const picked = match(asked.which, running).one;
      return picked ? `${capital(leftWords(picked))} on your ${lower(picked)}.` : '';
    }
    if (running.length === 1) return `${capital(leftWords(running[0]))} on your ${lower(running[0])}.`;
    return running.map((task) => `${capital(leftWords(task))} on the ${lower(task)}`).join(', and ') + '.';
  }

  /** What he says is noted when it's a question of his about the list: what's said next is its answer. */
  const asking = (line) => {
    if (/\?$/.test(String(line))) askedAt = now();
    return line;
  };

  function applied(request, { said, last = '' }) {
      let op = String(request?.op ?? '').toLowerCase();
      let which = tidy(request?.text);
      const at = now();
      // A model's "timer" for what was a reminder, or a snooze: qwen3.5:9b gives one for "remind me in twenty
      // minutes to check the oven" (2 in 3), which would say time's up and not what for.
      if (op === 'timer' && /\bremind/i.test(String(said))) {
        op = 'add';
        which = /timer/i.test(which) ? '' : which;
        which ||= tidy(reminderText(said));
      } else if (op === 'timer' && /\b(?:snooze|again)\b/i.test(String(said)) && lastTold.id && at - lastTold.at <= JUST_TOLD_MS && tasks.some((task) => task.id === lastTold.id && !task.done)) {
        op = 'move';
        which = '';
      }
      if (op === 'timer') {
        const ms = Math.round(Number(request?.in) * MIN);
        if (!Number.isFinite(ms) || ms < 1000 || ms > LONGEST_TIMER_MS) return 'How long should the timer be?';
        return startTimer(ms, /timer/i.test(which) ? '' : which);
      }
      if (op === 'add') {
        if (!which) return 'What should I put on your list?';
        const when = whenAsked(request, said, last, at, which);
        if (when === 'past') return 'That time has already gone by, so I haven’t set it. When should it be?';
        // They gave a time and it didn't come through: asked for, not left off.
        if (when === 'unclear') return 'When should it be for? I didn’t catch the time.';
        const twin = open().find((task) => !task.timer && task.text.toLowerCase() === which.toLowerCase() && (task.due ?? 0) === (when?.due ?? 0));
        if (twin) return `That’s already on your list${twin.due ? `, ${dueWords(twin, at)}` : ''}.`;
        const task = add({ text: capital(which), ...(when || {}) });
        if (!task) return 'Your list is full, so I couldn’t add that.';
        log(`tasks: added one${task.due ? (task.allDay ? ' for a day' : ' with a time') : ''}`);
        if (!task.due) return `Added to your list: ${task.text}.`;
        // Asked for every morning, they get the once, and are told so.
        const once = REPEAT_WORDS.test(String(said)) ? ' Just the once, though: I can’t repeat a reminder yet.' : '';
        return (task.allDay ? `Added to your list for ${dayWords(task.due, at).replace(/^on /, '')}: ${task.text}.` : `Okay, I’ll remind you ${dueWords(task, at)}: ${task.text}.`) + once;
      }
      if (op !== 'done' && op !== 'remove' && op !== 'move') return '';
      const pool = op === 'done' ? open().filter((task) => !task.timer) : open();
      const found = which ? match(which, pool) : { one: tasks.find((task) => task.id === lastTold.id && !task.done) || null, many: [] };
      if (found.many.length) return `Which one: ${either(found.many)}?`;
      const saying = op === 'done' ? DONE_WORDS : op === 'remove' ? DROP_WORDS : MOVE_WORDS;
      // Only the user says a thing is done, gone or moved: their words have to be about it. When the model's pick
      // isn't the one their words are about, the one they are about is the one meant ("I emailed Sarah").
      let task = found.one;
      if (!task || !bears(task, said, last, saying, op)) {
        const theirs = theirsIn(said, pool);
        if (theirs && bears(theirs, said, last, saying, op)) task = theirs;
        // Words that weren't asking for this at all ("what's on my list?") leave the list alone, and him to answer.
        // Said as a statement, they may have meant it ("I rang my mother", of "Call your mom"): then he asks.
        else if ((!saying.test(String(said)) && (!task || op !== 'done' || ASKING.test(String(said).trim()))) || QUESTION.test(String(said).trim()) || (op === 'done' && NOT_DONE.test(String(said)) && !DONE_WORDS.test(String(said)))) return (log(`tasks: a model’s “${op}” their words didn’t ask for was left undone`), '');
        else if (!task) return which ? `I don’t see “${which}” on your list.` : 'Which one do you mean?';
        else return `Do you mean ${named(task)}? Say which one and I’ll ${op === 'done' ? 'tick it off' : op === 'remove' ? 'take it off' : 'move it'}.`;
      }
      if (op === 'done') {
        markDone(task.id);
        log('tasks: one ticked off, by their saying so');
        return `Ticked off: ${task.text}.`;
      }
      if (op === 'remove') {
        const left = task.timer ? leftWords(task) : '';
        remove(task.id);
        log(`tasks: ${task.timer ? 'a timer cancelled' : 'one removed'}`);
        return task.timer ? `Cancelled, with ${left}.` : `Removed from your list: ${task.text}.`;
      }
      if (task.timer) return 'A timer can’t be moved: cancel it and set another.';
      const when = whenAsked(request, said, last, at, task.text);
      if (when === 'past') return 'That time has already gone by. When should it be?';
      if (!when || when === 'unclear') return `When should I remind you about ${named(task)}?`;
      moveTo(task.id, when);
      log('tasks: one moved');
      return when.allDay ? `Moved to ${dayWords(when.due, at).replace(/^on /, '')}: ${task.text}.` : `Okay, I’ll remind you ${dueWords(task, at)}: ${task.text}.`;
    }

  return {
    /** The list as his window shows it: timers running, what's open (soonest first, then what has no time), and what was done lately. */
    list() {
      const at = now();
      return {
        now: at,
        timers: timers().map(({ id, text, due, timer }) => ({ id, text, due, timer })),
        open: open().filter((task) => !task.timer).sort(byDue).map((task) => ({ ...task, when: dueWords(task, at), overdue: Number.isFinite(task.due) && (task.allDay ? task.due < dayStart(at) : task.due < at) })),
        done: tasks.filter((task) => task.done).sort((a, b) => b.done - a.done).slice(0, 30).map((task) => ({ ...task }))
      };
    },
    get: (id) => tasks.find((task) => task.id === id) || null,
    /** How many are open, timers aside: for the button that opens the panel. */
    get count() {
      return open().filter((task) => !task.timer).length;
    },
    add,
    remove,
    /** Ticked off, or put back (`on` false): the user's doing, in the panel or by saying so. */
    done: markDone,
    /** A new time: it rings again then. */
    move: moveTo,
    /**
     * What he says when a task's time comes; '' when there's nothing to say (it's done, or gone). `meant`: when it
     * was for, if it's being told late (they were away): then it says so.
     */
    ringLine(id, meant = NaN) {
      const task = tasks.find((item) => item.id === id);
      if (!task || task.done) return '';
      const what = task.text.replace(/^\w/, (letter) => letter.toLowerCase());
      if (!Number.isFinite(meant)) return task.timer ? `Your ${what} is up.` : `Reminder: ${what}.`;
      const when = dueWords({ due: meant }, now());
      return task.timer ? `Your ${what} went off ${when}.` : `Reminder, from ${when.replace(/^at /, '')}: ${what}.`;
    },
    /** Its time came and they were told: a timer's over with, a reminder stays until they say it's done. */
    rang(id) {
      const task = tasks.find((item) => item.id === id);
      if (!task) return;
      lastTold = { id, at: now() };
      // The clock takes a job off once it's done: said here too, for whoever else calls this.
      clock.remove(jobId(id));
      if (task.timer) tasks = tasks.filter((item) => item !== task);
      else task.told = now();
      changed();
    },
    /** Every job the clock should hold, put back: after a clock file lost or set aside. */
    reschedule() {
      for (const task of tasks) schedule(task);
    },
    /** Whether the model should be shown the list with these words, and waited for before he speaks. */
    wanted(text, last = '') {
      const said = String(text ?? '');
      if (TASK_WORDS.test(said) || (!!lastTold.id && now() - lastTold.at <= JUST_TOLD_MS)) return true;
      // An answer to his own question or offer about the list ("at six", "yes please", "the pasta one").
      if (now() - askedAt <= JUST_TOLD_MS || OFFERED.test(String(last)) || HIS_QUESTION.test(String(last))) return true;
      // Or words that name something on it ("I called the dentist").
      const words = stems(said);
      return open().some((task) => about(task, words) > 0);
    },
    /**
     * Whether the user's words ask for a task, reminder or timer, or say yes to his offer of one. A timer (`op`
     * "timer") is also asked for by any length of time in what they said: "time my break, fifteen minutes".
     */
    asked(text, last = '', op = 'add', what = '') {
      const said = String(text ?? '');
      // Whatever's said to his own question about one is its answer ("What should I put on your list?" "Buy stamps").
      if (HIS_QUESTION.test(String(last))) return true;
      if (OFFERED.test(String(last)) && (YES.test(said.trim()) || CLOCK_WORDS.test(said) || DAY_WORDS.test(said))) return true;
      if (op === 'timer') return /\btimer\b/i.test(said) || (new RegExp(`\\b${DURATION}\\b`, 'i').test(said) && !QUESTION.test(said.trim()));
      // A question about the list, or another kind of list, isn't asking for something on this one.
      if (OTHER_LIST.test(said) && !/\bremind/i.test(said)) return false;
      if (QUESTION.test(said.trim())) return false;
      if (ADD_WORDS.test(said)) return true;
      // "Write down that I need to call mom", "add call the dentist": asked to keep something, and the task is that.
      return KEEP_WORDS.test(said) && shared(stems(what), stems(said)) > 0;
    },
    /**
     * A timer set, cancelled or asked after, in the user's own words: what he says back, or '' when the words aren't
     * one of those, or are more than one of those.
     */
    direct(text) {
      const said = String(text ?? '');
      // To "Which one?", a timer's name is the answer, not a new timer.
      if (now() - cancelAskedAt <= 60_000) {
        const named = plain(said).replace(/^(?:the|my|cancel|stop) /, '').replace(/ (?:one|timer|please)$/g, '');
        const picked = named.split(' ').length <= 4 ? match(named, timers()).one : null;
        cancelAskedAt = 0;
        if (picked) return cancelTimers({ all: false, which: named });
        if (/^(?:all|both|all of them|every one|everything)$/.test(named)) return cancelTimers({ all: true, which: '' });
      }
      const wanted = timerAsked(said);
      if (wanted) return startTimer(wanted.ms, wanted.name);
      const cancel = timerCancelAsked(said);
      if (cancel) return cancelTimers(cancel);
      const left = timerLeftAsked(said);
      if (left) return timersLeft(left);
      return '';
    },
    /**
     * What a model asked for in "task": done only when it can be, and what's said back is how it went.
     * @param {{op?:string, text?:string, at?:string, in?:number}} request
     * @param {{said:string, last?:string}} context  the user's own words, and his line before them
     * @returns {string} what he says; '' when the request was nothing he could act on
     */
    apply(request, context) {
      return asking(applied(request, context));
    },
    /**
     * He's said something of theirs is done, and set no "task": if their own words are plainly about one open task,
     * it's that one they've said they did, and it's ticked. What he says of it, or '' when their words name none.
     */
    saidDone(said) {
      const line = String(said ?? '');
      // A question about it, or words that say it isn't done, aren't them saying they did it.
      if (QUESTION.test(line.trim()) || /\?\s*$/.test(line) || NOT_DONE.test(line)) return '';
      const task = theirsIn(line, open().filter((item) => !item.timer));
      if (!task) return '';
      markDone(task.id);
      log('tasks: one ticked off, by their saying so');
      return `Ticked off: ${task.text}.`;
    },
    /**
     * He's said something of theirs is off the list, and set no "task": if their own words ask for that of one open
     * task ("take the stamps off my list"), it's taken off. What he says of it, or ''.
     */
    saidDrop(said) {
      const line = String(said ?? '');
      if (QUESTION.test(line.trim()) || !DROP_WORDS.test(line)) return '';
      const task = theirsIn(line, open());
      if (!task) return '';
      const left = task.timer ? leftWords(task) : '';
      remove(task.id);
      log(`tasks: ${task.timer ? 'a timer cancelled' : 'one removed'}`);
      return task.timer ? `Cancelled, with ${left}.` : `Removed from your list: ${task.text}.`;
    },
    /** The list, for the model: what's running, what's open and when, and what was ticked off today. */
    lines() {
      const at = now();
      const all = open();
      const running = all.filter((task) => task.timer).sort(byDue);
      const todo = all.filter((task) => !task.timer).sort(byDue);
      if (!all.length) return 'The user’s to-do list, which you keep, is empty, and no timer is running.';
      const out = ['The user’s to-do list, reminders and timers, which you keep. Nothing on it is done until they say so:'];
      for (const task of running) out.push(`- Timer: ${task.text}, ${leftWords(task)}.`);
      for (const task of todo.slice(0, 30)) {
        const late = Number.isFinite(task.due) && (task.allDay ? task.due < dayStart(at) : task.due < at);
        const when = !Number.isFinite(task.due) ? '' : task.allDay ? ` (for ${dayWords(task.due, at).replace(/^on /, '')}${late ? ', overdue' : ''})` : ` (reminder ${dueWords(task, at)}${task.told ? ', already given' : late ? ', overdue' : ''})`;
        out.push(`- ${task.text}${when}`);
      }
      if (todo.length > 30) out.push(`- and ${todo.length - 30} more.`);
      if (!todo.length) out.push('- Nothing to do is on the list.');
      const lately = tasks.filter((task) => task.done && task.done >= dayStart(at)).map((task) => task.text);
      if (lately.length) out.push(`Ticked off today: ${lately.slice(0, 10).join('; ')}.`);
      return out.join('\n');
    }
  };
}
