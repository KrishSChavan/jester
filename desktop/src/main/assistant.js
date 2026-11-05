/**
 * Jester Desktop's assistant (phase 6): what the voice matcher can't do, given
 * to an AI model that works the front app through its controls (agent/loop.js).
 *
 * The models are the user's own, saved through the extension's credentials.js
 * (their keys sealed on disk, never shown to a page) and paced through its
 * model pool, as in Chrome. A sensitive step waits for the user: a 👍, a
 * click on the pill, or a spoken "yes" — their choice, 2026-10-21.
 */

import { approvalAnswer } from '../../../jester-extension/src/background/browser-intent.js';
import { createPooledModelClient } from '../../../jester-extension/src/background/model-pool.js';
import { MSG } from '../../../jester-extension/src/common/constants.js';
import { clearConnection, connectionSummary, loadConnections, saveConnection } from '../../../jester-extension/src/common/credentials.js';
import { taskCaption } from './agent/actions.js';
import { createDesktopHost } from './agent/host.js';
import { runDesktopAgent } from './agent/loop.js';
import { replaySteps } from './agent/replay.js';
import { post } from './chrome-bridge.js';

/** A question nobody answers is a no. */
const APPROVAL_MS = 60000;
/** The last few commands and how they ended: context for "that" or "again". */
const REMEMBERED = 3;
const STOP = /^\W*(?:stop|cancel|never ?mind|stop it|that'?s enough)\W*$/i;
const WAITING = 'Waiting for your OK';
const REPLAYING = 'Doing it the way that worked before';
/** A replay's answer: what the model said the first time described that time's screen, not this one's. */
const REPLAYED = 'Done, the way it worked before.';
const STOPPING = 'Stopping…';
/** How long a new task waits for one it cancelled to stop acting. */
const STOP_MS = 3000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} deps
 * @param {{call: Function}} deps.driver
 * @param {(name:string) => Promise<{ok:boolean, text:string}>} deps.openApp
 * @param {(app:{pid:number, name?:string, bundleId?:string}) => Promise<unknown>} deps.activate  brings a running app back to the front
 * @param {(url:string) => Promise<unknown>} deps.openUrl
 * @param {Function} deps.dispatch
 * @param {(request:object) => Promise<{ok:boolean, text:string}>} [deps.place]  moves a window (voice-runner.js's)
 * @param {() => void} deps.listen  opens the mic for a spoken answer
 * @param {{show:(question:string) => void, hide:() => void}} deps.prompt  the question's window, with Allow and Don't
 * @param {number} [deps.exclude]  Jester's own process, whose windows the assistant never works in
 * @param {(task:Function) => Promise} [deps.quietly]  with the overlays hidden, as screen reading needs
 * @param {(busy:boolean) => void} [deps.onBusy]  a task began, or the last one ended
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {boolean} [deps.logScreens]  log the screen the model is shown each step: your own
 *   content, so only for debugging (JESTER_LOG_SCREENS)
 * @param {string} [deps.platform]
 */
export function createAssistant({ driver, openApp, activate, openUrl, dispatch, place, listen, prompt, exclude, quietly, onBusy = () => undefined, log = () => undefined, logScreens = false, platform = process.platform }) {
  const host = createDesktopHost({ driver, openApp, activate, openUrl, dispatch, place, quietly, exclude, platform });
  const model = createPooledModelClient({
    onSelected: ({ provider, model: id }) => log('assistant model:', provider, id),
    onLimited: ({ provider, model: id, readyAt }) => log('assistant model limited:', provider, id, 'until', new Date(readyAt).toLocaleTimeString()),
    onPacing: ({ waitMs }) => working(`Waiting ${Math.ceil(waitMs / 1000)} s for the model’s per-minute limit`)
  });
  let current = null;
  let approval = null;
  let previous = [];
  /** Screen text (what a control says, what a field holds, a menu's titles) goes in the log only when asked for. */
  const private_ = (text) => (logScreens ? text : String(text).replace(/“[^”]*”/g, '“…”').replace(/there is: .*$/, 'there is: …'));

  /** Tasks begin one at a time, each stopping whatever is current when its turn comes. */
  let starting = Promise.resolve();

  /** A task begun: the one before it stopped, and given a moment to finish its step, so two never act at once. */
  function begin(caption) {
    const turn = starting.then(async () => {
      const before = current;
      before?.controller.abort();
      if (before) await Promise.race([before.done, pause(STOP_MS)]);
      let finished;
      const task = { controller: new AbortController(), caption, step: '', done: new Promise((resolve) => (finished = resolve)) };
      task.finish = finished;
      current = task;
      onBusy(true);
      return task;
    });
    starting = turn.catch(() => undefined);
    return turn;
  }
  const end = (task) => {
    task.finish();
    if (current !== task) return;
    current = null;
    onBusy(false);
  };

  function show(voice) {
    post({ type: MSG.VOICE, voice: { position: 'bottom-center', ...voice } });
  }

  /** The pill at work: the task in a few words, and the step it's on. */
  function working(step = '') {
    if (current) current.step = step;
    show({ phase: 'thinking', task: current?.caption || '', step });
  }

  /** Waits for the user's yes or no on one step. */
  function ask(label, signal) {
    return new Promise((resolve) => {
      const settle = (yes) => {
        if (approval?.resolve !== resolve) return;
        clearTimeout(approval.timer);
        approval = null;
        prompt.hide();
        log('assistant approval:', label, yes ? 'allowed' : 'refused');
        working(yes ? label : '');
        resolve(yes);
      };
      approval = { resolve, label, settle, timer: setTimeout(() => settle(false), APPROVAL_MS) };
      signal.addEventListener('abort', () => settle(false), { once: true });
      // The question in its own window (clickable); the pill listens for a spoken yes.
      prompt.show(`${label}?`);
      working(WAITING);
      listen();
    });
  }

  return {
    /** Whether a model is set up to take commands. */
    async ready() {
      return (await loadConnections()).length > 0;
    },

    /**
     * @param {string} goal
     * @param {{note?:string}} [options]  note: a learned way of doing it that failed, and where
     * @returns {Promise<{ok:boolean, text:string, trace?:object[]}|null>} null: cancelled, nothing to say;
     *   trace (when done): the steps, for learned.js
     */
    async run(goal, { note = '' } = {}) {
      // A new command replaces one still running.
      const task = await begin('');
      working();
      try {
        const result = await runDesktopAgent({
          goal,
          note,
          previous,
          host,
          model,
          platform,
          signal: task.controller.signal,
          confirm: ({ label }) => ask(label, task.controller.signal),
          onStep: (step) => {
            // A task that's been replaced keeps logging, but leaves the pill to the new one.
            if (step.phase === 'task') {
              task.caption = step.caption;
              if (step.by === 'model') log('assistant task:', JSON.stringify(step.caption));
              if (current === task) working(task.step);
            } else if (step.phase === 'thinking' || step.phase === 'acting') {
              if (current === task) working(step.phase === 'acting' ? step.label : '');
            } else if (step.phase === 'seen') log(`assistant sees ${step.app} — ${JSON.stringify(step.window || '')}: ${step.elements} controls${logScreens ? `\n${step.screen}` : ''}`);
            else if (step.phase === 'acted') log(`assistant ${step.ok ? 'did' : 'couldn’t'}: ${step.label}${step.detail ? ` (${private_(step.detail)})` : ''}${logScreens && step.changes ? ` → ${step.changes}` : ''}`);
            else if (step.phase === 'invalid') log('assistant reply unusable:', step.detail);
            else if (step.phase === 'unseen') log('assistant couldn’t read the screen:', step.detail);
          }
        });
        log('assistant:', JSON.stringify(goal), '→', result.cancelled ? 'cancelled' : result.ok ? 'done' : 'not done', JSON.stringify(result.say), `· ${result.actions} steps`);
        previous = [...previous, { said: goal.slice(0, 200), result: result.cancelled ? 'cancelled' : result.ok ? 'done' : `failed: ${result.say}`.slice(0, 200) }].slice(-REMEMBERED);
        if (result.cancelled) return null;
        return { ok: result.ok, text: result.say || (result.ok ? 'Done.' : 'That didn’t work.'), ...(result.ok && result.trace?.length ? { trace: result.trace } : {}) };
      } finally {
        end(task);
      }
    },

    /**
     * A task learned before (learned.js), done again without the model.
     * @returns {Promise<{ok:true, text:string}|{ok:false, cancelled?:boolean, step:number, detail:string}>}
     */
    async replay(entry, goal) {
      const task = await begin(taskCaption(goal));
      working(REPLAYING);
      try {
        const result = await replaySteps({
          steps: entry.steps,
          goal,
          host,
          platform,
          signal: task.controller.signal,
          onStep: (step) => {
            if (step.phase === 'acting' && current === task) working(step.label);
          }
        });
        log('assistant replay:', JSON.stringify(goal), result.ok ? 'done' : `stopped at step ${result.step + 1}: ${private_(result.detail)}`);
        if (!result.ok) return result;
        previous = [...previous, { said: goal.slice(0, 200), result: 'done' }].slice(-REMEMBERED);
        return { ok: true, text: REPLAYED };
      } finally {
        end(task);
      }
    },

    get running() {
      return !!current;
    },

    /** Stops the task running, and resolves once it has (or after a moment). */
    async cancel() {
      const task = current;
      if (!task) return;
      task.controller.abort();
      working(STOPPING);
      await Promise.race([task.done, pause(STOP_MS)]);
    },

    /** The pill's Allow / Don't. */
    answer(yes) {
      approval?.settle(!!yes);
    },

    /** A spoken command, if it's for the assistant: an answer, or "stop". */
    heard(text) {
      if (approval) {
        const answer = approvalAnswer(text);
        if (answer) approval.settle(answer === 'yes');
        else {
          prompt.show(`${approval.label}? Say yes or no.`);
          listen();
        }
        return true;
      }
      if (current && STOP.test(text)) {
        current.controller.abort();
        return true;
      }
      return false;
    },

    /** The mic, opened for a spoken yes, stopped with none: the pill goes back to waiting, not to "No command heard". */
    micEnded(voice) {
      if (approval && (voice?.phase === 'answer' || voice?.active === false)) working(WAITING);
    },

    /** A gesture, if it answers a question: 👍 yes, 👎 no. */
    gesture(name) {
      if (!approval || !['Thumb_Up', 'Thumb_Down'].includes(name)) return false;
      approval.settle(name === 'Thumb_Up');
      return true;
    },

    /** For Settings: the saved models (keys masked), and changes to them. */
    connections: {
      list: () => connectionSummary(),
      save: (input) => saveConnection(input),
      remove: (id) => clearConnection(id)
    }
  };
}
