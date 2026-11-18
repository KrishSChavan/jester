/**
 * The user's chats from Claude and ChatGPT, brought into their Obsidian vault: the export each lets them download,
 * read, and each chat made a note in a folder of its own, Claude/ or ChatGPT/, by year.
 *
 * A note holds the chat as it was seen: what was said, word for word, in order, the branch last shown when a message
 * was edited or a reply retried. What Claude made (artifacts, files) is kept folded, what it used to get there (a
 * search, commands) is one line, and its thinking is left out, as the chat showed it folded away. A line that looks
 * like it holds a password, a key or a card number is left out, as Jester keeps none in the vault (vault.js).
 *
 * Importing again changes only what changed: a chat already imported is rewritten when it's been carried on since,
 * and left as it is otherwise. Chats are known by their own ids, kept in each note's `chat_id`.
 *
 * Claude: Settings › Privacy › Export data gives a list of links (manifest-….json); conversations-000.zip, from the
 * first of them, holds conversations.json. ChatGPT: Settings › Data controls › Export data gives one zip, which holds
 * conversations.json (and chat.html, and the pictures, which aren't read). Safari unzips what it downloads, so a
 * folder works as well as the zip, and so does the .json itself.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { safeTitle, writeFrontmatter } from './vault.js';
import { secretIn } from './vault-memory.js';
import { openZip } from './zip-read.js';

/** Where each one's chats go, and what they're called. */
export const SOURCES = Object.freeze({
  claude: Object.freeze({ name: 'Claude', folder: 'Claude', tag: 'chat/claude', site: 'claude.ai', link: (id) => `https://claude.ai/chat/${encodeURIComponent(id)}` }),
  chatgpt: Object.freeze({ name: 'ChatGPT', folder: 'ChatGPT', tag: 'chat/chatgpt', site: 'chatgpt.com', link: (id) => `https://chatgpt.com/c/${encodeURIComponent(id)}` })
});

/** The files in an export that hold its chats: conversations.json, and the parts a large one is split into. */
const CHATS_FILE = /^conversations(?:[-_ ]?\d+)?\.json$/i;
/** How deep in a folder chosen they're looked for: a folder of exports, each unzipped into one of its own. */
const FOLDER_DEPTH = 2;
/** A folded part (pasted text, an artifact) is cut here: a whole book pasted in needn't be one note's bulk. */
const FOLD_MAX = 20000;
/** Claude's parent for a chat's first message. */
const ROOT_ID = '00000000-0000-4000-8000-000000000000';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const longDate = (date) => `${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
const clock = (date) => `${date.getHours() % 12 || 12}:${pad(date.getMinutes())} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
const one = (text, max = 120) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…`;
};
/** A time from Claude's ISO strings or ChatGPT's seconds: ms, or null. */
function msOf(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string' && value) {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : '');

// ——— Reading an export ———

/** Why nothing could be read from a file chosen: said to the user as it is. */
const PROBLEMS = {
  manifest:
    'That’s Claude’s list of download links, not the chats themselves. Open the link for conversations-000.zip in it (each link works once, within a day), then import that zip.',
  noChats: 'There are no chats in it: choose the zip Claude or ChatGPT sent you, or the conversations.json inside it.',
  notJson: 'It isn’t a file Jester can read chats from.'
};

/** Chats from one file's JSON: Claude's, ChatGPT's, or null when it's neither. */
function chatsOf(json) {
  if (!Array.isArray(json)) return null;
  const first = json.find(isObject);
  if (!first) return json.length ? null : [];
  if (Array.isArray(first.chat_messages)) return json.filter(isObject).map(claudeChat);
  if (isObject(first.mapping)) return json.filter(isObject).map(chatgptChat);
  return null;
}

/** A file's JSON: what it says, or a problem's code. */
function parsed(buffer, name) {
  let json;
  try {
    json = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { problem: 'notJson' };
  }
  if (isObject(json) && Array.isArray(json.data_files)) return { problem: 'manifest' };
  const chats = chatsOf(json);
  return chats ? { chats } : { problem: CHATS_FILE.test(path.basename(name)) ? 'notJson' : 'noChats' };
}

/** The conversations files in a folder, a level or two down: the ones there are, nearest first. */
function chatFilesIn(fs, dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const here = entries.filter((entry) => entry.isFile() && CHATS_FILE.test(entry.name)).map((entry) => path.join(dir, entry.name));
  if (here.length || depth >= FOLDER_DEPTH) return here.sort();
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '__MACOSX')
    .flatMap((entry) => chatFilesIn(fs, path.join(dir, entry.name), depth + 1));
}

/**
 * The chats in the files chosen: zips, JSON files, or folders an export was unzipped into.
 * @param {string[]} files
 * @param {{fs?: typeof nodeFs}} [options]
 * @returns {{chats: object[], problems: {file:string, why:string}[]}}
 */
export function readExports(files, { fs = nodeFs } = {}) {
  const chats = [];
  const problems = [];
  const say = (file, problem) => problems.push({ file: path.basename(file), why: PROBLEMS[problem] || problem });
  for (const file of Array.isArray(files) ? files : [files]) {
    if (typeof file !== 'string' || !file) continue;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      say(file, err.code === 'ENOENT' ? 'It isn’t there any more.' : `Jester couldn’t open it (${err.code || err.message}).`);
      continue;
    }
    try {
      if (stat.isDirectory()) {
        const found = chatFilesIn(fs, file);
        if (!found.length) say(file, 'noChats');
        for (const json of found) {
          const read = parsed(fs.readFileSync(json), json);
          if (read.chats) chats.push(...read.chats);
          else say(json, read.problem);
        }
      } else if (/\.zip$/i.test(file)) {
        const zip = openZip(file, { fs });
        try {
          const inside = zip.names.filter((name) => CHATS_FILE.test(path.posix.basename(name)) && !name.startsWith('__MACOSX/')).sort();
          if (!inside.length) say(file, 'noChats');
          for (const name of inside) {
            const read = parsed(zip.read(name), name);
            if (read.chats) chats.push(...read.chats);
            else say(file, read.problem);
          }
        } finally {
          zip.close();
        }
      } else {
        const read = parsed(fs.readFileSync(file), file);
        if (read.chats) chats.push(...read.chats);
        else say(file, read.problem);
      }
    } catch (err) {
      say(file, err.code === 'bad_zip' ? err.message : `Jester couldn’t read it (${err.message}).`);
    }
  }
  return { chats, problems };
}

// ——— Claude ———

/** The messages last shown: back from the newest along each one's parent. With no parents given (an old export), all in order. */
function claudeThread(list) {
  const messages = list.filter(isObject);
  const linked = messages.some((message) => message.parent_message_uuid && message.parent_message_uuid !== ROOT_ID);
  if (!linked) return { thread: messages, branched: false };
  const byId = new Map(messages.map((message) => [message.uuid, message]));
  let leaf = null;
  for (const message of messages) if (!leaf || (msOf(message.created_at) ?? 0) >= (msOf(leaf.created_at) ?? 0)) leaf = message;
  const thread = [];
  const seen = new Set();
  for (let message = leaf; message && !seen.has(message.uuid); message = byId.get(message.parent_message_uuid)) {
    seen.add(message.uuid);
    thread.unshift(message);
  }
  return { thread, branched: thread.length < messages.length };
}

/** What an artifact's type says its code is, for its fence. */
const ARTIFACT_LANG = { 'application/vnd.ant.react': 'jsx', 'text/html': 'html', 'text/markdown': 'markdown', 'image/svg+xml': 'svg', 'application/vnd.ant.mermaid': 'mermaid' };
const EXT_LANG = { py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript', md: 'markdown', sh: 'bash', yml: 'yaml', rb: 'ruby', rs: 'rust', kt: 'kotlin', txt: '' };
const langOfFile = (file) => {
  const ext = path.posix.extname(String(file)).slice(1).toLowerCase();
  return ext in EXT_LANG ? EXT_LANG[ext] : /^[a-z0-9+#-]{1,12}$/.test(ext) ? ext : '';
};

/** A tool Claude used, as a few words: what it searched for, the site it read, else the tool's own name. */
function toolLabel(block) {
  const name = text(block.name) || 'a tool';
  const input = isObject(block.input) ? block.input : {};
  if (/^(?:web_search(?:_fast)?|WebSearch)$/.test(name) && text(input.query)) return `searched “${one(input.query, 80)}”`;
  if (/^(?:web_fetch|WebFetch)$/.test(name) && text(input.url)) {
    try {
      return `read ${new URL(input.url).hostname.replace(/^www\./, '')}`;
    } catch {
      return 'read a page';
    }
  }
  return name
    .replace(/^mcp__/, '')
    .split(/__|:/)
    .pop()
    .replace(/_v\d+$/, '')
    .replace(/_/g, ' ');
}

/** One Claude message's parts, in order: what it said, what it made, and the tools between. */
function claudeParts(message, artifacts) {
  const parts = [];
  let tools = [];
  const flush = () => {
    if (tools.length) parts.push({ kind: 'tools', items: tools });
    tools = [];
  };
  const blocks = Array.isArray(message.content) && message.content.length ? message.content : [{ type: 'text', text: message.text }];
  for (const block of blocks.filter(isObject)) {
    if (block.type === 'text') {
      if (!text(block.text).trim()) continue;
      flush();
      parts.push({ kind: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      const input = isObject(block.input) ? block.input : {};
      if (block.name === 'artifacts' && text(input.content) && input.command !== 'update') {
        const title = one(input.title, 80) || artifacts.get(input.id) || 'An artifact';
        if (input.id) artifacts.set(input.id, title);
        flush();
        parts.push({ kind: 'made', title, lang: text(input.language) || ARTIFACT_LANG[input.type] || '', text: input.content });
      } else if (block.name === 'artifacts') {
        tools.push(`updated “${artifacts.get(input.id) || 'an artifact'}”`);
      } else if ((block.name === 'create_file' && text(input.file_text)) || (block.name === 'Write' && text(input.content))) {
        const file = text(input.path) || text(input.file_path);
        flush();
        parts.push({ kind: 'made', title: path.posix.basename(file) || 'A file', lang: langOfFile(file), text: text(input.file_text) || text(input.content) });
      } else tools.push(toolLabel(block));
    }
    // Thinking, tool results, injected prompts, token budgets, and uploads' blocks (their names come below): not what was shown.
  }
  flush();
  const pasted = (Array.isArray(message.attachments) ? message.attachments : []).filter(isObject);
  for (const attachment of pasted) {
    if (text(attachment.extracted_content).trim()) parts.push({ kind: 'pasted', title: one(attachment.file_name, 80) || 'Pasted text', text: attachment.extracted_content });
  }
  const names = new Set(pasted.map((attachment) => one(attachment.file_name, 80)));
  const files = (Array.isArray(message.files) ? message.files : [])
    .filter(isObject)
    .map((file) => one(file.file_name, 80))
    .filter((name) => name && !names.has(name) && names.add(name));
  if (files.length) parts.push({ kind: 'files', items: files });
  return parts;
}

/** A chat from Claude's export, as every chat is held here. */
function claudeChat(raw) {
  const { thread, branched } = claudeThread(Array.isArray(raw.chat_messages) ? raw.chat_messages : []);
  const artifacts = new Map();
  const messages = thread
    .map((message) => ({ you: message.sender === 'human', at: msOf(message.created_at), parts: claudeParts(message, artifacts) }))
    .filter((message) => message.parts.length);
  const created = msOf(raw.created_at) ?? messages[0]?.at ?? null;
  return {
    source: 'claude',
    id: text(raw.uuid),
    title: one(raw.name, 200),
    created,
    updated: msOf(raw.updated_at) ?? messages.at(-1)?.at ?? created,
    model: '',
    branched,
    messages
  };
}

// ——— ChatGPT ———

/**
 * Its words without the marks only its own app reads, written in private-use characters: a citation
 * ("\uE200cite\uE202turn0search3\uE201") goes, and a named thing ("\uE200entity\uE202["city","Paris",…]\uE201") is its
 * name; so does the older "【8†source】".
 */
const gptText = (value) =>
  text(value)
    .replace(/\uE200([^\uE201]*)\uE201/g, (all, inner) => {
      const [kind, ...rest] = inner.split('\uE202');
      if (kind !== 'entity') return '';
      try {
        const named = JSON.parse(rest.join(''));
        return Array.isArray(named) && typeof named[1] === 'string' ? named[1] : '';
      } catch {
        return '';
      }
    })
    .replace(/【\d+(?::\d+)?†[^】]*】/g, '')
    .replace(/[\uE200-\uE2FF]/g, '');

/** One ChatGPT message's parts: its words, and what came with them. */
function gptParts(message) {
  const content = isObject(message.content) ? message.content : {};
  const parts = [];
  const files = [];
  if (content.content_type === 'text' || content.content_type === 'multimodal_text') {
    for (const part of Array.isArray(content.parts) ? content.parts : []) {
      if (typeof part === 'string') {
        if (gptText(part).trim()) parts.push({ kind: 'text', text: gptText(part) });
      } else if (isObject(part) && part.content_type === 'audio_transcription' && text(part.text).trim()) {
        parts.push({ kind: 'text', text: part.text });
      } else if (isObject(part) && part.content_type === 'image_asset_pointer') files.push('an image');
    }
  }
  const attached = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
  for (const attachment of attached.filter(isObject)) if (one(attachment.name, 80)) files.push(one(attachment.name, 80));
  // A picture they attached is listed by name too: "an image" is said only for the ones without one.
  const named = files.filter((name) => name !== 'an image');
  const images = files.length - named.length - attached.filter((item) => isObject(item) && /^image\//.test(text(item.mimeType))).length;
  const items = [...new Set(named), ...Array(Math.max(0, images)).fill('an image')];
  if (items.length) parts.push({ kind: 'files', items });
  return parts;
}

/** A chat from ChatGPT's export: the branch it shows (current_node, back along each node's parent), its turns merged. */
function chatgptChat(raw) {
  const mapping = raw.mapping;
  let leaf = isObject(mapping[raw.current_node]) ? raw.current_node : null;
  if (!leaf) {
    // No current node: the newest message that has none after it.
    let newest = -1;
    for (const [id, node] of Object.entries(mapping)) {
      if (isObject(node) && !(Array.isArray(node.children) && node.children.length) && (msOf(node.message?.create_time) ?? 0) >= newest) {
        newest = msOf(node.message?.create_time) ?? 0;
        leaf = id;
      }
    }
  }
  const thread = [];
  const seen = new Set();
  let branched = false;
  for (let id = leaf; id && isObject(mapping[id]) && !seen.has(id); id = mapping[id].parent) {
    seen.add(id);
    const node = mapping[id];
    if (Array.isArray(node.children) && node.children.length > 1) branched = true;
    thread.unshift(node);
  }
  const messages = [];
  for (const node of thread) {
    const message = node.message;
    if (!isObject(message)) continue;
    const role = message.author?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (message.metadata?.is_visually_hidden_from_conversation) continue;
    if (message.recipient && message.recipient !== 'all') continue;
    const parts = gptParts(message);
    if (!parts.length) continue;
    const you = role === 'user';
    const last = messages.at(-1);
    // One reply can be several messages (before and after a search): one turn, as the chat shows it.
    if (last && last.you === you && !you) last.parts.push(...parts);
    else messages.push({ you, at: msOf(message.create_time), parts });
  }
  const created = msOf(raw.create_time) ?? messages[0]?.at ?? null;
  return {
    source: 'chatgpt',
    id: text(raw.conversation_id) || text(raw.id),
    title: one(raw.title, 200),
    created,
    updated: msOf(raw.update_time) ?? messages.at(-1)?.at ?? created,
    model: one(raw.default_model_slug, 40),
    branched,
    messages
  };
}

// ——— The note ———

/** Lines that look like they hold a secret, swapped for a line saying one was left out. */
function unsecret(body, count) {
  return body
    .split('\n')
    .map((line) => {
      const secret = line.trim() && secretIn(line);
      if (!secret) return line;
      count.left++;
      return `${line.match(/^\s*/)[0]}(Jester left out a line here: it looked like it held ${secret}.)`;
    })
    .join('\n');
}

/**
 * A #word Obsidian would take for a tag, escaped (it still shows as #word): the user's tags stay theirs, not every
 * "#f59e0b" a chat mentioned (40 of them in the user's own Claude chats). Code in backticks is left as it is.
 */
const untag = (line) =>
  line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(^|\s)#(?=[\p{L}_])/gu, '$1\\#')))
    .join('');

/**
 * Words said in the chat, as a part of the note, outside code blocks: its headings made smaller than the note's own
 * (#### and below), so a message stays one section in Obsidian's outline and in search (`headings` false: left as
 * they are, as in a callout, which neither counts), and its #words not tags. A code block left open is closed.
 */
function said(words, { headings = true } = {}) {
  let fence = '';
  const lines = String(words)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (mark && !fence) {
        fence = mark[1];
        return line;
      }
      if (mark && fence && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) {
        fence = '';
        return line;
      }
      if (fence) return line;
      const heading = headings && /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
      return heading ? `${'#'.repeat(Math.min(6, heading[1].length + 3))}${untag(line.replace(/^ {0,3}#{1,6}/, ''))}` : untag(line);
    });
  if (fence) lines.push(fence);
  return lines.join('\n').trim();
}

/** A fence its code can't close: longer than any run of the same marks in it. */
function fenceFor(code) {
  const longest = Math.max(0, ...(String(code).match(/`{3,}/g) || []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Text cut at FOLD_MAX, saying so. */
function folded(words) {
  const all = String(words).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (all.length <= FOLD_MAX) return all;
  const cut = all.slice(0, FOLD_MAX).replace(/[\uD800-\uDBFF]$/, '');
  return `${cut.slice(0, cut.lastIndexOf('\n') > FOLD_MAX / 2 ? cut.lastIndexOf('\n') : cut.length)}\n… (cut here: ${(all.length - cut.length).toLocaleString('en-US')} more characters in the export)`;
}

/** A folded callout: Obsidian shows its title, and the rest when it's opened. */
const callout = (kind, title, lines) => [`> [!${kind}]- ${one(title, 100).replace(/[[\]]/g, '')}`, ...lines.map((line) => (line ? `> ${line}` : '>'))].join('\n');

/** The tools a turn used, as one line: each search by what it looked for, the rest counted. */
function toolsLine(name, items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  const shown = [...counts].map(([item, n]) => (n > 1 ? `${item} ×${n}` : item));
  const listed = shown.length > 8 ? [...shown.slice(0, 8), `and ${shown.length - 8} more`] : shown;
  return `_${name} used: ${listed.join(' · ').replace(/_/g, '\\_')}_`;
}

/** A message's heading: who, and when (with the day, when it isn't the chat's first). */
function headingOf(message, source, first) {
  const who = message.you ? 'You' : source.name;
  if (!Number.isFinite(message.at)) return `## ${who}`;
  const at = new Date(message.at);
  const sameDay = first && isoDate(at) === isoDate(first);
  const day = sameDay ? '' : `${MONTHS[at.getMonth()].slice(0, 3)} ${at.getDate()}${first && at.getFullYear() === first.getFullYear() ? '' : `, ${at.getFullYear()}`}, `;
  return `## ${who} · ${day}${clock(at)}`;
}

/** What a chat with no title is called: its first words. */
function titleFor(chat) {
  if (chat.title) return chat.title;
  const words = one(chat.messages.find((message) => message.you)?.parts.find((part) => part.kind === 'text')?.text, 60);
  return words ? words.replace(/[\s.,;:!?…]+$/, '') : 'Untitled chat';
}

/**
 * A chat as its note: where it goes (`folder`, `name`, without .md), its text, and how many lines were left out.
 * @param {object} chat  readExports' chat
 * @returns {{folder:string, name:string, text:string, leftOut:number, title:string}}
 */
export function chatNote(chat) {
  const source = SOURCES[chat.source];
  const first = Number.isFinite(chat.created) ? new Date(chat.created) : null;
  const title = titleFor(chat);
  const count = { left: 0 };
  const body = [`# ${one(title, 200).replace(/^#+\s*/, '')}`, ''];
  const started = first ? `, started ${longDate(first)} at ${clock(first)}` : '';
  body.push(`A chat with ${source.name}${started}, imported from ${source.name}’s export.${chat.id ? ` [Open it on ${source.site}](${source.link(chat.id)})` : ''}`);
  if (chat.branched) body.push('', 'Some of its messages were edited or retried: this is the version it last showed.');
  for (const message of chat.messages) {
    body.push('', headingOf(message, source, first));
    for (const part of message.parts) {
      body.push('');
      if (part.kind === 'text') body.push(unsecret(said(part.text), count));
      else if (part.kind === 'tools') body.push(toolsLine(source.name, part.items));
      else if (part.kind === 'files') body.push(`_Attached: ${part.items.map((item) => item.replace(/[_*[\]]/g, '\\$&')).join(', ')}_`);
      else if (part.kind === 'pasted') body.push(callout('quote', `Pasted: ${part.title}`, unsecret(said(folded(part.text), { headings: false }), count).split('\n')));
      else if (part.kind === 'made') {
        const code = unsecret(folded(part.text), count);
        const fence = fenceFor(code);
        body.push(callout('example', `Made: ${part.title}`, [`${fence}${part.lang}`, ...code.split('\n'), fence]));
      }
    }
  }
  const data = {
    type: 'chat',
    source: source.name,
    created: first ?? undefined,
    updated: Number.isFinite(chat.updated) ? new Date(chat.updated) : undefined,
    chat_id: chat.id || undefined,
    model: chat.model || undefined,
    tags: [source.tag]
  };
  const year = first ? String(first.getFullYear()) : 'Undated';
  const name = `${first ? `${isoDate(first)} ` : ''}${safeTitle(title)}`;
  return { folder: `${source.folder}/${year}`, name, title, text: writeFrontmatter(data, `${body.join('\n')}\n`), leftOut: count.left };
}

// ——— Importing ———

/**
 * The chats in `files`, put in the vault: new ones made, changed ones rewritten, the rest left. Yields now and then,
 * so a large export doesn't hold the app still.
 * @param {{vault: object, files: string[], fs?: typeof nodeFs, log?: (...args:any[]) => void}} options
 * @returns {Promise<{sources: Record<string, {added:number, updated:number, same:number, empty:number, folder:string}>, leftOut:number, problems:{file:string, why:string}[], failed:number}>}
 */
export async function importChats({ vault, files, fs = nodeFs, log = () => {} }) {
  const { chats, problems } = readExports(files, { fs });
  const sources = {};
  const known = new Map();
  let leftOut = 0;
  let failed = 0;
  let done = 0;
  for (const chat of chats) {
    const source = SOURCES[chat.source];
    const tally = (sources[source.name] ??= { added: 0, updated: 0, same: 0, empty: 0, folder: source.folder });
    if (!chat.messages.length) {
      tally.empty++;
      continue;
    }
    if (!known.has(source.folder)) known.set(source.folder, vault.importedChats(source.folder));
    const imported = known.get(source.folder);
    const had = chat.id ? imported.get(chat.id) : null;
    // Seconds, as a note's times are kept.
    if (had && Math.floor(had.updated / 1000) >= Math.floor((chat.updated ?? 0) / 1000)) {
      tally.same++;
      continue;
    }
    const note = chatNote(chat);
    try {
      const rel = vault.writeImported({ rel: had?.rel, name: `${note.folder}/${note.name}`, text: note.text, id: chat.id });
      if (chat.id) imported.set(chat.id, { rel, updated: chat.updated ?? 0 });
      if (had && had.rel === rel) tally.updated++;
      else tally.added++;
      leftOut += note.leftOut;
    } catch (err) {
      failed++;
      log(`import: couldn’t write “${note.title}”:`, err.message);
      if (err.code === 'ENOTDIR' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOSPC') throw err;
    }
    if (++done % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return { sources, leftOut, problems, failed };
}
