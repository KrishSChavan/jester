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
import { createDesktopHost } from './agent/host.js';
import { runDesktopAgent } from './agent/loop.js';
import { post } from './chrome-bridge.js';

/** A question nobody answers is a no. */
const APPROVAL_MS = 60000;
/** The last few commands and how they ended: context for "that" or "again". */
const REMEMBERED = 3;
const STOP = /^\W*(?:stop|cancel|never ?mind|stop it|that'?s enough)\W*$/i;
const WAITING = 'Waiting for your OK';

/**
 * @param {object} deps
 * @param {{call: Function}} deps.driver
 * @param {(name:string) => Promise<{ok:boolean, text:string}>} deps.openApp
 * @param {(app:{pid:number, name?:string, bundleId?:string}) => Promise<unknown>} deps.activate  brings a running app back to the front
 * @param {(url:string) => Promise<unknown>} deps.openUrl
 * @param {Function} deps.dispatch
 * @param {() => void} deps.listen  opens the mic for a spoken answer
 * @param {{show:(question:string) => void, hide:() => void}} deps.prompt  the question's window, with Allow and Don't
 * @param {number} [deps.exclude]  Jester's own process, whose windows the assistant never works in
 * @param {(task:Function) => Promise} [deps.quietly]  with the overlays hidden, as screen reading needs
 * @param {(...parts:any[]) => void} [deps.log]
 * @param {boolean} [deps.logScreens]  log the screen the model is shown each step: your own
 *   content, so only for debugging (JESTER_LOG_SCREENS)
 * @param {string} [deps.platform]
 */
export function createAssistant({ driver, openApp, activate, openUrl, dispatch, listen, prompt, exclude, quietly, log = () => undefined, logScreens = false, platform = process.platform }) {
  const host = createDesktopHost({ driver, openApp, activate, openUrl, dispatch, quietly, exclude });
  const model = createPooledModelClient({
    onSelected: ({ provider, model: id }) => log('assistant model:', provider, id),
    onLimited: ({ provider, model: id, readyAt }) => log('assistant model limited:', provider, id, 'until', new Date(readyAt).toLocaleTimeString()),
    onPacing: ({ waitMs }) => show({ phase: 'thinking', step: `Waiting ${Math.ceil(waitMs / 1000)} s for the model’s per-minute limit` })
  });
  let current = null;
  let approval = null;
  let previous = [];

  function show(voice) {
    post({ type: MSG.VOICE, voice: { position: 'bottom-center', ...voice } });
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
        show({ phase: 'thinking', step: yes ? label : '' });
        resolve(yes);
      };
      approval = { resolve, label, settle, timer: setTimeout(() => settle(false), APPROVAL_MS) };
      signal.addEventListener('abort', () => settle(false), { once: true });
      // The question in its own window (clickable); the pill listens for a spoken yes.
      prompt.show(`${label}?`);
      show({ phase: 'thinking', step: WAITING });
      listen();
    });
  }

  return {
    /** Whether a model is set up to take commands. */
    async ready() {
      return (await loadConnections()).length > 0;
    },

    /** @returns {Promise<{ok:boolean, text:string}|null>} null: cancelled, nothing to say */
    async run(goal) {
      // A new command replaces one still running.
      current?.controller.abort();
      const task = { controller: new AbortController() };
      current = task;
      show({ phase: 'thinking', step: '' });
      try {
        const result = await runDesktopAgent({
          goal,
          previous,
          host,
          model,
          platform,
          signal: task.controller.signal,
          confirm: ({ label }) => ask(label, task.controller.signal),
          onStep: (step) => {
            if (step.phase === 'thinking' || step.phase === 'acting') show({ phase: 'thinking', step: step.phase === 'acting' ? step.label : '' });
            else if (step.phase === 'seen') log(`assistant sees ${step.app} — ${JSON.stringify(step.window || '')}: ${step.elements} controls${logScreens ? `\n${step.screen}` : ''}`);
            else if (step.phase === 'acted') log(`assistant ${step.ok ? 'did' : 'couldn’t'}: ${step.label}${step.detail ? ` (${step.detail})` : ''}`);
            else if (step.phase === 'invalid') log('assistant reply unusable:', step.detail);
            else if (step.phase === 'unseen') log('assistant couldn’t read the screen:', step.detail);
          }
        });
        log('assistant:', JSON.stringify(goal), '→', result.cancelled ? 'cancelled' : result.ok ? 'done' : 'not done', JSON.stringify(result.say), `· ${result.actions} steps`);
        previous = [...previous, { said: goal.slice(0, 200), result: result.cancelled ? 'cancelled' : result.ok ? 'done' : `failed: ${result.say}`.slice(0, 200) }].slice(-REMEMBERED);
        if (result.cancelled) return null;
        return { ok: result.ok, text: result.say || (result.ok ? 'Done.' : 'That didn’t work.') };
      } finally {
        if (current === task) current = null;
      }
    },

    get running() {
      return !!current;
    },

    cancel() {
      current?.controller.abort();
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
      if (approval && (voice?.phase === 'answer' || voice?.active === false)) show({ phase: 'thinking', step: WAITING });
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
