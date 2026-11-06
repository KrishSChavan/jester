/**
 * Jester, talking. With the continuous assistant on, everything the mic hears
 * comes here. What wasn't said to him is dropped on the spot. What was is either
 * a command the matcher already knows, done as a spoken command is and its result
 * said aloud; or goes to a local Ollama model, which answers, and can hand back
 * a command of its own. No screen goes to that model: its work ends at a sentence.
 *
 * Anyone in the room can say his name, so a command that could do harm asks first
 * (voice-commands.js, asksFirst), through the assistant's usual question.
 */

import { MODEL_REQUEST_LIMITS, requestModel } from '../../../jester-extension/src/background/model-client.js';
import { spokenLine } from './speaker.js';
import { addressed } from './wake.js';

/** How long he waits for more: after just his name, and after answering, with no need to say it again. */
const OPEN_MS = 8000;
/** His own voice can still be on its way through the recognizer this long after he stops. */
const QUIET_MS = 1200;
/** How much of the conversation the model is given. */
const HISTORY = 20;
const REPLY_TOKENS = 300;
const SUMMARY_TOKENS = 120;
/** This long with nothing said, and whatever comes next is a new conversation. */
const NEW_AFTER_MS = 5 * 60 * 1000;
/** His voice dies away in the room for about this long after the audio ends. */
const FADE_MS = 300;
/** What he said can be heard back this long after, through a slow speaker: see echoes. */
const ECHO_MS = 30000;
/** This much of what's heard being words he just said makes it him, not the user. */
const ECHO_SHARE = 0.6;
const OLLAMA = 'http://127.0.0.1:11434';
const OLLAMA_CHECK_MS = 1500;
/** 12 GB of model: on a 24 GB Mac, the 20 GB one has nothing left to work with. */
const ROOMY_BYTES = 12e9;
const STOP = /^\W*(?:stop|cancel|never ?mind|stop it|stop talking|shut up|be quiet|quiet|that'?s enough)\W*$/i;
/** A question's answer is all of what's said: "okay so what" isn't a yes. */
const YES = /^\W*(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|please do|allow)(?: please)?\W*$/i;
const NO = /^\W*(?:no|nope|don'?t|do not|cancel|stop|never ?mind)(?: thanks| thank you)?\W*$/i;

const REPLY_SCHEMA = {
  type: 'object',
  properties: { say: { type: 'string' }, do: { type: 'string' }, new: { type: 'boolean' } },
  required: ['say', 'do', 'new'],
  additionalProperties: false
};
const SUMMARY_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };

const wordsOf = (text) => String(text).toLowerCase().match(/[a-z']+/g) || [];

/** Earlier conversations, for the prompt: what they were, and that they're over. */
function earlierPart(earlier, date) {
  if (!earlier.length) return '';
  const day = (at) => (new Date(at).toDateString() === date.toDateString() ? 'Today' : new Date(at).toLocaleDateString('en-US', { weekday: 'long' }));
  const lines = earlier.map(({ at, summary }) => `- ${day(at)} at ${new Date(at).toLocaleTimeString('en-US', { timeStyle: 'short' })}: ${summary}`);
  return `\nEarlier conversations, which are over. Each is separate from this one: don't carry them on or bring them up unless the user refers back to one, or one plainly matters to what they just said. Then use it, as something you remember.\n${lines.join('\n')}`;
}

/**
 * @param {Date} date  now: the model has no clock of its own
 * @param {{at:number, summary:string}[]} [earlier]  recollections.js
 */
export function personaPrompt(date, earlier = []) {
  const when = date.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  return `Your name is Jester. You are a helpful AI assistant that can take control of the user's laptop and search the internet.
You talk with the user out loud, so talk the way a friendly person does: one to three short sentences, with no lists, markdown or emoji. It is ${when}.
Reply with JSON: {"say":"what you say out loud","do":"a command for the laptop, or empty","new":false}.
Set "new" to true when what the user just said has nothing to do with the conversation so far, so a different subject has begun. Set it to false when it carries on from what you were talking about, or when there's nothing before it.
Fill in "do" only when the user wants something done on the laptop, as one plain command holding all of it, like "play Gunna on Spotify" or "open Notes and write down milk". Then "say" is a few words like "On it", and never claims it's done: the laptop reports that itself. A question about what you can do isn't a request: answer it.
To search the internet, set "do" to "search the web for" and the words. That opens the results in the browser for the user to read: you can't read them. You have no live information, so never give weather, news, prices, scores or anything recent as fact: offer to search instead.
For anything else, just talk, and leave "do" empty. Answer general questions from what you know, like how to boil an egg.${earlierPart(earlier, date)}`;
}

/**
 * What Ollama has, for Settings. Asked from here because Ollama refuses pages.
 * @returns {Promise<{running:boolean, models:{name:string, size:number}[]}>}
 */
export async function ollamaModels(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(OLLAMA_CHECK_MS) });
    const { models = [] } = await response.json();
    return { running: true, models: models.filter((model) => !model.capabilities || model.capabilities.includes('completion')).map(({ name, size }) => ({ name, size })) };
  } catch {
    return { running: false, models: [] };
  }
}

/** With none chosen, the biggest that leaves the computer room to work; failing that, the smallest. */
export function pickModel(models) {
  const sized = [...models].sort((a, b) => b.size - a.size);
  return (sized.find((model) => model.size <= ROOMY_BYTES) || sized.at(-1))?.name || '';
}

/**
 * Asks Ollama for his next line.
 * @returns {Promise<{say:string, do:string}>}
 */
export async function askOllama({ model, text, history, earlier = [], signal, request = requestModel, date = new Date() }) {
  if (!model) throw new Error('I can’t reach Ollama. Open it, and I’ll be able to talk.');
  const { json } = await request({
    env: { provider: 'ollama', model },
    system: personaPrompt(date, earlier),
    prompt: text,
    history: history.map((entry) => ({ role: entry.who === 'you' ? 'user' : 'assistant', content: entry.text })),
    schema: REPLY_SCHEMA,
    maxOutputTokens: REPLY_TOKENS,
    maxElapsedMs: MODEL_REQUEST_LIMITS.localElapsedMs,
    timeoutMs: MODEL_REQUEST_LIMITS.localElapsedMs,
    signal
  });
  return { say: String(json?.say ?? '').trim(), do: String(json?.do ?? '').trim(), new: json?.new === true };
}

/** A finished conversation, in the sentence recollections.js keeps. */
export async function summarize({ model, entries, request = requestModel }) {
  if (!model) throw new Error('no model');
  const { json } = await request({
    env: { provider: 'ollama', model },
    system: 'Sum up this spoken conversation between a user and their assistant Jester in one sentence of at most 25 words. Keep anything the user said about themselves, and any names, plans or decisions. Reply with JSON: {"summary":"..."}',
    prompt: entries.map((entry) => `${entry.who === 'you' ? 'User' : 'Jester'}: ${entry.text}`).join('\n'),
    schema: SUMMARY_SCHEMA,
    maxOutputTokens: SUMMARY_TOKENS,
    maxElapsedMs: MODEL_REQUEST_LIMITS.localElapsedMs,
    timeoutMs: MODEL_REQUEST_LIMITS.localElapsedMs
  });
  return String(json?.summary ?? '').trim();
}

/**
 * @param {object} deps
 * @param {(request:{text:string, history:object[], signal:AbortSignal}) => Promise<{say:string, do:string}>} deps.chat
 * @param {{say:(text:string) => Promise<void>, stop:() => void}} deps.speaker
 * @param {{add:Function, current:Function, idleFor:Function, startNew:Function}} deps.memory  conversation-log.js
 * @param {{keep:Function, relevant:Function}} deps.recollections  recollections.js
 * @param {{knows:(text:string) => Promise<boolean>, risky:(text:string) => Promise<boolean>, run:(text:string) => Promise<{outcome:{ok:boolean, text:string}|null}>}} deps.commands
 * @param {{asking:boolean, running:boolean, answer:Function, cancel:Function, confirm:(label:string) => Promise<boolean>}} deps.assistant
 * @param {(voice:object) => void} deps.show  a frame for the pill
 * @param {() => void} [deps.listenAfresh]  whatever's mid-utterance doesn't count
 * @param {() => boolean} [deps.knowsYou]  a voiceprint is keeping everyone else out
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {() => number} [deps.now]
 */
export function createConversation({ chat, speaker, memory, recollections, commands, assistant, show, listenAfresh = () => undefined, knowsYou = () => false, log = () => undefined, now = Date.now }) {
  /** Each thing said to him is a turn; one that's been replaced says nothing more. */
  let turns = 0;
  let controller = null;
  /** What he's saying, in order: one line at a time. */
  let queue = Promise.resolve();
  let hushes = 0;
  let talking = 0;
  let quietUntil = 0;
  let openUntil = 0;
  /** What he's said lately, for telling his voice from the user's. */
  let lately = [];

  /** Words the mic heard that he just said: a garbled echo gets most of them right. */
  function echoes(text) {
    lately = lately.filter((line) => now() - line.at < ECHO_MS);
    const words = wordsOf(text);
    if (words.length < 3) return false;
    const his = new Set(lately.flatMap((line) => line.words));
    return words.filter((word) => his.has(word)).length / words.length >= ECHO_SHARE;
  }

  const keep = (entries) => {
    if (entries.length) recollections.keep(entries).catch((err) => log('couldn’t keep a conversation:', err.message));
  };

  async function speakNow(line) {
    talking += 1;
    show({ phase: 'speaking', text: line });
    try {
      await speaker.say(line);
    } finally {
      talking -= 1;
      quietUntil = now() + QUIET_MS;
      lately.push({ at: now(), words: wordsOf(line) });
      if (!talking) {
        show({ phase: 'speaking', done: true });
        // Anything that began while he talked has him in it: it goes, however it ends.
        setTimeout(listenAfresh, FADE_MS);
      }
    }
  }

  /** Says a line after any before it. @returns {Promise<void>} once said */
  function say(text) {
    const line = spokenLine(text);
    if (!line) return Promise.resolve();
    memory.add('jester', line);
    const hush = hushes;
    const spoken = queue.then(() => (hush === hushes ? speakNow(line) : undefined));
    queue = spoken.catch((err) => log('couldn’t say it:', err.message));
    return queue;
  }

  function hush() {
    hushes += 1;
    speaker.stop();
  }

  /** The pill listens on, for what's said next. */
  function stayOpen(ms = OPEN_MS) {
    openUntil = now() + ms;
    show({ active: true, start: true, hold: ms });
  }

  async function act(text, { overheard, stale, before }) {
    if (overheard && (await commands.risky(text)) && !stale()) {
      const allowed = await assistant.confirm(`Do “${text.replace(/[.!?]+$/, '')}”`);
      if (stale()) return;
      if (!allowed) return void (await say('Okay, I won’t.'));
    }
    if (stale()) return;
    const { outcome } = await commands.run(text);
    await before;
    if (stale()) return;
    if (outcome) await say(outcome.text);
    else show({ active: false });
  }

  async function turn(text, { overheard }) {
    const mine = ++turns;
    const stale = () => mine !== turns;
    controller?.abort();
    const ongoing = new AbortController();
    controller = ongoing;
    hush();
    openUntil = 0;
    if (memory.idleFor() >= NEW_AFTER_MS) keep(memory.startNew());
    const history = memory.current(HISTORY);
    memory.add('you', text);
    // Reaching here at all, overheard, is what a voiceprint says it was them.
    show({ phase: 'heard', text, matched: overheard && knowsYou() });
    try {
      if (await commands.knows(text)) {
        if (!stale()) await act(text, { overheard, stale });
        return;
      }
      if (stale()) return;
      show({ phase: 'thinking', task: '', step: '' });
      const reply = await chat({ text, history, earlier: recollections.relevant(text), signal: ongoing.signal });
      if (stale()) return;
      log('jester:', JSON.stringify(reply));
      // A new subject: what came before is over, and this opens the next.
      if (reply.new && history.length) keep(memory.startNew(1));
      const answered = say(reply.say || (reply.do ? 'On it.' : 'Sorry, I lost my words there.'));
      if (reply.do) return void (await act(reply.do, { overheard, stale, before: answered }));
      await answered;
      // Without a voiceprint anyone could carry on from here, and he'd answer his own echo.
      if (!stale() && knowsYou()) stayOpen();
    } catch (err) {
      if (stale()) return;
      log('jester couldn’t answer:', err.message);
      await say(err.message);
    }
  }

  return {
    /** A finished utterance from the always-on mic, for him or not. */
    heard(text) {
      const { woken, rest } = addressed(text);
      const meant = woken ? rest : String(text).trim();
      if (!meant && !woken) return undefined;
      // Hearing himself: while he talks and just after, only "stop" counts.
      if (talking || now() < quietUntil) {
        if (STOP.test(meant)) hush();
        return undefined;
      }
      if (echoes(meant)) return log('that was me:', JSON.stringify(text));
      // A question he's waiting on is answered without his name, or the user's
      // yes would have to start with it. Anything else overheard is just that.
      if (assistant.asking) {
        if (YES.test(meant)) assistant.answer(true);
        else if (NO.test(meant)) assistant.answer(false);
        return undefined;
      }
      if (assistant.running && STOP.test(meant)) return assistant.cancel();
      if (!woken && now() >= openUntil) return undefined;
      if (!meant) return stayOpen();
      return turn(meant, { overheard: true });
    },
    /** A command spoken on purpose, with the shortcut or a gesture: no name needed, and nothing to doubt. */
    told: (text) => turn(String(text).trim(), { overheard: false }),
    /** The assistant's question, out loud. */
    ask: (label) => say(`${label}? Say yes or no.`),
    /** He stops mid-sentence. */
    hush,
    /** Starts over, with nothing kept. */
    forget() {
      memory.clear();
      recollections.forget();
    },
    /** Listening has ended: everything he was doing goes with it. */
    reset() {
      turns += 1;
      controller?.abort();
      openUntil = 0;
      hush();
      show({ phase: 'speaking', done: true });
    }
  };
}
