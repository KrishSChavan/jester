/**
 * The desktop assistant: a spoken goal, worked through the front app's
 * controls one model step at a time — read the screen, ask the model, check
 * its reply, ask the user first if the step is sensitive, act, remember.
 * A choice only the user can make (which profile, which of two people) is
 * put to them, and the task goes on by their answer or stops: never a guess.
 * Who is there (a profile, an account) is asked even when the model doesn't.
 * executor.js uses the same parts for the steps of a plan that need eyes.
 *
 * Each step is rebuilt from the goal, a bounded memory and a fresh screen
 * (as the extension's assistant does), so nothing grows from step to step.
 * The host reads and acts on the screen; the caller supplies the model, the
 * user's approval and progress reporting.
 */

import { requiresConfirmation } from '../../../../jester-extension/src/common/agent-permissions.js';
import { createMemory, MEMORY_LIMITS, updateMemory } from '../../../../jester-extension/src/common/task-memory.js';
import { parseShortcut } from '../os-actions.js';
import { secretIn } from '../vault-memory.js';
import { ASK_LIMITS, askLabel, ASKS_SECRET, classify, describeAction, menuPath, PICTURES_PER_TASK, PLAYS, QUESTIONS_PER_TASK, quoted, READ_ACTIONS, taskCaption, validateTurn } from './actions.js';
import { whoIsAsked, whoKept, whoMeant } from './fork.js';
import { DESKTOP_SCHEMA, systemPrompt } from './prompt.js';
import { elementById, plain, SCREEN_LIMITS, screenText } from './screen.js';

/**
 * A step's calls and a run's were 6 and 16 until 2026-11-14, when "work out 15 percent of 80" in Calculator took
 * Claude Sonnet 5.5 eight right presses (AC 8 0 × 1 5 % =) in seven calls: the step ran out with the sum done, and
 * the task was called not done. A press a call is how careful models work a keypad, so a step gets 10 and a run 24.
 */
export const DESKTOP_LIMITS = Object.freeze({ maxActions: 30, maxModelCalls: 24, runBudgetMs: 5 * 60 * 1000, failures: 3, invalidReplies: 2, invalidTotal: 3, idleSteps: 3, stepCalls: 10, replans: 2, pictures: PICTURES_PER_TASK, questions: QUESTIONS_PER_TASK });
/** The user's choice: ask before sensitive steps only (agent-permissions.js's "entertainment"). */
const BOUNDARY = 'entertainment';
/** The least of the screen a model gets, however tight its tokens-per-minute ceiling. */
const MIN_SCREEN_CHARS = 1500;
/**
 * The user's earlier answers a task is given (`ways`: lines such as "Hulu profile: Krish"): the first of them, which
 * are the newest as they're kept (ways.js lines), each cut to its length. What a task's own question is answered with
 * is kept short enough to make one.
 */
export const WAY_LIMITS = Object.freeze({ ways: 12, chars: 120 });
/** The most of an answer in the user's own words that's carried on: what's said to a question is a few words, not a passage. */
const ANSWER_CHARS = 200;
/**
 * How a task ends when it comes down to a secret: the model asked for one again after being told not to, or the
 * user said one in answer. Nothing of it is carried on, typed or kept.
 */
export const SECRETS_ARE_YOURS = 'I left it there, since passwords, codes and card numbers are yours to type in.';
/**
 * What the model is told of a picture that comes with its step: what its numbers are, and (its size known) that a
 * thing in it with no number can be clicked by its place, which is good in this reply only.
 */
const PICTURE_NOTE = 'The attached picture is the window as the screen shows it now. The number in each yellow box is the id of the control it sits on, the same ids as the screen lines.';
export const pictureNote = (size) =>
  size?.width > 0 && size?.height > 0
    ? `${PICTURE_NOTE} It is ${size.width} × ${size.height} pixels: something in it with no number can be clicked in this reply by its middle, as x and y in those pixels from the top left, with what (a few words for it).`
    : PICTURE_NOTE;

export const tidy = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** What happened, kept in the memory the model sees (task-memory.js's shape). */
function remember(memory, label, result, read) {
  const entry = { action: tidy(label, 120), ok: result?.ok === true, detail: tidy(result?.detail, 240) };
  memory.recent = [...memory.recent, entry].slice(-MEMORY_LIMITS.recent);
  if (entry.ok && !read) memory.completed = [...memory.completed, `${entry.action}${entry.detail ? `: ${entry.detail}` : ''}`].slice(-MEMORY_LIMITS.completed);
}

export const aborted = (err) => err?.name === 'AbortError';

/** The user's earlier answers as a task takes them: lines of text only, none twice, the first dozen. */
const waysGiven = (ways) => [...new Set((Array.isArray(ways) ? ways : []).filter((way) => typeof way === 'string').map((way) => tidy(way, WAY_LIMITS.chars)).filter(Boolean))].slice(0, WAY_LIMITS.ways);

/** Words as they're known across a task, however they're punctuated or capitalised. */
const sameWords = (text) => plain(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** What a choice is about, as it's matched: "Which Hulu profile" and "the Hulu profile" are one thing. */
const aboutKey = (text) => sameWords(text).split(' ').filter((word) => !['the', 'a', 'an', 'my', 'your', 'which', 'what'].includes(word)).join(' ');

/**
 * How a task ends when a question of its own went unanswered: with what it wasn't sure of, and never with a guess
 * at it. 2026-11-21: Hulu's profile picker was met with three clicks on the wrong profile, and then "A control is
 * not responding".
 * @param {string} [about]  the question's `about`: "Hulu profile", "which Dad", "who to text"
 */
export function unsure(about = '') {
  const words = tidy(about, ASK_LIMITS.about).replace(/[\s.?!…:,]+$/, '');
  if (!words) return 'I left it there, since I wasn’t sure what you’d want.';
  // "who to text", "whether to sign in": said as they are.
  if (/^(?:who|whom|whose|what|where|when|how|whether|if)\b/i.test(words)) return `I left it there, since I wasn’t sure ${words.charAt(0).toLowerCase()}${words.slice(1)}.`;
  return `I left it there, since I wasn’t sure which ${words.replace(/^(?:which|the|an?|my|your)\s+/i, '')} to go with.`;
}

/**
 * Which of the user's answers settles a question, by what it's about ("Hulu profile: Krish", for one about the Hulu
 * profile): what they said to it earlier in this task, put another way, or else the first of their earlier answers
 * for it; when that's still one of the ways to answer, or the question has none. Then the user isn't asked again,
 * whether or not the model took the hint. '' when none does.
 */
function settledBefore(run, about, options) {
  const key = aboutKey(about);
  if (!key) return '';
  const lines = [...run.chose.map((item) => `${item.about}: ${item.choice}`), ...run.ways];
  const way = lines.find((line) => line.indexOf(':') > 0 && aboutKey(line.slice(0, line.indexOf(':'))) === key);
  const choice = way ? way.slice(way.indexOf(':') + 1).trim() : '';
  if (!choice || !options.length) return choice;
  return options.find((option) => sameWords(option) === sameWords(choice)) || '';
}

/** A question and its answer, as a fact the task keeps (task-memory.js cuts a fact at 180 characters). */
const answerFact = (question, answer) => `The user, asked “${tidy(question, 80)}”, answered: ${tidy(answer, 70)}`;

/**
 * The user's answers stay among the task's facts whatever the model notes after them: kept last, they're the last
 * to be cut when there are too many.
 */
function pinAnswers(run) {
  if (!run.answers.length) return;
  run.memory.facts = [...run.memory.facts.filter((fact) => !run.answers.includes(fact)), ...run.answers].slice(-MEMORY_LIMITS.facts);
}

/**
 * What the user chose, for whoever remembers it: about and choice make one line of `ways`. It's handed over as it's
 * made, and not only with the task's end: a task called off while the page loads (any new command does that) is
 * otherwise one whose answer was thrown away, and the same question the next time.
 */
function keep(run, about, answer) {
  const kept = { about, choice: tidy(answer, WAY_LIMITS.chars - ASK_LIMITS.about - 2) };
  run.chose = [...run.chose.filter((item) => aboutKey(item.about) !== aboutKey(about)), kept];
  Promise.resolve()
    .then(() => run.onChose({ ...kept }))
    .catch(() => undefined);
}

/**
 * A question only the user can settle (which profile, which of two people), put to them, and its answer kept for
 * the rest of the task. It's no step: nothing on screen is done, so nothing of it is counted as one, traced or
 * learned. Unanswered, asked for the second time, one too many, or with nobody to ask, the task ends there saying
 * what it wasn't sure of; it never goes on by a guess. The answer chooses between things, and is never leave to
 * send, buy or delete: every step after it is still judged, and asked about, as it would have been.
 * @param {object} run  createRun's
 * @param {{question:string, options?:string[], about?:string}} action  validated
 * @param {object} [more]
 * @param {(answer:string) => string} [more.means]  the choice on screen an answer comes to, by its name, or '': the
 *   answer is carried on and kept as that
 * @returns {Promise<{stop:object}|{answered:true}>}
 */
async function askUser(run, action, { means = null } = {}) {
  const { signal, onStep, limits, now } = run;
  const question = tidy(action.question, ASK_LIMITS.question);
  const options = (action.options || []).map((option) => tidy(option, ASK_LIMITS.option));
  const about = tidy(action.about, ASK_LIMITS.about);
  const label = describeAction(action);
  const left = (detail) => {
    onStep({ phase: 'acted', label, ok: false, detail });
    return { stop: run.end(false, unsure(about), { unanswered: true }) };
  };
  // Asked once already: it's no surer for asking again, and the user isn't asked in circles.
  if (run.asked.has(sameWords(question))) return left('asked already');
  run.asked.add(sameWords(question));
  let answer = settledBefore(run, about, options);
  const before = !!answer;
  if (!before) {
    if (run.questions >= (limits.questions ?? QUESTIONS_PER_TASK)) return left('too many questions');
    if (!run.inquire) return left('nobody to ask');
    run.questions += 1;
    onStep({ phase: 'asking', label: question, open: true });
    const from = now();
    answer = await Promise.resolve()
      .then(() => run.inquire({ question, options, about }))
      .catch(() => null);
    // However long they took to answer isn't the task's time.
    run.startedAt += now() - from;
    if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
    const said = typeof answer === 'string' ? answer : '';
    answer = tidy(said, ANSWER_CHARS);
    if (!answer) return left('no answer');
    // A password or a card number said in answer goes no further than this: not to the model, not among the task's
    // facts, not back to be remembered. What was asked can't have needed it (actions.js refuses a question after one).
    if (secretIn(said) || secretIn(`${about}: ${answer}`) || secretIn(`${question} ${answer}`)) {
      onStep({ phase: 'acted', label, ok: false, detail: 'a secret, not taken' });
      return { stop: run.end(false, SECRETS_ARE_YOURS, { unanswered: true }) };
    }
    // "The second one", or "Chris" as the microphone hears Krish, is the name that's on screen from here on.
    answer = tidy(means?.(answer), ANSWER_CHARS) || answer;
    if (about) keep(run, about, answer);
  }
  // Never the answer itself: it may be a name, and this goes to the log.
  onStep({ phase: 'acted', label, ok: true, detail: before ? 'answered before' : 'answered' });
  run.said.push({ answer, about: before ? '' : about, actions: run.actions });
  run.forked = true;
  run.answers.push(answerFact(question, answer));
  pinAnswers(run);
  remember(run.memory, label, { ok: true, detail: `The user answered: ${answer}` }, true);
  run.lastResult = {
    ok: true,
    asked: question,
    answer,
    detail: `${before ? 'The user settled this before (userChoices)' : 'The user’s own answer'}: carry on with the same task by it, and don’t ask this again. It chooses between things; it is never leave to send, buy or delete.`
  };
  return { answered: true };
}

/**
 * A press on one of the choices of who is there (a profile, an account: fork.js) is made on the user's word, never
 * the model's. Their own command may name one, or what they answered in this task, or an answer kept from before
 * that is about this window; with none of those they're asked, here and now, whatever the model was told about
 * asking. The one they mean is the one pressed, whichever the model chose. 2026-11-21: "Switch profile to Sandeep
 * Chavan", three times, with nobody asked.
 * @param {object} run  createRun's
 * @param {object} action  validated
 * @param {{snapshot:object}} seen  the screen it was chosen from
 * @returns {Promise<{action:object}|{stop:object}|{halted:true}>}  action: the step to go on with; stop: the run
 *   is over (unanswered, called off); halted: they answered in words that name none of the choices, which is the
 *   model's to go on by, and nothing was pressed
 */
async function whoFirst(run, action, seen) {
  const fork = whoIsAsked(action, seen.snapshot, [run.goal, run.meant].filter(Boolean).join(' '));
  if (!fork) return { action };
  const press = (choice) => (choice.ids.includes(fork.target) ? action : { action: 'click', id: choice.id });
  // Their own words name one: there was never a fork.
  if (fork.named) return { action: press(fork.named) };
  // What they said to a question in this task, the newest first, then what's kept from before. "The second one"
  // means the second of these only when nothing's been done since it was said: then it was said of these.
  const here = (said) => said.actions === run.actions;
  const heard = [...run.said].reverse().find((said) => whoMeant(fork, said.answer, { here: here(said) }));
  let choice = heard ? whoMeant(fork, heard.answer, { here: here(heard) }) : whoKept(fork, run.ways);
  // Said to the model's own question, of these, in other words than the choice's: kept as its name, which a later
  // day can find on screen ("Chris" names nobody there).
  if (heard?.about && here(heard) && heard.answer !== choice.name) {
    heard.answer = choice.name;
    keep(run, heard.about, choice.name);
  }
  if (!choice) {
    const asked = await askUser(run, { action: 'ask', question: fork.question, options: fork.options, ...(fork.about ? { about: fork.about } : {}) }, { means: (answer) => whoMeant(fork, answer, { here: true })?.name || '' });
    if (asked.stop) return asked;
    choice = whoMeant(fork, run.said.at(-1).answer, { here: true });
    if (!choice) return { halted: true };
  }
  // Pressed by their choice, which may be another the next time: not a step to learn and do again unasked.
  run.forked = true;
  return { action: press(choice) };
}

/**
 * A sensitive step as what it does and where, whatever the model calls its
 * field: "type hello, Enter, in Messages / Trisha Seth". One that was approved
 * and done isn't done again in the same task — a sent message may not show on
 * screen, and a model that can't see it asks to send it again.
 */
function sensitiveKey(action, screen) {
  const where = `${screen?.app?.name || ''} / ${screen?.window?.title || ''}`;
  const element = action.id === undefined ? null : elementById(screen, action.id);
  if (action.action === 'type') return `type ${action.text}${action.enter ? ', Enter' : ''} in ${where}`;
  if (action.action === 'click') return `click ${element?.label || action.under || action.what || action.id} in ${where}`;
  if (action.action === 'press') return `press ${action.keys} in ${where}`;
  if (action.action === 'menu') return `menu ${(action.resolved || menuPath(action.path)).join(' > ')} in ${where}`;
  if (action.action === 'drag') return `drag ${elementById(screen, action.from)?.label || action.from} onto ${elementById(screen, action.to)?.label || action.to} in ${where}`;
  return `${action.action} ${action.url || ''} in ${where}`;
}
/** How long the app is then given to show what the first press did, before the screen's read again. */
const TOGGLE_WAIT_MS = 900;

/**
 * A press of Play or Pause, as the control it is: by where it is, and by what it's in, since the same button reads
 * Play and then Pause. Empty for anything else. The app is read 350 ms after a press, and a music app can take longer
 * than that to turn its Play into Pause: a model shown Play still there presses it again, which pauses what it had
 * just started (2026-11-15, Spotify: the song played, stopped, and he said it was playing).
 */
function toggleKeys(action, screen) {
  if (action.action !== 'click' || action.button === 'right' || action.id === undefined) return [];
  const element = elementById(screen, action.id);
  if (!element || !PLAYS.test(String(element.label || '').trim())) return [];
  const app = screen?.app?.name || '';
  const frame = element.frame;
  // Where it is says which it is. What it's in stands in only for a control with no place given: two Plays in one
  // list are two controls.
  if (frame?.w > 0 && frame?.h > 0) return [`${app}|at ${Math.round(frame.x + frame.w / 2)},${Math.round(frame.y + frame.h / 2)}`];
  return element.in ? [`${app}|in ${plain(element.in)}`] : [];
}

/** model-client.js's codes for a reply the model can be asked to redo. */
export const UNREADABLE = new Set(['invalid_json', 'model_output_truncated']);

/** Why the screen couldn't be read, when it's something the user can put right: never the driver's words, which quote window titles. */
function unseenWhy(detail) {
  const text = String(detail ?? '');
  if (/Accessibility permission/i.test(text)) return 'Jester isn’t allowed Accessibility in System Settings';
  if (/no ordinary window is on screen/i.test(text)) return 'no window is open on this screen';
  if (/has no window/i.test(text)) return 'the app in front has no window I can read';
  if (/timed out/i.test(text)) return 'the app in front took too long to answer';
  if (/jester-driver (?:is not running|exited)/i.test(text)) return 'Jester’s helper had stopped';
  return '';
}

/** The screen couldn't be read, so the task stops: said with why, when that's known. */
export function unseen(detail, lastDone = '') {
  const why = unseenWhy(detail);
  const because = why ? ` (${why})` : '';
  return lastDone ? `I did “${lastDone}”, but then couldn’t read the screen to check it${because}, so I stopped.` : `I couldn’t read what’s on screen${because}, so I stopped.`;
}

/** A model failure in words for the user. */
export function modelTrouble(err) {
  if (/rate|429|limit/i.test(`${err?.name} ${err?.message}`)) return 'The AI models are at their limits for now. Try again in a minute.';
  if (/timeout/i.test(err?.name || '')) return 'The AI model took too long to answer.';
  return `The AI model didn’t answer: ${tidy(err?.message || err, 160)}`;
}

/**
 * A step that worked, as it can be done again without the model (learned.js):
 * the action without its screen numbers, and the controls it was done to by
 * kind, name and section, which a fresh read can find again.
 */
function traced(action, screen, category, result) {
  const target = (id) => {
    const element = elementById(screen, id);
    return element ? { role: element.role, label: element.label || '', ...(element.in ? { in: element.in } : {}) } : null;
  };
  // What the host worked out for this screen alone (a shortcut's menu command, a spot's place) isn't the step.
  const { id, resolved, runs, web, at, under, ...rest } = action;
  // A drag's ends are controls; a scroll's `to` is "end".
  if (action.action === 'drag') {
    delete rest.from;
    delete rest.to;
  }
  const step = { action: rest, app: screen?.app?.name || '' };
  if (resolved) step.action.path = resolved.join(' > ');
  if (id !== undefined) step.target = target(id);
  if (action.action === 'drag') step.targets = { from: target(action.from), to: target(action.to) };
  if (category === 'sensitive') step.sensitive = true;
  // Whether it visibly changed the screen then: a replay expects the same.
  if (typeof result?.changed === 'boolean') step.changed = result.changed;
  return step;
}

/** The screen with the keyboard focus on one element: what a typed or clicked control may leave for the next action of a group. */
function focusOn(screen, id) {
  return { ...screen, elements: (screen?.elements || []).map((element) => ({ ...element, focused: element.id === id })) };
}

const CAUTION = { read: 0, browse: 1, sensitive: 2, blocked: 3 };

/**
 * How careful to be with an action of a group, judged both on the screen
 * from before the group and on the focus the actions before it may have left
 * (a press or a value set through accessibility doesn't always move it), the
 * more careful of the two.
 */
function judge(action, screens, goal) {
  return screens.map((screen) => classify(action, { screen, goal })).reduce((most, next) => (CAUTION[next.category] > CAUTION[most.category] ? next : most));
}

/** A new group of actions, on the screen it was chosen from: `judged`, as perform() leaves it for the next. */
const newGroup = (seen) => ({ screen: seen.snapshot, focusKnown: true, selectedAll: false });

/** ⌘A (Ctrl+A on Windows), which leaves all of a field selected. */
function selectsAll(action, platform) {
  const plan = action.action === 'press' ? parseShortcut(action.keys) : null;
  return plan?.key === 'a' && plan.modifiers.length === 1 && plan.modifiers[0] === (platform === 'darwin' ? 'cmd' : 'ctrl');
}

/** Text in a field, as it's known across reads: the field's kind and name, and the words. */
function landedKey(action, screen) {
  const field = elementById(screen, action.id);
  return [field?.role, plain(field?.label), plain(action.text)].join('|');
}

/**
 * How much of the screen a step shows: a model with a small tokens-per-minute
 * ceiling gets less, so a task fits more steps in each minute (as the
 * extension's assistant does).
 */
async function screenChars(run, rest) {
  const tokens = await Promise.resolve(run.model.promptBudget?.()).catch(() => null);
  if (!Number.isFinite(tokens) || tokens <= 0) return SCREEN_LIMITS.chars;
  return Math.max(MIN_SCREEN_CHARS, Math.min(SCREEN_LIMITS.chars, tokens * 4 - run.system.length - JSON.stringify(rest).length));
}

/**
 * One task's state, for the steps of a run to share.
 * @param {object} options
 * @param {string} options.goal  what the user said
 * @param {{said:string, result:string}[]} [options.previous]  the last few commands
 * @param {{observe: Function, execute: Function}} options.host
 * @param {(request:object) => Promise<{json:object}>} options.model  model-pool's client, or requestModel
 * @param {(ask:{label:string, reason:string}) => Promise<boolean>} options.confirm  the user's yes: label is the
 *   question as a person would ask it (actions.js askLabel)
 * @param {(ask:{question:string, options:string[], about:string}) => Promise<string|null>} [options.inquire]  a
 *   question only the user can settle, for the model's `ask`: the option chosen or their own words, null when it
 *   went unanswered. With none, a task that needs to ask ends there
 * @param {string[]} [options.ways]  the user's earlier answers, as lines such as "Hulu profile: Krish" (WAY_LIMITS):
 *   the model gets them as userChoices, and a question one of them settles isn't asked again
 * @param {(chose:{about:string, choice:string}) => void} [options.onChose]  called as soon as the user answers a
 *   question that said what it was about, so the answer is kept even if the task is then called off
 * @param {(step:{phase:string, label?:string}) => void} [options.onStep]  task (the caption: from the goal,
 *   then the model's), thinking, asking, acting; and for the log: seen (what was read), acted (how a
 *   step went), invalid (an unusable reply), unseen (why the screen couldn't be read)
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.platform]
 * @param {string} [options.note]  what the model should know first: a saved way of doing it that failed
 * @param {string} [options.meant]  in conversation, what the goal (the user's own words) was taken to mean
 * @param {boolean} [options.see]  the host can take a picture of the window and the model can read it:
 *   the model is offered `screenshot`
 */
export function createRun({ goal, previous = [], host, model, confirm, inquire = null, ways = [], onChose = () => undefined, onStep = () => undefined, signal, platform = process.platform, limits = DESKTOP_LIMITS, now = Date.now, note = '', meant = '', see = false, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const run = {
    goal,
    meant,
    previous,
    host,
    model,
    confirm,
    inquire,
    ways: waysGiven(ways),
    onChose,
    onStep,
    signal,
    platform,
    limits,
    now,
    note,
    memory: createMemory(goal),
    startedAt: now(),
    see,
    system: systemPrompt(platform, { see }),
    lastResult: null,
    /** The last step that changed something, for when the screen can't be read to check it. */
    lastDone: '',
    actions: 0,
    /** Every call to the model, however it's answered. */
    calls: 0,
    failures: 0,
    invalid: 0,
    invalidTotal: 0,
    idle: 0,
    /** Sensitive steps done in this task (sensitiveKey), and how often the model has asked for one again. */
    doneSensitive: new Set(),
    repeats: 0,
    /** The screen as read just after the last step, which is the next step's. */
    next: null,
    trace: [],
    captioned: false,
    /** How often a screen and the actions chosen for it have been done. */
    signatures: new Map(),
    /** The Play or Pause last pressed (toggleKeys), until something else is done: pressed again, it would undo itself. */
    toggled: null,
    wait,
    /** Text read back in its field (landedKey), and how often the model has tried to type it again. */
    landed: new Map(),
    /** The app a plan opened, which later steps need in front. */
    expectApp: '',
    /** Pictures taken in this task, and the one waiting to go with the next model call. */
    pictures: 0,
    picture: null,
    pictureSize: null,
    /** Questions put to the user in this task, every one the model has asked (sameWords), and their answers as facts (answerFact). */
    questions: 0,
    asked: new Set(),
    answers: [],
    /** What the user chose, for each answered question that said what it was about: {about, choice}. */
    chose: [],
    /** Every answer of this task (theirs, with what it was about; or one kept from before), and how many steps had been done by then. */
    said: [],
    /** A choice of the user's decided a step (an answer, or one kept from before): `learnt` then gives no trace. */
    forked: false,
    /** A step was a click on a place in a picture: where that is next time is anyone's guess, so nothing is learned. */
    pointed: false,
    end: (ok, say, extra = {}) => ({ ok, say, actions: run.actions, ...(run.chose.length ? { chose: run.chose } : {}), ...extra })
  };
  // Nothing of the task before (the app it worked on behind another, its picture) is this one's.
  host.begin?.();
  return run;
}

/**
 * One action, whoever chose it: prepared, judged, asked about if it must be,
 * done and remembered. Nothing reaches the host another way. A press on a
 * choice of who is there waits on the user's word first (whoFirst), and may
 * be done to another of the choices than the one chosen.
 * @param {object} run  createRun's
 * @param {object} chosen  the action, validated
 * @param {{ok:true, snapshot:object}} seen  the screen it was chosen from
 * @param {object} [options]
 * @param {boolean} [options.verify]  check it on screen: the last action of a group
 * @param {object} [options.judged]  what the group's actions before it left (newGroup)
 * @param {boolean} [options.patient]  a slow app gets a second look before "nothing changed"
 * @returns {Promise<{stop:object}|{halted:true, repeated?:boolean}|{result:object, moved:boolean}>}
 *   stop: the run is over; halted: not done, or failed, and the rest of its group goes with it
 *   (repeated: because it was done once already, with the user's OK); moved: this was a group's
 *   last action, and something came of it
 */
export async function perform(run, chosen, seen, { verify = false, judged = newGroup(seen), patient = false } = {}) {
  const { host, signal, onStep, memory, platform, goal, confirm, doneSensitive, landed } = run;
  // Over a selection a field's id would otherwise add to the end, past what's selected.
  let action = judged.selectedAll && chosen.action === 'type' && chosen.id !== undefined && !chosen.mode ? { ...chosen, mode: 'insert' } : chosen;
  if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
  if (!judged.focusKnown && (action.action === 'press' || (action.action === 'type' && action.id === undefined))) {
    const label = describeAction(action, seen.snapshot, platform);
    onStep({ phase: 'acted', label, ok: false, detail: 'left for a fresh look' });
    run.lastResult = { action: label, ok: false, detail: 'Not done: a key before it in the group may have moved the focus. Look at the screen and choose it again.' };
    remember(memory, label, run.lastResult, false);
    run.failures += 1;
    return { halted: true };
  }
  if (action.action === 'screenshot' && (!run.see || run.pictures >= run.limits.pictures)) {
    const label = describeAction(action, seen.snapshot, platform);
    const detail = run.see ? `This task has had its ${run.limits.pictures} pictures: work from the screen text.` : 'Pictures of the screen aren’t available: work from the screen text.';
    onStep({ phase: 'acted', label, ok: false, detail });
    run.lastResult = { action: label, ok: false, detail };
    remember(memory, label, run.lastResult, true);
    run.failures += 1;
    return { halted: true };
  }
  // A click on a place in a picture is settled first: where it is on screen, and what's there. Inside a listed
  // control it becomes a click on that control, and is judged, guarded and pressed as one.
  if (action.action === 'click' && action.id === undefined) {
    const placed = host.locate ? await host.locate(action, seen.snapshot) : { ok: false, detail: 'Places in a picture can’t be clicked here: use an id.' };
    if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
    if (!placed.ok) {
      const label = describeAction(action, seen.snapshot, platform);
      onStep({ phase: 'acted', label, ok: false, detail: tidy(placed.detail, 160) });
      run.lastResult = { action: label, ok: false, detail: tidy(placed.detail, 240) };
      remember(memory, label, run.lastResult, false);
      run.failures += 1;
      return { halted: true };
    }
    action = placed.action;
    run.pointed = true;
  }
  // Which profile or account is the user's to say, before anything's pressed: the step may come back as another.
  const who = await whoFirst(run, action, seen);
  if (who.stop) return { stop: who.stop };
  if (who.halted) return { halted: true };
  action = who.action;
  // What it is exactly (a menu command's real titles) before it's judged.
  const ready = host.prepare ? await host.prepare(action, seen.snapshot) : { ok: true };
  if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
  if (!ready.ok) {
    const label = describeAction(action, seen.snapshot, platform);
    onStep({ phase: 'acted', label, ok: false, detail: tidy(ready.detail, 160) });
    run.lastResult = { action: label, ok: false, detail: tidy(ready.detail, 240) };
    remember(memory, label, run.lastResult, false);
    run.failures += 1;
    return { halted: true };
  }
  const label = describeAction(action, seen.snapshot, platform);
  const { category, reason } = judge(action, judged.screen === seen.snapshot ? [seen.snapshot] : [seen.snapshot, judged.screen], goal);
  if (category === 'blocked') {
    onStep({ phase: 'acted', label, ok: false, detail: reason });
    run.lastResult = { action: label, ok: false, detail: reason };
    remember(memory, label, run.lastResult, false);
    run.failures += 1;
    return { halted: true };
  }
  // Text read back is in: a model that can't tell may only double it.
  if (action.action === 'type' && action.id !== undefined && landed.has(landedKey(action, seen.snapshot))) {
    const written = landedKey(action, seen.snapshot);
    if ((await host.peek?.(seen.snapshot, action.id, action.text))?.contains) {
      landed.set(written, landed.get(written) + 1);
      onStep({ phase: 'acted', label, ok: false, detail: 'already in' });
      if (landed.get(written) >= 2) return { stop: run.end(false, `${quoted(action.text)} is in the field and reads back right, so I stopped there.`) };
      run.lastResult = { action: label, ok: false, landed: true, detail: 'Not done: it’s already in the field, word for word. Never type it again: if the goal is done, finish.' };
      return { halted: true };
    }
  }
  const key = category === 'sensitive' ? sensitiveKey(action, seen.snapshot) : null;
  if (key && doneSensitive.has(key)) {
    run.repeats += 1;
    onStep({ phase: 'acted', label, ok: false, detail: 'not repeated' });
    if (run.repeats >= 2) return { stop: run.end(false, `I’d already done “${label}” once, so I stopped rather than do it again.`) };
    run.lastResult = { action: label, ok: false, detail: 'Already done once in this task, with the user’s OK. It is never repeated: if the goal is done, finish.' };
    return { halted: true, repeated: true };
  }
  if (requiresConfirmation(BOUNDARY, category)) {
    // Asked as a person would ask it; the pill, the log and the model keep the step's own words.
    const question = askLabel(action, judged.screen, { reason, platform });
    onStep({ phase: 'asking', label: question });
    const approved = await confirm({ label: question, reason });
    if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
    if (!approved) return { stop: run.end(false, 'Okay, I didn’t do that.', { declined: true }) };
  }
  // Play, pressed last and asked for again with nothing done between: not pressed, once. However long the model
  // took to ask, it asked from the screen as read just after the press. The app gets a moment, the screen is read
  // afresh, and if it's asked for again after that, it's meant.
  const toggle = toggleKeys(action, seen.snapshot);
  if (toggle.length && run.toggled && toggle.some((key) => run.toggled.includes(key))) {
    run.toggled = null;
    onStep({ phase: 'acted', label, ok: false, detail: 'not pressed twice' });
    await run.wait(TOGGLE_WAIT_MS);
    if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
    run.next = null;
    run.lastResult = { action: label, ok: false, detail: 'Not done: you pressed that a moment ago, and pressing it again would undo it (play, then pause). The screen hadn’t caught up: look at it now. If what was asked for is playing, finish; if it isn’t, press what plays it.' };
    remember(memory, label, run.lastResult, false);
    return { halted: true };
  }
  onStep({ phase: 'acting', label });
  let result;
  try {
    // The last of a group is checked: what it changed, read once, is the next step's screen.
    result = await host.execute(action, seen.snapshot, { verify, signal, patient, goal: [goal, run.meant].filter(Boolean).join(' ') });
  } catch (err) {
    result = { ok: false, detail: tidy(err?.message || err, 200) };
  }
  run.actions += 1;
  // macOS's own dialog is in the way (host.js): the task is over until the user's answered it, and says so.
  if (result.asking) {
    onStep({ phase: 'acted', label, ok: false, detail: tidy(result.detail, 160) });
    return { stop: run.end(false, result.detail, { asking: true }) };
  }
  if (result.snapshot) run.next = result.snapshot;
  // It goes with the next model call only, then it's dropped.
  if (result.ok && result.image) {
    run.pictures += 1;
    run.picture = result.image;
    run.pictureSize = result.size || null;
  }
  if (action.id !== undefined && (action.action === 'click' || action.action === 'type')) judged.screen = focusOn(judged.screen, action.id);
  // A key, text at the cursor, or a click on a spot nothing is known of: where the focus is now is unknown.
  else if (action.action === 'press' || action.action === 'type' || action.action === 'click') judged.focusKnown = false;
  judged.selectedAll = result.ok === true && selectsAll(action, platform);
  onStep({ phase: 'acted', label, ok: result.ok === true, detail: tidy(result.detail, 160), ...(result.changes ? { changes: tidy(result.changes, 600) } : {}) });
  remember(memory, label, result, READ_ACTIONS.has(action.action));
  run.lastResult = {
    action: label,
    ok: result.ok === true,
    detail: tidy(result.detail, 240),
    ...(result.changes ? { changes: tidy(result.changes, 600) } : {}),
    ...(result.found ? { found: result.found } : {}),
    ...(result.landed ? { landed: true } : {})
  };
  if (!result.ok) {
    run.failures += 1;
    // The rest of a group was chosen for a screen that didn't happen.
    return { halted: true };
  }
  if (toggle.length) run.toggled = toggle;
  else if (!READ_ACTIONS.has(action.action)) run.toggled = null;
  if (key) doneSensitive.add(key);
  if (result.landed) landed.set(landedKey(action, seen.snapshot), 0);
  if (!READ_ACTIONS.has(action.action)) run.trace.push(traced(action, seen.snapshot, category, result));
  // A step that changed nothing on screen is no progress, nor is one whose effect can't be seen.
  const effect = !READ_ACTIONS.has(action.action) && result.changed !== false && !result.unseen;
  if (effect) run.lastDone = label;
  // Only a group's last action is checked: one before it may have done nothing at all.
  const moved = verify && effect;
  if (moved) run.failures = 0;
  return { result, moved };
}

/**
 * The model at the wheel, one step at a time, until it finishes or can't.
 * @param {object} run  createRun's
 * @param {object} [step]  with none, the whole goal is the model's
 * @param {string} [step.what]  the part of the goal it's doing: only that, and the screen is ranked by it too
 * @param {(screen:object) => boolean|Promise<boolean>} [step.done]  checked on the screen after every group:
 *   true ends the step at once, with no further model call
 * @param {number} [step.maxCalls]  model calls this step may use
 * @param {{step?:string, planned?:string[], text?:string, told?:object}} [step.info]  where it is in a plan
 *   (step: "2 of 3"), the text to write, and what it should hear first
 * @returns {Promise<{finished:{ok:boolean, say:string}}|{done:true}|{stop:object}|{stuck:{why:string, say:string}}>}
 *   finished: the model's own finish; done: `done` said so; stop: the run is over, this is how (a question of
 *   its own left unanswered among them: askUser); stuck: it can't go on, and says why
 */
export async function lookStep(run, { what = '', done = null, maxCalls = Infinity, info = {} } = {}) {
  const { goal, meant, note, previous, host, model, onStep, signal, platform, memory, limits, now, system } = run;
  const doing = what ? { step: info.step, what, ...(info.text ? { text: info.text } : {}) } : null;
  let started = run.calls;
  run.failures = 0;
  run.idle = 0;
  // A picture a step before this one ended without using is of a screen gone by.
  run.picture = null;
  if (info.told) run.lastResult = info.told;
  for (;;) {
    if (signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
    if (run.actions >= limits.maxActions || run.calls >= limits.maxModelCalls || now() - run.startedAt > limits.runBudgetMs) return { stuck: { why: 'limit', say: 'That was taking too many steps, so I stopped.' } };
    if (run.calls - started >= maxCalls) return { stuck: { why: 'step_too_long', say: 'That step was taking too many tries, so I stopped.' } };
    onStep({ phase: 'thinking' });
    const seen = run.next ? { ok: true, snapshot: run.next } : await host.observe();
    run.next = null;
    if (!seen.ok) {
      onStep({ phase: 'unseen', detail: tidy(seen.detail, 400) });
      return { stuck: { why: 'unseen', say: unseen(seen.detail, run.lastDone) } };
    }
    const rest = {
      // Said in so many words, so a prompt already at its size needs no line to explain it.
      originalGoal: meant ? `${goal} (taken in conversation to mean: ${meant})` : goal,
      ...(note ? { note: tidy(note, 300) } : {}),
      ...(previous.length ? { previousCommands: previous.slice(-3) } : {}),
      ...(run.ways.length ? { userChoices: run.ways } : {}),
      ...(doing ? { doing, ...(info.planned ? { planned: info.planned } : {}) } : {}),
      memory: { subgoal: memory.subgoal, constraints: memory.constraints, facts: memory.facts, ...(doing ? {} : { completed: memory.completed.slice(-4) }), recent: memory.recent },
      ...(run.lastResult ? { lastResult: run.lastResult } : {}),
      ...(run.picture ? { picture: pictureNote(run.pictureSize) } : {})
    };
    const picture = run.picture;
    const pictureSize = run.pictureSize;
    run.picture = null;
    run.pictureSize = null;
    const screen = screenText(seen.snapshot, { goal: [goal, meant, what].filter(Boolean).join(' '), chars: await screenChars(run, rest) });
    onStep({ phase: 'seen', app: seen.snapshot.app?.name, window: seen.snapshot.window?.title, elements: seen.snapshot.elements?.length ?? 0, screen });
    const prompt = JSON.stringify({ ...rest, screen });

    let reply = null;
    let unusable = '';
    run.calls += 1;
    try {
      reply = await model({ system, prompt, signal, schema: DESKTOP_SCHEMA, ...(picture ? { images: [picture] } : {}) });
    } catch (err) {
      if (aborted(err) || signal?.aborted) return { stop: run.end(false, '', { cancelled: true }) };
      // A reply that wasn't JSON (or was cut off) is the model's to fix; anything else ends the task.
      if (!UNREADABLE.has(err?.code)) return { stuck: { why: 'model', say: modelTrouble(err) } };
      unusable = err.code;
      // Unused, the picture goes with the retry, on the read its numbers are from.
      if (picture) {
        run.picture = picture;
        run.pictureSize = pictureSize;
        run.next = seen.snapshot;
      }
    }
    let turn;
    try {
      if (!reply) throw new Error('Reply with one short JSON object and nothing else.');
      turn = validateTurn(reply.json);
      updateMemory(memory, turn.memory ?? {});
      pinAnswers(run);
      run.invalid = 0;
      if (turn.task && !run.captioned) {
        run.captioned = true;
        onStep({ phase: 'task', caption: taskCaption(turn.task), by: 'model' });
      }
    } catch (err) {
      run.invalid += 1;
      run.invalidTotal += 1;
      onStep({ phase: 'invalid', detail: tidy(err.message, 200), ...(unusable ? { code: unusable } : {}) });
      if (run.invalid >= limits.invalidReplies || run.invalidTotal >= limits.invalidTotal) {
        // Told once that a secret is never asked for, and it asked again: the task needs one, and that's the user's.
        if (err.code === ASKS_SECRET) return { stop: run.end(false, SECRETS_ARE_YOURS) };
        return { stuck: { why: 'invalid', say: 'The AI model’s replies didn’t make sense, so I stopped.' } };
      }
      run.lastResult = { ok: false, detail: `Your reply was not usable: ${tidy(err.message, 200)}` };
      continue;
    }

    // A question is the user's to answer, and no step: the counts below (the same thing done again, nothing
    // changing, a step's tries) aren't moved by it, and the screen is read afresh once they've answered.
    if (turn.actions[0].action === 'ask') {
      const asked = await askUser(run, turn.actions[0]);
      if (asked.stop) return { stop: asked.stop };
      started += 1;
      continue;
    }

    // The same actions on the same screen, done twice already, won't go differently a third time.
    const signature = JSON.stringify([screen, turn.actions]);
    if ((run.signatures.get(signature) || 0) >= 2) {
      run.idle += 1;
      return { stuck: { why: 'no_effect', say: 'I wasn’t getting anywhere, so I stopped.' } };
    }
    const actionsBefore = run.actions;
    const saidBefore = run.said.length;

    let progressed = false;
    // Each action of a group is judged on the focus the ones before it left:
    // a typed or clicked control has it; after a key, where it went is unknown.
    const judged = newGroup(seen);
    for (const [index, action] of turn.actions.entries()) {
      if (action.action === 'finish') return { finished: { ok: action.success, say: action.say } };
      if (run.actions >= limits.maxActions) break;
      const outcome = await perform(run, action, seen, { verify: index === turn.actions.length - 1, judged });
      if (outcome.stop) return { stop: outcome.stop };
      if (outcome.halted) break;
      progressed ||= outcome.moved;
    }
    // Refused outright, it's the guards' to count: nothing was done again.
    if (run.actions > actionsBefore) run.signatures.set(signature, (run.signatures.get(signature) || 0) + 1);
    if (done) {
      const after = run.next ? { ok: true, snapshot: run.next } : await host.observe();
      if (after.ok) {
        run.next = after.snapshot;
        if (await done(after.snapshot)) return { done: true };
      }
    }
    if (run.failures >= limits.failures) return { stuck: { why: 'step_failed', say: `I got stuck: ${tidy(run.lastResult?.detail || 'it kept failing', 160)}` } };
    // A question put on the way (whoFirst) is no try of the step's, and a turn that came to their answer is no idle one.
    const questioned = run.said.length > saidBefore;
    if (questioned) started += 1;
    run.idle = progressed ? 0 : questioned ? run.idle : run.idle + 1;
    if (run.idle >= limits.idleSteps) return { stuck: { why: 'no_effect', say: 'I wasn’t getting anywhere, so I stopped.' } };
  }
}

/**
 * A finished task's steps, for learned.js to do again without the model; none when a choice of the user's decided one
 * of them. Learned, "open Hulu and play Modern Family" would press the profile chosen that day for good: a replay
 * consults no answers, so "use Sandeep's profile from now on" would change nothing, and the wrong profile would be
 * pressed on its own again. A task with a fork is worked by the model, and their choices as they are, each time.
 */
export const learnt = (run) => (run.forked || run.pointed ? {} : { trace: run.trace });

/**
 * @param {object} options  createRun's
 * @returns {Promise<{ok:boolean, say:string, cancelled?:boolean, declined?:boolean, unanswered?:boolean, actions:number, trace?:object[], chose?:{about:string, choice:string}[]}>}
 *   trace (on success, unless a choice of the user's decided a step: learnt): the steps done, as learned.js can do
 *   them again; unanswered: it ended on a question of its own (unsure); chose (when any, however the task ended):
 *   what the user answered to a question that said what it was about, for the caller to remember and give back as
 *   `ways` (onChose hears each as it's made)
 */
export async function runDesktopAgent(options) {
  const run = createRun(options);
  // What the user said stands in for the caption until the model gives a shorter one.
  run.onStep({ phase: 'task', caption: taskCaption(run.goal), by: 'goal' });
  const { finished, stop, stuck } = await lookStep(run);
  if (stop) return stop;
  if (stuck) return run.end(false, stuck.say);
  return run.end(finished.ok, finished.say, finished.ok ? learnt(run) : {});
}
