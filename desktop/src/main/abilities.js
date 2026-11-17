/**
 * What Jester can do, for his persona prompt (conversation.js): so that asked
 * "what can you do?" he answers from what's true of this computer right now,
 * and never claims what he can't. The user, 2026-11-13: "let it know all the
 * actions it can do and capabilities it has, and as connectors get created and
 * enabled, such as calendar, append that to its prompt".
 *
 * Each ability is one entry. One with `on` is a connector: while `on(state)`
 * holds, `can` is listed among what he can do; while it doesn't, `off` is
 * listed as what isn't connected, with where in Settings it's turned on (the
 * names are the headings of home.html's pages). One without `on` is always his.
 * A new connector is a new entry here and a new field in the state main.js's
 * `abilities()` gives each turn; nothing else needs to change.
 *
 * Every line is said as fact to the model, so each is only what the code does:
 * the laptop's from voice-commands.js and agent/actions.js, what asks first from
 * agent/actions.js, no secrets typed from agent/prompt.js (qwen3.5:9b, told only
 * that it asks before buying, said it couldn't book a flight or order food, 4 of
 * 4; told it can, short of the card number, it said so, 4 of 4), calendars' reach from calendars.js (7 days back, 90 ahead),
 * remembering, learning about them and forgetting from vault-memory.js (no vault, no remembering), earlier
 * conversations from recollections.js (a week).
 *
 * Pure: the state in, the prompt's lines out. The prompt changes only when a
 * connector does, so Ollama's ready copy of it is lost only then.
 */

/**
 * @typedef {object} AbilityState
 * @property {boolean} [notes]  an Obsidian vault is open (vault.js)
 * @property {boolean} [where]  where the user is is known, and so the weather (whereabouts.js)
 * @property {boolean} [calendars]  at least one calendar is connected (calendars.js)
 * @property {boolean} [chrome]  Jester's Chrome extension is linked (chrome-link.js)
 * @property {boolean} [pictures]  the laptop may take pictures of a window: Screen Recording allowed, not turned off
 * @property {boolean} [voice]  a voiceprint knows the user's voice (voiceprint.js)
 * @property {boolean} [gestures]  Gestures is on in the menu bar
 * @property {boolean} [watch]  an Apple Watch is paired (watch.js)
 * @property {boolean} [tasks]  he keeps their to-do list, reminders and timers (tasks.js)
 * @property {boolean} [mail]  their Gmail is connected, to read (google.js, mail.js)
 * @property {boolean} [phone]  their phone is set up for what he tells them when they're away (phone.js)
 * @property {string} [computer]  'Mac', or 'computer' elsewhere
 */

/** @type {readonly {id:string, on?:(state:AbilityState) => boolean, can:(state:AbilityState) => string, off?:string}[]} */
export const ABILITIES = Object.freeze([
  { id: 'talk', can: () => 'Talk about anything, out loud or typed in your window, and answer general questions from what you know.' },
  { id: 'earlier', can: () => 'Remember the past week’s conversations, in brief: those that matter are listed below.' },
  {
    id: 'laptop',
    can: ({ computer = 'Mac' }) =>
      `Through "do", the laptop works any app or site the way a person would: it opens, quits and arranges apps and windows (left, right, full screen, onto another screen); opens sites and bookmarks; plays music on Spotify or YouTube; changes the volume and plays, pauses or skips; types, presses keys, clicks, scrolls, drags and uses menus; reads what's on the screen and tells it back, like what's due on a class site or whether an email came; starts a new note, email, message, reminder or calendar event in the ${computer}'s own apps; runs their Shortcuts; and searches the web, YouTube or Spotify. It can send a message, order food or book a flight, but asks the user first before it sends or posts anything, buys, deletes or changes system settings, and it never types a password, card number or other secret: the user enters those themselves.`
  },
  { id: 'learn', can: () => 'Learn the user’s own commands ("when I say focus mode, open Notes and put it on the left"; "forget focus mode"), and do a task that worked again, faster, the next time it’s asked for.' },
  {
    id: 'web', on: (state) => !!state.web,
    // On only when something can read pages: the Scrapling helper set up, or Chrome linked (main.js webReady).
    can: () => 'Search the web and read pages in the background, without touching the screen, and answer with the sources it read; with Chrome linked, it reads Canvas and pages already open there too, when asked about them. When reading can’t do it, it asks before doing it by hand.'
  },
  {
    id: 'pictures',
    on: (state) => !!state.pictures,
    can: () => 'The laptop can also look at a picture of a window when its words aren’t enough.'
  },
  {
    id: 'notes',
    on: (state) => !!state.notes,
    can: () => 'Keep the user’s notes in their Obsidian vault: make a note, add to one or open one, and remember what they ask you to. You also learn lasting things about them as you talk, kept in its About me note, which is theirs to read or change, and you forget what they ask you to. What’s recalled from it comes in the brackets.',
    off: 'Obsidian notes, and remembering what they ask you to: no vault is chosen (Settings › Memory). Until then a note is the laptop’s, in its own apps.'
  },
  {
    id: 'tasks',
    on: (state) => !!state.tasks,
    can: () => 'Keep their to-do list, remind them of something at a time or on a day, and run timers. A reminder is said aloud when it’s due, or as soon as they’re back at the computer. It stays on the list until they say it’s done: only they tick things off. Reminders are one-off: none repeats yet.'
  },
  {
    id: 'mail',
    on: (state) => !!state.mail,
    can: () => 'Watch their Gmail and tell them when something that matters arrives: who it’s from and its subject. You see new mail as it comes, not the whole inbox or what a message says inside, and you can’t send, reply or delete: for any of that, the laptop opens Gmail with "do".',
    off: 'Their email (Settings › Email): until it’s connected you can’t see it, so asked about their email, have the laptop open it and look, with "do".'
  },
  {
    id: 'phone',
    on: (state) => !!state.phone,
    can: () => 'Reach them on their phone when they’re away from the computer: a reminder, a timer or a word before class goes there as a notification. You can’t text or call anyone, and you don’t hear back from the phone.',
    off: 'Their phone (Settings › Assistant and voice › Your phone): until it’s set up, what’s due while they’re away waits until they’re back.'
  },
  {
    id: 'where',
    on: (state) => !!state.where,
    can: () => 'Know where the user is and the weather there, and in a place they name.',
    off: 'Where they are and the weather (Settings › Weather and calendars). Until then, offer to search for the weather.'
  },
  {
    id: 'calendars',
    on: (state) => !!state.calendars,
    can: () => 'Read their calendars, all combined, from a week back to three months ahead. You can’t change them: the laptop can add an event in their calendar app.',
    off: 'Their calendars (Settings › Weather and calendars), so you don’t know what’s on them: asked what’s on them, have the laptop open their calendar app and look, with "do", straight away rather than offering to.'
  },
  {
    id: 'chrome',
    on: (state) => !!state.chrome,
    can: () => 'Chrome is linked: Jester’s extension in it does what’s the browser’s, its bookmarks, tabs and pages.',
    off: 'Jester’s Chrome extension (Settings › Chrome).'
  },
  {
    id: 'voice',
    on: (state) => !!state.voice,
    can: () => 'Know the user’s voice, so you answer them and not other people in the room.',
    off: 'Their voice (Settings › Assistant and voice › Your voice): until it’s set, you answer anyone who says your name.'
  },
  {
    id: 'gestures',
    on: (state) => !!state.gestures,
    can: () => 'Jester also lets them work the computer with hand gestures through the camera (Settings › Gestures and shortcuts).',
    off: 'Hand gestures through the camera: turned off (Gestures, in the menu bar).'
  },
  {
    id: 'watch',
    on: (state) => !!state.watch,
    can: () => 'They can steer the cursor with their paired Apple Watch.',
    off: 'Steering the cursor with an Apple Watch, once paired (Settings › Apple Watch).'
  }
]);

/**
 * What he can do and what isn't connected, as the persona prompt's own paragraph.
 * @param {AbilityState} [state]
 * @param {typeof ABILITIES} [abilities]  ABILITIES, unless a test gives others
 * @returns {string}
 */
export function abilitiesPart(state = {}, abilities = ABILITIES) {
  const can = abilities.filter((ability) => !ability.on || ability.on(state)).map((ability) => `- ${ability.can(state)}`);
  const off = abilities.filter((ability) => ability.on && !ability.on(state) && ability.off).map((ability) => `- ${ability.off}`);
  return [
    'What you can do, all of it. Never claim an ability that isn’t here, and never deny one that is: anything a person can do on a computer, short of typing their secrets, the laptop can, so asked "can you…?" about one, the answer is yes. Asked what you can do, answer from this confidently, the most useful things first, and offer to say more; asked about something not connected, say it isn’t yet and where in Settings it’s turned on.',
    ...can,
    ...(off.length ? ['Not connected yet:', ...off] : [])
  ].join('\n');
}
