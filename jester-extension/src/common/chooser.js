/**
 * A page that asks who is there: which profile, which account. Only the user can say, so a click on one of its
 * choices is held back and they are asked, unless what they asked for, or an answer they gave before, names one.
 * 2026-11-21: "go to Hulu and start playing Modern Family" met Hulu's profile picker, and the model clicked "Switch
 * profile to Sandeep Chavan" three times (the wrong profile) and stopped; a Google account chooser later went the
 * same way.
 *
 * It works from what an observation has (content/agent-page.js): each control's role and name, the headings in view
 * as elements of role "heading", and the page's title and address. Nothing there says which controls sit together,
 * so "the choices under a heading" are the controls of the clicked one's kind that aren't the page's housekeeping.
 */
import { siteOf } from './sites.js';

/** A control named like this is a choice of who, whatever page it is on. */
const NAMED = /^(switch profile to|switch to profile|continue as|sign in as)\s+(\S.*)$/i;
/** "Use …" and "Choose …" are choices of who only beside one of those, or under a chooser's heading: "Use my location" and "Choose file" are not. */
const LOOSE = /^(use|choose)\s+(\S.*)$/i;
/**
 * How a chooser is headed, the whole of it: "Who’s watching?", "Choose an account", "Choose an account to continue to
 * YouTube". A heading that only begins that way is for something else: "Choose your profile picture" (with Upload a
 * photo, Remove photo and Save under it) was asked about as "Which GitHub profile should I use?".
 */
const TITLE = '(?:who(?:[’\']?s| is) watching(?:\\s+[\\p{L}\\p{N}+]+)?|(?:choose|select|pick) (?:an?|your|the) (?:account|profile)(?:\\s+to\\s+(?:continue|sign in|log in|use|watch|start)\\b[^|·–—]*)?)[\\s?.!:…]*';
const HEADED = new RegExp(`^${TITLE}$`, 'iu');
const TITLED = new RegExp(`(?:^|[|:·–—-]\\s*)${TITLE}(?:$|[|:·–—-])`, 'iu');
/**
 * Controls a chooser page has beside its choices. What carries a choice out is among them: under "Who’s watching?"
 * with Krish, Sandeep and Continue, Continue was offered as a third profile, and with Krish remembered a click on
 * it was turned into a click on Krish every time, so the task could never press it.
 */
const HOUSEKEEPING = /^(?:add|new|create|manage|edit|delete|remove|learn|help|privacy|terms|sign ?out|log ?out|back|cancel|close|skip|done|settings|search|menu|home|more|about|cookies?|language|next|previous|forgot|join|sign ?up|log ?in|sign ?in|continue|submit|save|ok|okay|confirm|upload|apply|select|start|change|update|exit|dismiss|not now|maybe later)\b/i;
/** More "choices" than this under a heading is a page of something else. */
const MOST_HEADED = 8;
/** A name that is also an everyday word names a choice only when said of a profile or an account: "a kids show" does not ask for the Kids profile. */
const EVERYDAY = new Set(['kids', 'guest', 'family', 'home', 'work', 'personal', 'school', 'main', 'default', 'me', 'mom', 'dad', 'new', 'other', 'another']);
const FILLER = new Set(['the', 'and', 'for', 'use', 'profile', 'profiles', 'account', 'accounts', 'user', 'signed', 'out', 'com']);
const PROPER = { youtube: 'YouTube', 'youtube music': 'YouTube Music', github: 'GitHub', linkedin: 'LinkedIn', chatgpt: 'ChatGPT', whatsapp: 'WhatsApp', ebay: 'eBay' };
const ORDINALS = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5 };

const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
/** Words to compare by. An address counts by what is before its @: "krish@gmail.com" is not named by "open Gmail". */
const wordsOf = (text) => tidy(text).normalize('NFKC').toLowerCase().replace(/@[\w.-]+/g, ' ').match(/[\p{L}\p{N}]+/gu) || [];
const titled = (text) => tidy(text).replace(/(^|\s)(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase());

/** A site's name as a person says it, from an address: "Hulu", "Google" (accounts.google.com), "Disney Plus". '' for none. */
export function siteName(address) {
  let host;
  try { host = new URL(address).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  const listed = siteOf(address);
  if (listed) return PROPER[listed.key] || titled(listed.key);
  const labels = host.split('.');
  if (labels.length < 2) return titled(labels[0] || '');
  // "bbc.co.uk" is BBC's, not Co's.
  const second = labels.length > 2 && labels.at(-1).length === 2 && /^(?:co|com|org|net|ac|gov|edu)$/.test(labels.at(-2)) ? labels.at(-3) : labels.at(-2);
  return PROPER[second] || titled(second);
}

function holds(words, run) {
  if (!run.length) return false;
  for (let at = 0; at + run.length <= words.length; at++) {
    if (run.every((word, index) => words[at + index] === word)) return true;
  }
  return false;
}

/**
 * Whether words name one choice and not another: its whole name, or a word of it no other choice has ("Krish" of
 * "Krish Chavan" beside "Sandeep Chavan"). `plainly`: words that are an answer to "which?", where "kids" means Kids.
 */
function names(text, choice, others, plainly = false) {
  const said = wordsOf(text);
  const name = wordsOf(choice.name).filter((word) => !FILLER.has(word));
  const taken = new Set(others.flatMap((other) => wordsOf(other.name)));
  const own = holds(said, name) ? name : name.filter((word) => word.length > 2 && !taken.has(word) && said.includes(word));
  if (!own.length) return false;
  if (plainly || own.some((word) => !EVERYDAY.has(word))) return true;
  return own.some((word) => new RegExp(`\\b${word}(?:[’']s)?\\s+(?:profile|account)\\b|\\b(?:profile|account|user)\\s+(?:called\\s+|named\\s+)?${word}\\b|\\bas\\s+(?:the\\s+|a\\s+)?${word}\\b`, 'i').test(tidy(text)));
}

/**
 * The chooser on a page, if it is one: {site, kind: 'profile'|'account', about: "Hulu profile", choices: [{id, name,
 * label}]}, else null. `role`: the kind of control a choice under a heading would be (the clicked one's); with none,
 * a page that is only headed like a chooser comes back with no choices, which is still enough to say where a task
 * got stuck.
 */
export function findChooser({ elements, url = '', title = '', role = '' } = {}) {
  const seen = (Array.isArray(elements) ? elements : []).filter((entry) => entry && typeof entry.id === 'string' && typeof entry.name === 'string');
  const controls = seen.filter((entry) => entry.role !== 'heading' && !entry.disabled && entry.name !== '(unnamed)');
  const heading = seen.find((entry) => entry.role === 'heading' && HEADED.test(tidy(entry.name)))?.name || (TITLED.test(tidy(title)) ? tidy(title) : '');
  const site = siteName(url);
  const named = controls.some((entry) => NAMED.test(tidy(entry.name)));
  const choices = [];
  const add = (entry, name) => {
    const short = tidy(name).slice(0, 60).trim();
    const known = choices.find((choice) => choice.name.toLowerCase() === short.toLowerCase());
    // The same choice twice (its picture and its name, each a control) is one choice.
    if (known) known.ids.push(entry.id);
    else if (short) choices.push({ id: entry.id, ids: [entry.id], name: short, label: tidy(entry.name).slice(0, 120) });
  };
  for (const entry of controls) {
    const label = tidy(entry.name);
    const match = NAMED.exec(label) || ((named || heading) && LOOSE.exec(label)) || null;
    if (!match) continue;
    // "Use another account" is its own name: "another account" alone would not say what choosing it does.
    add(entry, /^(?:another|a different|a new|other|new)\b/i.test(match[2]) ? label : match[2]);
  }
  let evidence = `${heading} ${choices.map((choice) => choice.label).join(' ')}`;
  if (choices.length < 2) {
    choices.length = 0;
    if (!heading) return null;
    evidence = heading;
    if (role) {
      const under = controls.filter((entry) => entry.role === role && tidy(entry.name).length <= 60 && !HOUSEKEEPING.test(tidy(entry.name)) &&
        tidy(entry.name).toLowerCase() !== site.toLowerCase());
      if (under.length <= MOST_HEADED) for (const entry of under) add(entry, entry.name);
      if (choices.length < 2) choices.length = 0;
    }
  }
  const kind = /profile|watching/i.test(evidence) ? 'profile' : 'account';
  return { site, kind, about: [site, kind].filter(Boolean).join(' '), choices };
}

/** A remembered answer ("Hulu profile: Krish") that is about this chooser: its site's, or its very subject. */
function about(way, chooser) {
  const line = tidy(way);
  const split = /^([^:]{1,60}):\s*(\S.*)$/.exec(line);
  const subject = split ? split[1] : line;
  const site = wordsOf(chooser.site);
  if (!(site.length ? holds(wordsOf(subject), site) : tidy(subject).toLowerCase() === chooser.about.toLowerCase())) return null;
  return split ? split[2] : line;
}

/**
 * What to do with a click the model chose, on the page it was chosen from.
 * @param {object} given
 * @param {object[]} given.elements  the observation's elements: {id, role, name, disabled?}
 * @param {string} given.targetId  the element the model would click
 * @param {string} [given.goal]  the user's request, with what it was taken to mean
 * @param {string[]} [given.ways]  the user's earlier answers, oldest first: "Hulu profile: Krish"
 * @param {string} [given.url]
 * @param {string} [given.title]
 * @returns {null | {do:'click', elementId:string, name:string, about:string} | {do:'ask', question:string, options:string[], about:string, choices:object[]}}
 *   null: not a choice of who, carry on as chosen. click: the goal or an earlier answer names this one, whichever
 *   the model picked. ask: nothing names one, so the user is asked which and nothing is clicked meanwhile.
 */
export function chooserStep({ elements, targetId, goal = '', ways = [], url = '', title = '' } = {}) {
  const target = (Array.isArray(elements) ? elements : []).find((entry) => entry?.id === targetId);
  if (!target) return null;
  const chooser = findChooser({ elements, url, title, role: target.role });
  if (!chooser || chooser.choices.length < 2 || !chooser.choices.some((choice) => choice.ids.includes(targetId))) return null;
  const { choices } = chooser;
  const others = (choice) => choices.filter((other) => other !== choice);
  const click = (choice) => ({ do: 'click', elementId: choice.ids.includes(targetId) ? targetId : choice.id, name: choice.name, about: chooser.about });
  const asked = choices.filter((choice) => names(goal, choice, others(choice)));
  if (asked.length === 1) return click(asked[0]);
  // Nothing in the request: the newest earlier answer about this site that names one of them.
  if (!asked.length) {
    for (const way of [...(Array.isArray(ways) ? ways : [])].reverse()) {
      const answer = typeof way === 'string' ? about(way, chooser) : null;
      const meant = answer ? chooserPick(choices, answer, { strict: true, plainly: true }) : null;
      if (meant) return click(meant);
    }
  }
  return { do: 'ask', question: `Which ${chooser.about} should I use?`, options: choices.slice(0, 4).map((choice) => choice.name), about: chooser.about, choices };
}

/**
 * An answer that turns choices down, or says which by saying which not: "neither", "not Krish". Taken by its names
 * it would pick the very one refused, so it picks none, and the words go on as the user's own.
 */
const DECLINED = /\b(?:neither|none|nobody|no one|not|nor|never|except|but|other than|don[’']?t|doesn[’']?t|isn[’']?t|won[’']?t|can[’']?t)\b/i;

/** A word as it sounds, near enough: its consonants, with the letters that are said alike made one. */
function sound(word) {
  const plain = word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
  return plain.replace(/ph/g, 'f').replace(/gh/g, '').replace(/ch|ck|q/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/x/g, 'ks').replace(/sh|z/g, 's').replace(/th/g, 't').replace(/v/g, 'f')
    .replace(/(?!^)[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1');
}

/** Whether one word is another with at most `most` letters added, dropped or changed. */
function within(a, b, most) {
  if (Math.abs(a.length - b.length) > most) return false;
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length] <= most;
}

/**
 * A name as a microphone heard it: "Chris" for Krish, "Sundip" for Sandeep. The same sound, or a letter or two out
 * in a longer word. Short words and short sounds are left alone: "what" is not Wyatt.
 */
function heardAs(said, word) {
  if (said.length < 3 || word.length < 3) return false;
  const [a, b] = [sound(said), sound(word)];
  if (a.length >= 3 && a === b) return true;
  const short = Math.min(said.length, word.length);
  return short >= 4 && within(said, word, short >= 7 ? 2 : 1);
}

/**
 * The choice an answer means: by its name, a word only it has, its place ("the second one"), or a name misheard
 * that is near one of them and no other; null when it means none, or more than one. An answer that named nothing
 * used to open the way for the model's own pick: "Chris", as the mic heard Krish, ended with Sandeep clicked.
 * `strict`: words not said in answer to these very choices (an earlier answer, a remembered one) pick by name alone:
 * "the first one" said of plans is not the first profile. `plainly`: the words were an answer to "which?", where
 * "kids" means Kids.
 */
export function chooserPick(choices, answer, { strict = false, plainly = !strict } = {}) {
  const list = (Array.isArray(choices) ? choices : []).filter((choice) => choice && typeof choice.name === 'string');
  const said = tidy(answer).replace(/[.!?]+$/, '');
  if (!said || !list.length) return null;
  const exact = list.filter((choice) => choice.name.toLowerCase() === said.toLowerCase());
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  if (DECLINED.test(said)) return null;
  const place = strict ? null : /^(?:the\s+)?(first|second|third|fourth|fifth|sixth|last)(?:\s+(?:one|option|choice))?$/i.exec(said)?.[1].toLowerCase();
  if (place) return (place === 'last' ? list.at(-1) : list[ORDINALS[place]]) || null;
  const others = (choice) => list.filter((other) => other !== choice);
  const meant = list.filter((choice) => names(said, choice, others(choice), plainly));
  if (meant.length || strict) return meant.length === 1 ? meant[0] : null;
  const heard = wordsOf(said).filter((word) => !FILLER.has(word));
  if (!heard.length || heard.length > 4) return null;
  const near = list.filter((choice) => {
    const taken = new Set(others(choice).flatMap((other) => wordsOf(other.name)));
    return wordsOf(choice.name).some((word) => !FILLER.has(word) && !taken.has(word) && heard.some((one) => heardAs(one, word)));
  });
  return near.length === 1 ? near[0] : null;
}
