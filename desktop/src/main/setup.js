/**
 * Getting started: what a new user has to set up before Jester's any use, and
 * what they can add when they want it, as one list with where each is done.
 * Nothing here is about one person: whoever opens him for the first time is
 * walked through the same things, in the order they matter.
 *
 * Pure: what's known of the computer in, the list out. main.js gathers the
 * first; his window draws the second (home.js, the Getting started screen).
 */

/**
 * @typedef {object} SetupState
 * @property {string[]} [missing]  permissions he needs and hasn't got, by their labels
 * @property {boolean} [model]  there's a model for him to talk with: a saved one ticked Talking, or one on this computer
 * @property {boolean} [otherModel]  a model is saved, and none of them is for talking
 * @property {boolean} [listening]  he's listening for his name (the continuous assistant is on)
 * @property {boolean} [hearing]  the recognizer's model is downloaded
 * @property {boolean} [ownVoice]  his own voice's model is downloaded
 * @property {boolean} [voiceprint]  he's been taught the user's voice
 * @property {boolean} [vault]  an Obsidian vault is chosen
 * @property {boolean} [day]  where they are, or a calendar, is connected
 * @property {boolean} [phone]  their phone is set up and on
 * @property {boolean} [mail]  their Gmail is signed in to
 * @property {boolean} [chrome]  his Chrome extension is linked
 * @property {{fetching?:{id:string}|null, waiting?:string[], error?:string, words?:string, firstMb?:number}|null} [fetch]
 *   how the download of what he hears and speaks with stands (main.js modelsState)
 */

/** What he hears with, and his own voice, as speech/model-fetch.js names them. */
const HEARING = ['vad', 'parakeet-110m', 'parakeet-0.6b'];
const OWN_VOICE = ['kokoro'];

/**
 * A step that waits on a download: how it stands, and the button that starts it when nothing has. He starts it
 * himself the first time he's opened, so the button is for one that was stopped, or failed.
 */
function downloading(fetch, ids, idle) {
  const now = ids.includes(fetch?.fetching?.id);
  if (now) return { why: fetch.words || 'Downloading…' };
  if (fetch?.waiting?.some((id) => ids.includes(id))) return { why: fetch.error ? fetch.words : 'Waiting its turn to download.' , ...(fetch.error ? { act: 'fetch-models', button: 'Try again' } : {}) };
  if (fetch?.error) return { why: fetch.words, act: 'fetch-models', button: 'Try again' };
  return { why: idle, act: 'fetch-models', button: 'Download' };
}

/**
 * @param {SetupState} state
 * @returns {{id:string, title:string, why:string, done:boolean, required:boolean, go:string, act?:string, button?:string}[]}  what's needed
 *   first, then what's optional; `go` is the screen of his window where it's done; `act`, when the step's own button
 *   does it there and then ('fetch-models': the download), with what the `button` says
 */
export function setupSteps(state = {}) {
  const missing = Array.isArray(state.missing) ? state.missing : [];
  return [
    {
      id: 'permissions',
      title: 'Let him hear you and work the computer',
      why: missing.length ? `macOS has to allow it: ${missing.join(' and ')}.` : 'macOS has allowed what he needs.',
      done: missing.length === 0,
      required: true,
      go: 'settings/permissions'
    },
    {
      id: 'model',
      title: 'Give him a model to think with',
      why: state.model
        ? 'He has one.'
        : state.otherModel
          ? 'None of your models is ticked for Talking, so he can’t answer you: tick Talking on one of them.'
          : 'Paste a key for Claude, Gemini, Groq or another, or run Ollama on this computer for one that costs nothing.',
      done: !!state.model,
      required: true,
      go: 'settings/models'
    },
    {
      id: 'hearing',
      title: 'Download what he hears with',
      ...(state.hearing
        ? { why: 'It’s here: what you say is recognized on this computer.' }
        : downloading(state.fetch, HEARING, `Not downloaded yet${state.fetch?.firstMb ? `: about ${state.fetch.firstMb} MB, once` : ''}. You can type to him meanwhile.`)),
      done: !!state.hearing,
      required: true,
      go: 'settings/general'
    },
    {
      id: 'listening',
      title: 'Have him listen for his name',
      why: state.listening ? 'He’s listening: say “Jester”, then what you want.' : 'Off until you turn it on, here or with the microphone under the orb. Until then he hears nothing, and you can type to him.',
      done: !!state.listening,
      required: false,
      go: 'settings/assistant'
    },
    {
      id: 'voiceprint',
      title: 'Teach him your voice',
      why: state.voiceprint ? 'He knows it, and answers you and not the room.' : 'Read five sentences, so he answers you and not anyone who says his name.',
      done: !!state.voiceprint,
      required: false,
      go: 'settings/assistant'
    },
    {
      id: 'ownVoice',
      title: 'Give him his own voice',
      ...(state.ownVoice ? { why: 'He has it, made on this computer.' } : downloading(state.fetch, OWN_VOICE, 'Until it’s downloaded he speaks with the computer’s voice.')),
      done: !!state.ownVoice,
      required: false,
      go: 'settings/assistant'
    },
    {
      id: 'vault',
      title: 'A place for what he remembers',
      why: state.vault ? 'He keeps his notes and what he learns in your Obsidian vault.' : 'Choose an Obsidian vault and he remembers what matters, in notes you can read and change.',
      done: !!state.vault,
      required: false,
      go: 'settings/memory'
    },
    {
      id: 'day',
      title: 'Your day: weather and calendars',
      why: state.day ? 'Connected.' : 'Tell him where you are and paste a calendar’s link, for the weather, a morning brief and a word before class.',
      done: !!state.day,
      required: false,
      go: 'settings/day'
    },
    {
      id: 'phone',
      title: 'Your phone, for when you’re away',
      why: state.phone ? 'Reminders reach you there when you’re not at the computer.' : 'With the ntfy app, reminders and timers reach you when you’re not at the computer.',
      done: !!state.phone,
      required: false,
      go: 'settings/assistant'
    },
    {
      id: 'mail',
      title: 'Your email',
      why: state.mail ? 'He watches your Gmail and tells you what matters.' : 'Sign in with Google, to read only, and he tells you when something important arrives.',
      done: !!state.mail,
      required: false,
      go: 'settings/mail'
    },
    {
      id: 'chrome',
      title: 'Chrome',
      why: state.chrome ? 'His extension is linked: he works your tabs and pages.' : 'Add his extension to Chrome and he works your tabs, bookmarks and pages too.',
      done: !!state.chrome,
      required: false,
      go: 'settings/chrome'
    }
  ];
}

/** How it stands: whether he's ready to use, and how much is left of what's needed and of what's optional. */
export function setupSummary(steps) {
  const left = steps.filter((step) => step.required && !step.done).length;
  const more = steps.filter((step) => !step.required && !step.done).length;
  return { ready: left === 0, left, more, words: left ? `${left} thing${left === 1 ? '' : 's'} left before he’s ready` : more ? `Ready. ${more} more you can add` : 'All set' };
}
