/**
 * Jester Desktop.
 *
 * Lives in the menu bar (the notification area on Windows). The extension's
 * engine (src/offscreen/offscreen.html) runs unchanged in a hidden window;
 * the main process plays its service worker, keeps the settings, and asks the
 * OS for the permissions Jester needs.
 *
 * Environment, for development and tests:
 *   JESTER_FAKE_MEDIA=1       Chromium's synthetic camera and mic, treated as allowed
 *   JESTER_FAKE_AUDIO=a.wav   with FAKE_MEDIA: the mic plays this file, once
 *   JESTER_SAVE_SPEECH=dir    keep each spoken command as a WAV + what was heard
 *   JESTER_LOG_SCREENS=1      log the screen the assistant's model is shown, each step
 *   JESTER_DATA_DIR=path      keep settings somewhere other than the user's
 *   JESTER_SPIKE_SECONDS=n    quit after n seconds
 *   JESTER_LOG=1              log engine status, gestures, telemetry and CPU
 *   JESTER_OPEN_SETTINGS=1    open Settings at launch
 *   JESTER_SELFTEST=1         check Settings ⇄ engine, logging what it sees
 *   JESTER_SELFTEST_CALIBRATE=1  also press Start on calibration (takes the screen)
 *   JESTER_SELFTEST_VOICE=1   also speak one command (FAKE_AUDIO) and log what it did
 *   JESTER_SELFTEST_AGENT=1   also read Jester's own Settings as the assistant would, and
 *                             run it there with a scripted model (needs DRIVER_DRY, and
 *                             launching through `open` for Accessibility: dev:mac)
 *   JESTER_CAPTURE=file.png   with SELFTEST: save a picture of the whole page
 *   JESTER_THEME=light|dark   override the system's appearance
 *   JESTER_LINK_SOCKET=path   listen for the Chrome extension here (with DATA_DIR, the only way it listens)
 *   JESTER_NO_LINK=1          no link to the Chrome extension
 *   JESTER_SERVER=1           his brain on a server (server/README.md): no camera, cursor, overlays, menu bar or
 *                             driver; his window is a website (web-gateway.js), and the browser being talked to is his
 *                             ears and mouth. Keys are sealed with a key file, not a keychain.
 *   JESTER_WEB_PORT=n         with SERVER: the website's port on 127.0.0.1 (8770)
 *   JESTER_WEB_KEY=key        with SERVER: the key the website asks for (made and kept in the data folder otherwise)
 *   JESTER_VAULT=path         with SERVER: the Obsidian vault (synced from the Mac): a server has no folder picker
 *   JESTER_GOOGLE_CLIENT=file with SERVER: Google's client file, for Gmail, in place of picking it in Settings
 */

import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, nativeImage, nativeTheme, powerMonitor, safeStorage, screen, session, shell, utilityProcess } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ACTIONS, ENGINE, MSG, resumeGlyphs, saveSettings } from '../../../jester-extension/src/common/constants.js';
import { createDesktopHost } from './agent/host.js';
import { runDesktopAgent } from './agent/loop.js';
import { screenText } from './agent/screen.js';
import { createApprovalPrompt } from './approval.js';
import { createAssistant } from './assistant.js';
import { createWebScraper } from './web-scraper.js';
import { createResearchPresentation } from './research-presentation.js';
import { sourceAddress, sourcesOf } from './research-sources.js';
import { addRemotePage, fromRemote, installBridge, onMessage, onStorageChanged, post, postRemote, postTo, remoteStorage, storage } from './chrome-bridge.js';
import { createFileSealer } from './file-sealer.js';
import { createRemoteVoicePage, createWebGateway, landingAddress, makeKey } from './web-gateway.js';
import { createRemoteHands } from './remote-hands.js';
import { cloudKeyFor, createCloudLink, parseCloudLink, serverOrigin } from './cloud-link.js';
import { createBriefs, CHECKIN_MIN, EVENING_AT, EVENING_KEEP_MS, MORNING_ENDS, MORNING_KEEP_MS } from './briefs.js';
import { callOffer, createOfferRunner, createOffers, draftOffer, openerLine, personal } from './offers.js';
import { briefingRequest, createBriefingManager } from './briefing-manager.js';
import { openBriefingItem } from './briefing-actions.js';
import { researchWeb } from '../../../jester-extension/src/background/web-research.js';
import { createChromeLink } from './chrome-link.js';
import { createClock } from './clock.js';
import { createCalendars } from './calendars.js';
import { cardOf, createChatArchive } from './chat-archive.js';
import { createChatKeeper } from './chat-keeper.js';
import { askModel, createConversation, LOCAL_KEEP_ALIVE, NEW_AFTER_MS, ollamaModels, pickModel, warmOllama } from './conversation.js';
import { createConversationLog } from './conversation-log.js';
import { createDispatcher } from './dispatch.js';
import { driverPath, startDriver, toDipFrame, toOsFrame } from './driver.js';
import { desktopSettings, loadSettings, startEngineHost } from './engine-host.js';
import { createLearned } from './learned.js';
import { startLink } from './link.js';
import { installLinkHost, linkOrigins } from './link-host.js';
import { createModelJob, localUses } from './model-jobs.js';
import { createSpend } from './spend.js';
import { PROVIDERS } from '../../../jester-extension/src/common/credentials.js';
import { fillsDisplay, wakeHint } from './os-actions.js';
import { createOverlays } from './overlay.js';
import { createPointer } from './pointer.js';
import { createGoogle } from './google.js';
import { createMacLocate, loadMacLocation } from './mac-location.js';
import { CHECK_MS, createMail, mailCard, mailLine } from './mail.js';
import { createPhone } from './phone.js';
import { createPresence, DAY_STARTS, dayOf, macScreenKeptAwake } from './presence.js';
import { createSteady, steerBy } from './pointer-math.js';
import { remakeOnQuit } from '../../scripts/jester-app.mjs';
import { missingFor } from './permission-list.js';
import { createRing } from './ring.js';
import { createRingPage } from './ring-page.js';
import { loadConnections } from '../../../jester-extension/src/common/credentials.js';
import { openSettings, readPermissions, readStatuses, requestPermission } from './permissions.js';
import { registerScheme, serveFiles } from './protocol.js';
import { startKokoro } from './kokoro.js';
import { createRecollections } from './recollections.js';
import { setupSteps, setupSummary } from './setup.js';
import { createSituation } from './situation.js';
import { createSpeaker, systemVoice } from './speaker.js';
import { startSpeech } from './speech.js';
import { createStopButton } from './stop-button.js';
import { createTasks } from './tasks.js';
import { createScripts } from './scripts.js';
import { draftManifest } from './script-draft.js';
import { createTeller, SETTLE_MS } from './tell.js';
import { createTray } from './tray.js';
import { createWatch } from './watch.js';
import { createWeather, unitsFor, weatherLines } from './weather.js';
import { createWhereabouts } from './whereabouts.js';
import { createDeviceLocate } from './device-location.js';
import { createDevices } from './devices.js';
import { createPush } from './push.js';
import { createWebLogin } from './web-login.js';
import { apply as applyMove, collect as collectMove } from './move-in.js';
import { createSessions, following, sessionFile, sessionKeyOf } from './sessions.js';
import { trayModel } from './tray-menu.js';
import { createVault, detectObsidianVaults, findVaultRoot, PATHS } from './vault.js';
import { importChats } from './chat-import.js';
import { createChatLearner } from './chat-learn.js';
import { createVaultIndex } from './vault-index.js';
import { createVaultMemory, secretIn } from './vault-memory.js';
import { createVoicePage } from './voice-page.js';
import { VOICES, voiceNamed } from './voice/voices.js';
import { averageVoice, TEACHING_LINES, TEACHING_SECONDS, withLearned } from './voiceprint.js';
import { createVoiceRunner, runFile } from './voice-runner.js';
import { createWindowShot } from './window-shot.js';
import { closeSafely, createEngineWindow, homeWindow, noteHomeScreen, onHomeVisibility, reopenHome, setCloudPage, showCalibration, showHome, showSettings, showTalk, talkWindow } from './windows.js';
import { createScriptsRemote } from './script-remote.js';

const env = process.env;
/** His brain on a server, his window a website: see JESTER_SERVER above. */
const SERVER = !!env.JESTER_SERVER;
/** Permissions change in System Settings, behind the app's back. */
const PERMISSION_POLL_MS = 2000;
/** How often the front window is checked: it decides which binding set is live. */
const FRONT_POLL_MS = 500;
/** The extension's voice shortcut, kept for the desktop. */
const VOICE_SHORTCUT = 'Alt+Shift+J';
/** The most typed to him at once: a pasted passage or two of an essay, not a book (remote-hands.js has the same). */
const TYPED_MAX = 12000;
/** Long enough for the overlay's page to load. */
const STARTED_TOAST_MS = 2000;
/** The conversation log's hour is checked this often, so a sleeping Mac doesn't stretch it. */
const LOG_CHECK_MS = 60000;
/** How stale Obsidian's list of vaults may be. */
const OBSIDIAN_LIST_MS = 5000;
/** Jester's own views of the vault, which he rewrites: not notes to list in its map. Told by where they are, not their type. */
const VIEWS = [PATHS.index, PATHS.routines, PATHS.readme];
/** Learned things come in bursts (a task and its shortcut): Routines.md is written once they settle. */
const ROUTINES_DELAY_MS = 1000;
/** Teaching him a voice gives up after this long with nothing read. */
const TEACHING_MS = 90000;
/** Scripts set for a time and come due later than this (asleep, or not running) aren't run: they're told as not done. */
const RUN_LATE_MS = 10 * 60 * 1000;

registerScheme();
// A server has no display worth drawing on (it runs under a virtual one, xvfb) and no GPU.
if (SERVER) app.disableHardwareAcceleration();
if (env.JESTER_DATA_DIR) {
  app.setPath('userData', path.resolve(env.JESTER_DATA_DIR));
  // A test Jester's log is its own, not the user's dev.log.
  app.setAppLogsPath(path.join(path.resolve(env.JESTER_DATA_DIR), 'logs'));
}
// Read by the speech service, which inherits this environment.
if (env.JESTER_SAVE_SPEECH) env.JESTER_SAVE_SPEECH = path.resolve(env.JESTER_SAVE_SPEECH);
if (env.JESTER_FAKE_MEDIA) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (env.JESTER_FAKE_AUDIO) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${path.resolve(env.JESTER_FAKE_AUDIO)}%noloop`);
    // Chromium's sandboxed audio process can't read the file; audio in this process can.
    app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  }
}

/**
 * Where the log goes with JESTER_LOG: stdout, which the launcher sends to
 * dev.log. Restarted from the menu bar, Jester's stdout goes nowhere, so it
 * adds to dev.log itself. Null: stdout will do (the launcher's file, or a terminal).
 */
function ownLogFile() {
  if (!env.JESTER_LOG || process.stdout.isTTY) return null;
  try {
    if (fs.fstatSync(1).isFile()) return null;
    // dev:mac's JESTER_DEV_LOG, when it was started with one.
    const file = env.JESTER_DEV_LOG ? path.resolve(env.JESTER_DEV_LOG) : path.join(app.getPath('logs'), 'dev.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return fs.openSync(file, 'a');
  } catch {
    return null;
  }
}
const logFile = ownLogFile();
/** A log line's words, but for any that look like a password or card number: dev.log is plain text, and heard words go in it. */
const unsecret = (part) => {
  const secret = typeof part === 'string' ? secretIn(part) : '';
  return secret ? `(words holding ${secret}, left out)` : part;
};
const log = !env.JESTER_LOG
  ? () => undefined
  : logFile === null
    ? (...parts) => console.log('[jester]', ...parts.map(unsecret))
    : (...parts) => fs.writeSync(logFile, `${format('[jester]', ...parts.map(unsecret))}\n`);

let engineWindow = null;
let engineHost = null;
let tray = null;
let overlays = null;
let pointer = null;
let watch = null;
/** Said once, until it's no longer so. */
let watchRefused = '';
const steady = createSteady();
/** What the pointer asked the driver for, during a self-test. */
const pointerCalls = [];
/** The self-test's ear: called with the next voice command and how it went. */
let voiceHeard = null;
let driver = null;
let dispatch = null;
let assistant = null;
let stopButton = null;
/** A timer's ringing (ring.js): until it's turned off by a word, a gesture or a click. */
let ring = null;
let speech = null;
let voiceRunner = null;
/** The user's own scripts, in Controls (scripts.js). */
let scripts = null;
let conversation = null;
/** A chat per device (sessions.js): `conversation` and `conversationLog` are the one in front. */
let sessions = null;
/** On a server: where he's open (devices.js). */
let devices = null;
/** On a server: signing in to his website with a password (web-login.js). */
let webLogin = null;
/** On a server: notifications to his app on the user's devices (push.js), in place of ntfy. */
let push = null;
let recollections = null;
/** The conversation going on, word for word (conversation-log.js), and what becomes of each once it's over (chat-keeper.js). */
let conversationLog = null;
let keeper = null;
/** What the saved models have cost this month (spend.js). */
let spend = null;
/** Taught phrases, learned tasks and shortcuts (learned.js). */
let learned = null;
/** What his website's Controls may ask of the Mac's scripts (script-remote.js). */
let scriptsRemote = null;
/** The Obsidian vault Jester keeps its memory in (vault.js), its search (vault-index.js), and the memory between them. */
let vault = null;
let vaultIndex = null;
let vaultMemory = null;
/** Reads the chats imported from Claude and ChatGPT, when the user says to, for what they show about them (chat-learn.js). */
let chatLearner = null;
/** Why the chosen vault can't be used: 'missing', 'denied', or an error's own words; '' when it can. */
let vaultProblem = '';
/** A read of the vault asked for here (opening it, Read again) is under way: Settings says so, not "0 notes read". */
let vaultReading = false;
/** Where the user is, the weather there, their calendars, and all three for him (situation.js). */
let whereabouts = null;
let weather = null;
let calendars = null;
let situation = null;
/** The location source last acted on: a new one means a new position. */
let locationSource = '';
/** The weather now where the user is, in a line for Settings. */
let weatherNote = '';
let speaker = null;
/** His own voice, made on this computer (kokoro.js). */
let kokoro = null;
let voicePage = null;
/** Whether the user's at the computer (presence.js), things with a time on them (clock.js), and telling them (tell.js). */
let presence = null;
let clock = null;
let teller = null;
/** Their to-do list, reminders and timers (tasks.js). */
let tasks = null;
/** Their phone, for what's told while they're away (phone.js). */
let phone = null;
/** Signing in with Google (google.js), and their Gmail, watched for what matters (mail.js). */
let google = null;
let mail = null;
/** He's said Google signed him out, this time round: not said again until they've signed back in. */
let signInTold = false;
/** A sign-in is being finished: Gmail isn't looked at until his place in the new inbox is made. */
let mailBusy = false;
/** Whether the user wanted Gmail watched (the switch) when last asked: null before the first asking. */
let mailWatched = null;
/** The morning brief, the evening wrap-up and check-ins before what's on the calendar (briefs.js). */
let briefs = null;
let briefingManager = null;
/** Work he offers to do, and what came of each offer (offers.js); and the doing of what isn't a command. */
let offers = null;
let runOffer = null;
let briefingResearchAbort = null;
const briefingReadRequests = new Set();
/** The day each brief was last given, so it's given once: {morning, evening}, by presence.js's day. */
let briefDays = {};
/** He's been ready once on this computer (setupState): kept, so a later launch isn't taken for a first one. */
let setUpOnce = false;
/** Check-ins already said, by their id, with when each one's event starts: not put back on the clock meanwhile. */
let checkinsTold = {};
/** The model he talks through (model-jobs.js). */
let talking = null;
/** The Chrome extension, linked (chrome-link.js), and where Chrome finds the relay to it. */
let chromeLink = null;
const webScraper = createWebScraper();
/** A search's progress and its ×: in his window while it's open, else on the pill (research-presentation.js). */
const researchPresentation = createResearchPresentation({
  home: homeWindow, post, postTo,
  overlays: () => overlays?.windows() || [],
  stopButton: () => stopButton
});
onHomeVisibility((change) => researchPresentation.sync(change));
let linkHost = null;
let linkTransport = null;
/** The linked browser is in front: gestures do what the extension's settings say, and it does them. */
let browserMode = false;
/** What a gesture does with Chrome in front that the extension does, rather than the app. */
const CHROME_SCOPES = new Set(['video', 'page', 'browser', 'window']);
/** Whether the always-on mic is open. */
let listening = false;
/** Why it's closed for the moment, whatever the setting says: 'locked', 'suspended'. */
const away = new Set();
/** Driver commands that type, click or move: his doing, not the user's (presence.js own()). */
const OWN_INPUT = new Set(['key', 'text', 'click', 'button', 'move', 'scroll', 'drag', 'media', 'act', 'menu', 'wake']);
/** The user's voice, once taught. */
let voiceprint = null;
/** Other ways the user's been heard to sound, learned from use (voiceprint.js). */
let voiceLearned = [];
/** Teaching him a voice: the takes so far, and what ends it. */
let teaching = null;
let quitting = false;
let engine = { state: 'off', detail: '' };
let permissions = [];
let settings = null;
/** 'fullscreen' while the front window fills its display, as in the extension. */
let context = 'windowed';

/** The display the cursor aims at: the main one, which has the camera on a laptop. */
const pointerDisplay = () => screen.getPrimaryDisplay();

function primaryScreen() {
  const { width, height } = pointerDisplay().size;
  return { w: width, h: height };
}

/** CPU since the last call, per process, so a 5 s interval reads as a 5 s average. */
function cpuReport() {
  const metrics = app.getAppMetrics();
  const enginePid = engineWindow?.webContents.getOSProcessId();
  const pct = (metric) => (metric ? Math.round(metric.cpu.percentCPUUsage) : 0);
  const mb = (metric) => Math.round((metric?.memory?.workingSetSize || 0) / 1024);
  const engineMetric = metrics.find((m) => m.pid === enginePid);
  const gpu = metrics.find((m) => m.type === 'GPU');
  const main = metrics.find((m) => m.type === 'Browser');
  const speechMetric = metrics.find((m) => m.serviceName === 'Jester speech' || m.name === 'Jester speech');
  const total = metrics.reduce((sum, m) => sum + mb(m), 0);
  return `cpu engine ${pct(engineMetric)}% gpu ${pct(gpu)}% all ${metrics.reduce((sum, m) => sum + pct(m), 0)}% · MB engine ${mb(engineMetric)} gpu ${mb(gpu)} main ${mb(main)} speech ${mb(speechMetric)} total ${total}`;
}

/** Only media macOS (or Windows) has actually granted, so no prompt ever comes from the hidden window. */
function mediaAllowed(type) {
  // On a server, the mic is a browser's, and the browser asks for it itself.
  if (env.JESTER_FAKE_MEDIA || SERVER) return true;
  const status = readStatuses();
  if (type === 'video') return status.camera === 'granted';
  if (type === 'audio') return status.microphone === 'granted';
  return status.camera === 'granted' || status.microphone === 'granted';
}

/** The page that asks where this computer is (locateByPage), and only while Settings says to use its location. */
const LOCATE_PAGE = 'jester://app/where/where.html';
const locating = (url) => String(url || '').startsWith(LOCATE_PAGE) && settings?.locationSource === 'here';

function installMediaPermissions() {
  const own = (url) => /^jester:\/\//.test(url || '');
  // Full screen too: the calibration screen takes the whole display to know
  // exactly where each dot is, and waits on being allowed to.
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    (own(origin) && (permission === 'fullscreen' || (permission === 'media' && mediaAllowed(details.mediaType)))) ||
    (permission === 'geolocation' && locating(contents?.getURL?.() || details.requestingUrl)));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const types = details.mediaTypes?.length ? details.mediaTypes : ['unknown'];
    const allowed =
      (own(details.requestingUrl) && (permission === 'fullscreen' || (permission === 'media' && types.every(mediaAllowed)))) ||
      (permission === 'geolocation' && locating(details.requestingUrl));
    if (!allowed) log('refused permission', permission, 'for', details.requestingUrl);
    callback(allowed);
  });
}

/**
 * Where this computer is, by a hidden page of Jester's asking Chromium: Windows' location. Not on a Mac, where
 * Electron's Chromium waits for macOS to allow it but never asks, so it only ever timed out: a Mac asks Location
 * Services itself (mac-location.js), and this is only for a Mac whose module isn't built.
 * The page goes once it has answered.
 * @returns {Promise<{ok:boolean, lat?:number, lon?:number, accuracy?:number, code?:number, message?:string}>}
 */
async function locateByPage({ timeoutMs }) {
  const page = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  let timer;
  try {
    await page.loadURL(LOCATE_PAGE);
    const asking = page.webContents.executeJavaScript(`new Promise((resolve) => navigator.geolocation.getCurrentPosition(
      (p) => resolve({ ok: true, lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => resolve({ ok: false, code: e.code, message: e.message }),
      { enableHighAccuracy: true, maximumAge: 60000, timeout: ${Math.round(timeoutMs)} }))`);
    const late = new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs + 5000, { ok: false, code: 3, message: 'no answer' })));
    return await Promise.race([asking, late]);
  } finally {
    clearTimeout(timer);
    page.destroy();
  }
}

/** A new location source from Settings: what was known from the old one goes, and the new one is asked. */
function followLocation() {
  if (!whereabouts) return;
  const chosen = settings?.locationSource || 'off';
  if (chosen === locationSource) return;
  const first = !locationSource;
  locationSource = chosen;
  if (!first) whereabouts.reset();
  weatherNote = '';
  // Chosen in Settings, it's Settings that asks for a position (jester/desktop-day); at launch, it's asked here.
  if (chosen !== 'off') noteWeather({ fresh: first });
}

/** The weather where the user is, for Settings: once there's a position. */
async function noteWeather({ fresh = false } = {}) {
  try {
    if (fresh && whereabouts.source === 'here') await whereabouts.locate();
    const here = await whereabouts.here();
    if (!here) return;
    const units = unitsFor(settings?.weatherUnits, app.getLocaleCountryCode());
    weatherNote = weatherLines(await weather.forecast({ lat: here.lat, lon: here.lon, units }), { now: Date.now(), where: here.town ? `in ${here.town}` : 'there' })[0] || '';
  } catch (err) {
    log('weather: none for Settings:', err.message);
  } finally {
    post(desktopState());
  }
}

/**
 * A change from Settings' Weather and calendars, saved and taken up at once: what's done next (a position asked for,
 * the geolocation permission checked) reads `settings`, which the storage change would bring only later.
 */
async function saveDay(patch) {
  await saveSettings(patch);
  settings = await loadSettings();
  followLocation();
}

/** Settings' Weather and calendars section: never a calendar's link, or more of where the user is than the town. */
function dayState() {
  return {
    location: whereabouts?.state() || { source: 'off' },
    place: settings?.locationPlace?.name ? settings.locationPlace : null,
    units: settings?.weatherUnits || 'auto',
    weather: weatherNote,
    calendars: calendars?.list() || []
  };
}

/** A first launch stores the desktop defaults, so every later save starts from them. */
async function seedSettings() {
  const { settings } = await storage.local.get('settings');
  if (!settings) await storage.local.set({ settings: desktopSettings(undefined) });
}

function desktopState() {
  return {
    type: 'jester/desktop-state',
    platform: process.platform,
    engine,
    permissions,
    // What he can't do without as he's set up, and hasn't got (permission-list.js).
    missing: missingFor(permissions, settings).map((item) => item.id),
    voice: voiceState(),
    // Their phone: whether it's set up and on. Never the topic's name, which is asked for by Settings alone.
    phone: SERVER ? { on: !!push?.ready, set: !!push?.ready, push: true } : phone ? { on: phone.ready, set: !!phone.state().topic } : null,
    // Their Gmail: whether there's a client to sign in with, whether they're signed in and as whom. No key.
    mail: google ? google.state() : null,
    speechModel: speech?.model || null,
    speechChoices: speech?.choices || [],
    research: researchPresentation.state(),
    watch: watch?.state || null,
    continuous: {
      listening,
      wanted: !!settings?.continuousAssistant,
      problem: settings?.continuousAssistant ? voiceProblem() : '',
      // His voice: Kokoro's when its model is there ('ready'), and the computer's own otherwise.
      voice: { state: kokoro?.state || 'missing', chosen: voiceNamed(settings?.jesterVoice).id, choices: VOICES.map(({ id, name, about }) => ({ id, name, about })) },
      knowsYou: !!voiceprint,
      teaching: teaching ? { line: TEACHING_LINES[teaching.takes.length], done: teaching.takes.length, of: TEACHING_LINES.length } : null
    },
    chrome: {
      linked: !!chromeLink?.linked,
      version: chromeLink?.version || '',
      browsers: linkHost?.browsers || [],
      why: linkHost?.why || ''
    },
    memory: memoryState(),
    day: dayState(),
    fakeMedia: !!env.JESTER_FAKE_MEDIA,
    // On a server: whether the Mac's connected. On a Mac: whether it uses him in the cloud, and where.
    server: SERVER ? { mac: !!remoteHands?.connected } : null,
    // `refused`: the server no longer takes this Mac's key (it was replaced): signing in again mends it.
    cloud: cloudTarget ? { on: true, server: cloudTarget.origin, connected: !!cloudLink?.connected, refused: !!cloudLink?.refused } : { on: false }
  };
}

/**
 * Which camera the engine opened, for the log and Settings: with "Default
 * camera", that's the OS's choice, which can be a nearby iPhone.
 */
async function noteCamera() {
  const label = await engineWindow?.webContents
    .executeJavaScript(`document.getElementById('camera')?.srcObject?.getVideoTracks?.()[0]?.label || ''`)
    .catch(() => '');
  if (!label || engine.state !== ENGINE.RUNNING) return;
  engine = { ...engine, camera: label };
  log('camera:', label);
  refresh();
}

/** The speech model: 'ready', 'off' or 'missing' (see speech.js). */
const voiceState = () => speech?.state || 'missing';

async function refresh() {
  settings = await loadSettings();
  speech?.setModel(settings.speechModel);
  speech?.setEnabled(settings.enabled && settings.voiceEnabled);
  watch?.setEnabled(settings.enabled && !!settings.watchEnabled);
  const { voiceprint: print, voiceLearned: known } = await storage.local.get(['voiceprint', 'voiceLearned']);
  voiceprint = print || null;
  voiceLearned = voiceprint && Array.isArray(known) ? known : [];
  speech?.setVoiceprint(teaching ? null : voiceprint, voiceLearned);
  // Voices he wasn't sure of, kept for tuning only when the user's said to (Settings › Assistant and voice).
  speech?.setKeeping(settings.keepUnsureSpeech === true ? path.join(app.getPath('userData'), 'heard') : '');
  updateListening();
  openVault();
  followLocation();
  syncBriefs();
  syncMail();
  updateTray();
  post(desktopState());
}

/** His menu, as things stand. */
function updateTray() {
  tray?.update(trayModel({ engine, settings, missing: missingFor(permissions, settings), voice: voiceState(), watch: watch?.state, ringing: ring?.ringing || null, scripts: scripts?.menu() || null }));
}

/**
 * The continuous assistant's mic follows the setting and everything that stops
 * voice: Jester off, asleep, no permission. A locked or sleeping computer isn't
 * being talked to. Closing it ends whatever he was saying or doing about it.
 */
function updateListening() {
  if (!conversation) return;
  // In the cloud the conversation is the server's, and so is when the mic opens (cloud-link.js).
  const on = !cloudTarget && (!!settings?.continuousAssistant || !!teaching) && !voiceProblem() && !away.size;
  if (on === listening) return;
  listening = on;
  log(on ? 'continuous assistant: listening' : 'continuous assistant: stopped');
  if (on) {
    voicePage.open();
    speech.listen(
      (text, heard) => (teaching ? tookLine(heard) : heardAloud(text, heard)),
      (wake) => !teaching && conversation.woken(wake),
      // A pause that may be the end of it: he starts thinking, and says and does nothing until it is.
      (text, early) => !teaching && (text === null ? conversation.wentOn() : conversation.paused(text, early)),
      (activity) => !teaching && conversation.hearing(activity)
    );
  } else {
    speech.stopListening();
    conversation.reset();
    voicePage.close();
  }
}

/**
 * What the always-on mic heard. A voice heard as the user's, in something he took as said to him, is one more way
 * they sound (voiceprint.js): kept, so the next thing said like that is theirs without his name.
 */
function heardAloud(text, heard) {
  // Said across him, it has his voice in it too: not a way they sound.
  const across = conversation.speaking || conversation.overlapped(heard?.startedAt);
  const turned = conversation.heard(text, { unsure: !!heard?.unsure, lag: heard?.afterMs, startedAt: heard?.startedAt });
  // Their voice, or words he took as said to him: they're there, wherever in the room.
  if (turned || (voiceprint && !heard?.unsure)) presence?.seen('voice');
  if (turned && !across && heard?.learn && heard.voice && voiceprint) learnVoice(heard.voice);
}

async function learnVoice(voice) {
  voiceLearned = withLearned(voiceLearned, voice);
  speech.setVoiceprint(teaching ? null : voiceprint, voiceLearned);
  log('voice: learned another way you sound,', voiceLearned.length, 'kept');
  await storage.local.set({ voiceLearned }).catch((err) => log('voice: couldn’t keep it:', err.message));
}

/** Starts teaching him the user's voice: they read each line, and what they read comes back here. */
function teachVoice() {
  if (voiceProblem()) return voiceProblem();
  clearTimeout(teaching?.limit);
  teaching = { takes: [], limit: setTimeout(() => stopTeaching(), TEACHING_MS) };
  speech.setVoiceprint(null);
  speech.setTeaching(true);
  refresh();
  return '';
}

async function stopTeaching(takes) {
  clearTimeout(teaching?.limit);
  teaching = null;
  speech.setTeaching(false);
  // A voice taught afresh starts with nothing learned: what was may have been someone else's.
  if (takes) {
    await storage.local.set({ voiceprint: averageVoice(takes) });
    await storage.local.remove('voiceLearned');
  }
  log(takes ? 'voice taught' : 'voice not taught');
  refresh();
}

/** One line read. Too short, or without a voice to take, and it's asked for again. */
function tookLine({ voice, seconds, score }) {
  log('teaching: heard', seconds?.toFixed(1), 's', score ?? '');
  if (!teaching || !voice || seconds < TEACHING_SECONDS) return;
  teaching.takes.push(voice);
  if (teaching.takes.length >= TEACHING_LINES.length) stopTeaching(teaching.takes);
  else post(desktopState());
}

/** What ends a task's pill: its last step, left up once the task is over. */
const TASK_OVER = { type: MSG.VOICE, voice: { phase: 'thinking', done: true } };

/**
 * The conversation, on the pill: or, with his own window up, only there, where
 * the orb shows it. Endings go to both, so neither is left showing one. The
 * assistant's work isn't the conversation's: its pill, and the × beside it,
 * stay while it works. Its end never reaches the pill, though, for what it did
 * is said in his window: so the conversation going on after it ends it there.
 * Whether he's talking goes to the recognizer too, which listens for being
 * talked over only then.
 */
function showConversation(voice, key = 'local') {
  if (voice.phase === 'speaking') speech?.setSpeaking(!voice.done);
  else if (voice.active === false || voice.start) speech?.setSpeaking(false);
  const message = { type: MSG.VOICE, voice: { position: 'bottom-center', ...voice } };
  // On a server, a chat per device: its frames go to the pages showing that chat.
  if (SERVER) return postRemote(message, (remote) => viewingOf(remote) === key);
  const talk = talkWindow();
  if (!talk || voice.active === false || voice.done) return post(message);
  postTo(talk.webContents, message);
  postRemote(message);
  if (!assistant.running) for (const win of overlays.windows()) postTo(win.webContents, TASK_OVER);
}

/** The conversation going on, as his window shows it: what was said before it was picked up marked so, and a line kept as only that it held a secret, too. */
function currentChat(key = sessions.frontKey) {
  const going = sessions.get(key).log;
  return {
    id: going.chatId(),
    lines: going.entries().map(({ who, text, at, earlier, hidden, card, sources }) => ({ who, text, at, ...(earlier ? { earlier: true } : {}), ...(hidden ? { hidden: true } : {}), ...(!hidden && cardOf(card) ? { card: cardOf(card) } : {}), ...(!hidden && sourcesOf(sources).length ? { sources: sourcesOf(sources) } : {}) }))
  };
}

const chatTimers = new Map();
/** Forget it all ended the chat going on: it isn't in Chats, so the window mustn't say it is. */
let chatForgotten = false;
/**
 * A conversation going on, to the windows showing it (his own; on a server, the pages on that chat), once a change
 * has settled: the log says so as it happens.
 */
function showChat(key = 'local') {
  clearTimeout(chatTimers.get(key));
  chatTimers.set(key, setTimeout(() => {
    chatTimers.delete(key);
    if (!sessions) return;
    const message = { type: 'jester/chat', chat: currentChat(key), forgotten: chatForgotten };
    if (SERVER) postRemote(message, (remote) => viewingOf(remote) === key);
    else toHome(message);
    chatForgotten = false;
    if (SERVER) showOtherChats();
  }, 0));
}

let devicesTimer = null;
/** Where he's open changed: Settings' Devices reads it again, and so does each page's banner of other chats. */
function devicesChanged() {
  clearTimeout(devicesTimer);
  devicesTimer = setTimeout(() => {
    postRemote({ type: 'jester/devices-changed' });
    if (sessions) showOtherChats();
  }, 200);
  devicesTimer.unref?.();
}

/** Whether what's due while they're away can reach them: his app's notifications on a server, ntfy in the app alone. */
const phoneReady = () => (SERVER ? !!push?.ready : !!phone?.ready);

/** The newest line of his that each chat's device has been told of: one isn't sent twice. */
const repliedAt = new Map();
/**
 * A line of his was added to a chat on a server: when nobody's looking at that chat on its device (a task begun from
 * the phone finishing with the app closed, or his yes-or-no about it), it goes to that device as a notification.
 */
function replied(key) {
  if (!SERVER || !push || !sessions?.has(key)) return;
  const line = sessions.get(key).log.entries().at(-1);
  if (!line || line.who !== 'jester' || line.hidden || !String(line.text || '').trim()) return;
  const mark = `${line.at}|${line.text.length}`;
  if (repliedAt.get(key) === mark) return;
  repliedAt.set(key, mark);
  if (!push.has(key) || devices.inFront(key)) return;
  push.send({ title: 'Jester', text: line.text, tag: 'reply' }, { devices: [key] }).catch(() => undefined);
}

/** What a chat's device is called, for the chat kept of it: nothing in the app on its own, where there's only the one. */
const deviceLabel = (key) => (SERVER && key !== 'local' ? devices?.get(key)?.name || '' : '');

/** On a server: which chat a page is showing. Its own device's, unless it's looking at another's (jester/chats view). */
function viewingOf(remote) {
  return (remote?.viewing && sessions?.has(remote.viewing) && remote.viewing) || devices?.idOf(remote) || 'local';
}

/** On a server: the device the user's at, whose chat is the one in front: talked through, or last typed on. */
function frontDevice() {
  const voice = webGateway?.voiceClient;
  if (voice) return viewingOf(voice);
  const page = (webGateway?.clients || []).filter((client) => client.role === 'page').sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0))[0];
  return page ? viewingOf(page) : '';
}

/**
 * The chats going on on other devices, for a page's banner (the user, 2026-11-18: "see current chat from:" a device,
 * one with a running task first): each with something said in it, but the one the page is showing.
 */
function otherChats(remote) {
  const showing = viewingOf(remote);
  const own = devices.idOf(remote);
  const computers = remoteHands?.list() || [];
  const others = sessions.list()
    .filter((session) => session.key !== showing && session.log.entries().length)
    .map((session) => {
      const lines = session.log.entries();
      return { key: session.key, chat: session.log.chatId(), name: devices.get(session.key)?.name || (session.key === 'local' ? 'Jester, with no device open' : 'another device'), running: !!session.conversation.acting || computers.some((computer) => computer.running && computer.chat === session.key), at: Date.parse(lines.at(-1)?.at) || 0, lines: lines.length, own: session.key === own };
    })
    .sort((a, b) => Number(b.running) - Number(a.running) || b.at - a.at);
  return { others, viewing: showing === own ? null : { key: showing, name: devices.get(showing)?.name || 'another device' } };
}

let othersTimer = null;
function showOtherChats() {
  clearTimeout(othersTimer);
  othersTimer = setTimeout(() => {
    for (const client of webGateway?.clients || []) if (client.role === 'page') client.message({ type: 'jester/chats-live', ...otherChats(client) }, { id: 'jester-desktop', url: 'jester://ext/_desktop/worker' });
  }, 150);
}

/** The chat a page's message is for: on a server, the one it's showing, which is in front from now. */
function sessionOf(sender) {
  return sessions.used(SERVER && sender?.remote ? viewingOf(sender.remote) : 'local');
}

/** The Chats panel lists them again. */
function chatsChanged() {
  toHome({ type: 'jester/chats-changed' });
}

/** To his window only: the app's, and wherever it's open as a website. */
function toHome(message) {
  const win = homeWindow();
  if (win) postTo(win.webContents, message);
  postRemote(message);
}

/**
 * A chat carried on: the conversation going on is over, and in Chats at once, and the chat is the one going on again,
 * as if it had never stopped. What's typed with it is said to him, typed; the conversation that's over is summed up
 * once he's answered that (Ollama does one thing at a time). Not while he's at work on something the conversation
 * going on asked for, or a question of his waits: its result or its answer would land in the wrong chat.
 */
function resumeChat(id, text, session = sessions.front()) {
  const chat = keeper.get(id);
  if (!chat) return { ok: false, error: 'That chat isn’t kept any more.' };
  const { conversation: talk, log: going } = session;
  if (SERVER ? talk.asking : assistant.asking) return { ok: false, error: 'Jester is waiting for a yes or no. Answer him first, then pick this chat up.' };
  if (talk.acting) return { ok: false, error: 'Jester is still working on what you asked. Pick this chat up once he’s done, or stop him with the × beside his pill.' };
  let over = [];
  if (id !== going.chatId()) {
    // Whatever he was saying for the conversation going on stops with it.
    talk.end();
    over = going.restore(chat.lines, id);
    keeper.keep(over, { device: deviceLabel(session.key) });
    log('chat carried on:', chat.lines.length, 'lines');
  }
  const typed = String(text ?? '').trim().slice(0, TYPED_MAX);
  Promise.resolve(typed ? talk.told(typed, { typed: true }) : undefined)
    .catch(() => undefined)
    .finally(() => over.length && keeper.sumUp(over));
  return { ok: true };
}

/** The saved models as Settings lists them (keys masked), each with what it's cost this month, and the order they're tried in. */
async function connectionsWithSpend() {
  const listed = await assistant.connections.list();
  const connections = await Promise.all((listed.connections || []).map(async (connection) => ({ ...connection, spend: await spend.of(connection) })));
  return { ...listed, connections, paidFirst: modelHooks.paidFirst() };
}

/**
 * What both jobs' models share (model-jobs.js): paid ones first unless the settings say as saved, what each reply
 * cost, and a word on the screen when one has run out of credit, which nothing else would tell the user.
 */
const modelHooks = {
  paidFirst: () => settings?.paidModelsFirst !== false,
  onUsed: (used) => void spend?.record(used).catch((err) => log('spend: couldn’t count a reply:', err.message)),
  onFailed: ({ provider, model, kind, next }) => {
    if (kind !== 'credit') return;
    const name = PROVIDERS[provider]?.label || provider;
    overlays?.toast(`${name} is out of credit`, { tone: 'warn', detail: next ? `${next === 'this computer' ? 'This computer’s model' : next} takes over for now. ${model} is tried again in an hour.` : 'Add credit, or tick another model in Settings › Models.' });
  }
};

/** This computer's model (Ollama): the one chosen, or the best that's there. */
async function chatModel() {
  return settings?.assistantModel || pickModel((await ollamaModels()).models);
}

/**
 * Pictures of the window for the assistant's model. With JESTER_LOG_SCREENS,
 * the last one is kept beside the logs as last-picture.jpg, to see what the
 * model saw: your own screen, so only for debugging.
 */
function windowShot() {
  const shoot = createWindowShot({
    capturer: desktopCapturer,
    screen,
    images: nativeImage,
    allowed: () => settings?.agentScreenshots !== false && (process.platform !== 'darwin' || readStatuses().screen === 'granted'),
    ownWindows: () => BrowserWindow.getAllWindows(),
    toDip: (frame) => toDipFrame(screen, frame)
  });
  if (!env.JESTER_LOG_SCREENS) return shoot;
  const kept = async (snapshot, options) => {
    const shot = await shoot(snapshot, options);
    if (shot.ok) {
      const file = path.join(app.getPath('logs'), 'last-picture.jpg');
      fs.writeFileSync(file, Buffer.from(shot.image.data, 'base64'));
      log('assistant picture kept at', file);
    }
    return shot;
  };
  return Object.assign(kept, { allowed: shoot.allowed });
}

/** This computer's model, the jobs Settings › Models lets it do, and whether Ollama says it reads pictures. */
async function localModel() {
  const { models } = await ollamaModels();
  const model = settings?.assistantModel || pickModel(models);
  const vision = models.find((item) => item.name === model)?.vision;
  return { model, uses: localUses(settings), ...(typeof vision === 'boolean' ? { vision } : {}) };
}

/** Obsidian's own list of vaults, read at most every few seconds: Settings offers the one it has open. */
let obsidianList = { at: 0, vaults: [] };
function obsidianVaults() {
  if (Date.now() - obsidianList.at > OBSIDIAN_LIST_MS) obsidianList = { at: Date.now(), vaults: detectObsidianVaults() };
  return obsidianList.vaults;
}

/** Can't be read: macOS has kept Jester out of the folder (Documents, Desktop, iCloud). */
const refused = (err) => err?.code === 'EPERM' || err?.code === 'EACCES';

/** The search index, kept in the app's own folder, never the vault. */
const vaultIndexFile = () => path.join(app.getPath('userData'), 'vault-index.json');

/**
 * The vault in a folder chosen in Settings, or null when it isn't a folder: the vault inside it when it's the
 * folder above one, else the folder itself, and always the folder Jester already keeps his memory in, whatever's
 * been put inside it since. That's kept as the choice, so it's worked out once: worked out again, a second vault
 * put beside the first would make the folder above the vault, and his memory would move out of both.
 */
function vaultRootIn(folder) {
  return fs.existsSync(path.join(folder, PATHS.aboutMe)) ? path.resolve(folder) : findVaultRoot(folder);
}

/**
 * The vault chosen in Settings, opened. Reading it is when macOS asks whether
 * Jester may use a guarded folder, so that only ever follows the user choosing
 * it there. Nothing changes when nothing has.
 */
function openVault() {
  if (!vaultIndex) return;
  const chosen = settings?.memoryVault || '';
  let root = null;
  let problem = '';
  if (chosen) {
    try {
      fs.readdirSync(chosen);
      root = vaultRootIn(chosen);
      if (!root) problem = 'missing';
      // Chosen as the folder above it before Jester could look inside, or before choices were kept this way: the vault becomes the choice.
      else if (root !== chosen) saveSettings({ memoryVault: root }).catch((err) => log('memory: couldn’t keep the vault as chosen:', err.message));
    } catch (err) {
      problem = refused(err) ? 'denied' : err.code === 'ENOENT' ? 'missing' : err.message;
    }
  }
  if (root === (vault?.root ?? null) && problem === vaultProblem) return;
  vault = null;
  vaultProblem = problem;
  indexedAs = '';
  if (root) {
    try {
      const opened = createVault({ root, trash: (file) => shell.trashItem(file) });
      opened.ensureLayout();
      vault = opened;
      log('memory: vault', root);
    } catch (err) {
      vaultProblem = refused(err) ? 'denied' : err.message;
      log('memory: can’t use the vault:', err.message);
    }
  }
  // The search follows whichever vault this is (close() is for quitting): watching it, or stopping with none.
  vaultIndex.watch();
  if (vault) writeRoutinesNote();
  refreshVault();
}

/**
 * The vault read again, and Settings told it's being read till it's done. What follows a read, whoever asked for
 * it, is vaultRead's. `retry` (Read again): Ollama is tried now, not a minute after it last failed.
 */
function refreshVault({ retry = false } = {}) {
  if (!vaultIndex) return;
  vaultReading = true;
  vaultIndex.refresh({ retry }).catch((err) => {
    vaultReading = false;
    log('memory: couldn’t read the vault:', err.message);
  });
}

/** After the vault's been read, by Settings, a choice or the watcher: its Index note, and Settings told. */
function vaultRead() {
  vaultReading = false;
  writeIndexNote();
  post(desktopState());
}

/**
 * Settings' Stop using: no vault, so Jester neither reads nor writes one. What he'd read of it goes from the app's
 * folder too, once a read under way (which saves as it ends) has finished.
 */
async function stopUsingVault() {
  await saveSettings({ memoryVault: '' });
  await refresh();
  await vaultIndex.refresh();
  if (!vault) fs.rmSync(vaultIndexFile(), { force: true });
}

/** The notes as last listed in Index.md, so rewriting it (which the watcher sees) doesn't go round again. */
let indexedAs = '';
function writeIndexNote() {
  if (!vault) return;
  try {
    const notes = vault.listNotes().filter(({ rel }) => !VIEWS.includes(rel));
    const listed = JSON.stringify(notes.map(({ rel, mtimeMs }) => [rel, mtimeMs]));
    if (listed === indexedAs) return;
    // A note that can't be read (gone since, or kept from Jester) is left out, not the whole Index.
    const entries = notes.flatMap(({ rel }) => {
      try {
        const note = vault.read(rel);
        return [{ rel, title: note.title, type: String(note.data?.type || ''), updated: String(note.data?.updated || note.data?.date || '') }];
      } catch {
        return [];
      }
    });
    vault.writeIndex(entries);
    indexedAs = listed;
  } catch (err) {
    log('memory: couldn’t write the index note:', err.message);
  }
}

/** Routines.md: what Jester does with no model, rewritten when that changes. */
let routinesTimer = null;
function writeRoutinesNote() {
  clearTimeout(routinesTimer);
  routinesTimer = setTimeout(async () => {
    if (!vault || !learned) return;
    try {
      vault.writeRoutines(await learned.list());
    } catch (err) {
      log('memory: couldn’t write the routines note:', err.message);
    }
  }, ROUTINES_DELAY_MS);
}

/** Settings' Memory section. */
function memoryState() {
  return {
    chosen: settings?.memoryVault || '',
    root: vault?.root || '',
    name: vault?.name || '',
    problem: vaultProblem,
    reading: vaultReading,
    search: vaultIndex?.status() || null,
    detected: obsidianVaults(),
    conversations: settings?.memoryConversations !== false,
    // The chats imported from Claude and ChatGPT, as last counted, and the run that learns from them.
    chats: (vault && chatLearner?.counted()) || null,
    learning: chatLearner?.status() || null
  };
}

/**
 * Settings › Memory's Import: the export the user chooses from Claude or ChatGPT, each chat made a note in the vault's
 * Claude or ChatGPT folder (chat-import.js), then the vault read again so he can answer from them. What came of it,
 * for Settings to say; nothing when they cancelled.
 */
async function importChatsChosen() {
  const picked = await dialog.showOpenDialog({
    title: 'Import your chats from Claude or ChatGPT',
    message: 'Choose the zip Claude or ChatGPT sent you (Claude’s is conversations-000.zip), the conversations.json in it, or the folder it was unzipped into.',
    buttonLabel: 'Import',
    // A Mac's dialog takes files and folders at once: Safari unzips what it downloads.
    properties: process.platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    filters: [{ name: 'Chat exports', extensions: ['zip', 'json'] }],
    defaultPath: app.getPath('downloads')
  });
  if (picked.canceled || !picked.filePaths.length || !vault) return null;
  try {
    const result = await importChats({ vault, files: picked.filePaths, log });
    const counts = Object.entries(result.sources).map(([name, tally]) => `${name} ${tally.added} new, ${tally.updated} updated, ${tally.same} unchanged, ${tally.empty} empty`);
    log(`import: ${counts.join('; ') || 'no chats'}; ${result.leftOut} line(s) left out as secrets${result.failed ? `; ${result.failed} not written` : ''}${result.problems.length ? `; ${result.problems.length} file(s) not read` : ''}`);
    if (Object.values(result.sources).some((tally) => tally.added || tally.updated)) refreshVault();
    return result;
  } catch (err) {
    log('import: failed:', err.message);
    return { error: err.message };
  }
}

/** How many things he's learned about the user, and how many they asked him to keep: for Settings › Memory. */
function knownCounts() {
  if (!vault) return null;
  try {
    return { facts: vault.aboutMe().facts.length, kept: vault.listNotes().filter((note) => note.rel.startsWith(`${PATHS.remembered}/`)).length };
  } catch (err) {
    log('memory: couldn’t count what’s known:', err.message);
    return null;
  }
}

/**
 * The link to the Chrome extension: the relay put where Chrome can start it,
 * then the app listening for it. A Jester with its own JESTER_DATA_DIR (a test)
 * leaves the user's browsers and the real Jester's socket alone: it listens
 * only on a JESTER_LINK_SOCKET it's given. JESTER_NO_LINK: no link at all.
 */
function startChromeLink() {
  const testing = !!env.JESTER_DATA_DIR;
  if (env.JESTER_NO_LINK || (testing && !env.JESTER_LINK_SOCKET)) return;
  if (!testing) {
    try {
      linkHost = installLinkHost({ relaySource: driverPath() });
      log('chrome link:', linkHost.why || `relay for ${linkHost.browsers.join(', ') || 'no browser yet'}${linkHost.changed ? ' (updated)' : ''}`);
    } catch (err) {
      linkHost = { browsers: [], why: err.message };
      log('chrome link: not installed:', err.message);
    }
  }
  chromeLink = createChromeLink({
    send: (message) => !!linkTransport?.send(message),
    version: app.getVersion(),
    onChange: () => {
      useBrowserBindings();
      refresh();
    },
    // The extension's task, on this pill: the steps of one handed to it, as the assistant's own
    // are; one it began itself (its popup's "keep going") shows as it would have in Chrome.
    onPill: (voice) => {
      if (!assistant.running) post({ type: MSG.VOICE, voice: { position: 'bottom-center', ...voice } });
      else if (voice.phase === 'thinking') assistant.step(voice.step);
    },
    onAsk: (label) => assistant.question(label),
    onVoice: () => onJester('voice'),
    onScrape: (request, options) => webScraper.request(request, options),
    log
  });
  linkTransport = startLink({
    ...(env.JESTER_LINK_SOCKET ? { socketPath: env.JESTER_LINK_SOCKET } : {}),
    allowedOrigins: linkOrigins(),
    onConnect: (origin, hello) => chromeLink.connected(origin, hello),
    onMessage: (message) => chromeLink.message(message),
    onDisconnect: () => chromeLink.disconnected()
  });
  linkTransport.ready.catch((err) => log('chrome link: can’t listen:', err.message));
}

/** Something can read pages for research: the Scrapling helper is set up, or the extension's linked. */
const webReady = () => webScraper.ready() || !!chromeLink?.linked;

/**
 * A page for research (web-research.js). Signed-in ones, only when the user asked about Canvas or open pages
 * (`signedIn`), through the open tab in Chrome: its cookies never leave it. Everything else anonymously, through
 * Scrapling, or through the extension's reader when Scrapling isn't set up (never after Scrapling refused one: a
 * private address).
 */
async function readWeb(request, { signal } = {}) {
  if (request.op === 'tabs') {
    return chromeLink?.linked ? chromeLink.web(request, { signal })
      : { ok: false, code: 'browser_not_linked', detail: 'Link the Jester extension to read signed-in pages already open in Chrome.' };
  }
  if (request.op === 'scrape' && request.signedIn && chromeLink?.linked) {
    const open = await chromeLink.web({ ...request, openOnly: true }, { signal });
    if (signal?.aborted || (open && !['no_open_tab', 'browser_unavailable', 'timeout', 'disconnected'].includes(open.code))) return open;
  }
  const { signedIn, ...anonymous } = request;
  const result = await webScraper.request(anonymous, { signal });
  if (!signal?.aborted && ['setup_required', 'worker_failed', 'busy'].includes(result.code) && chromeLink?.linked) {
    return chromeLink.web(anonymous, { signal });
  }
  return result;
}

/** With the linked browser in front, the engine goes by the extension's gestures; otherwise, the app's. */
function useBrowserBindings() {
  const using = browserMode && !!chromeLink?.linked;
  engineHost?.useBindings(using ? chromeLink.bindings() : null);
}

/** jester-driver, restarted if it dies. JESTER_DRIVER_DRY=1: it describes input instead of sending it. */
function startInput() {
  try {
    driver = startDriver({
      dryRun: !!env.JESTER_DRIVER_DRY,
      onExit: (code, signal) => {
        driver = null;
        if (quitting) return;
        log('jester-driver exited', signal || code, '— restarting');
        setTimeout(startInput, 1000);
      }
    });
  } catch (err) {
    driver = null;
    log(err.message);
  }
}

/**
 * Gmail's asked what's new, and what's worth telling is put on the clock to be told like any line of his: said, sent
 * to their phone or held, by where they are.
 */
async function checkMail() {
  if (!google.signedIn || settings?.mailWatch === false || mailBusy) return undefined;
  const hour = new Date().getHours();
  const quiet = !env.JESTER_ANY_HOUR && (hour >= 22 || hour < 8);
  try {
    await mail.check();
  } catch (err) {
    if (err.code !== 'signin') return void log('mail: couldn’t look:', String(err.code || 'error'));
    // Signed out by Google (a week in its Testing state, or access taken away): nothing's read till they're back in,
    // and his place in the inbox is made afresh then. Said once, and not in the night.
    await mail.reset();
    if (signInTold) return undefined;
    signInTold = true;
    const morning = new Date();
    morning.setHours(8, 0, 0, 0);
    if (hour >= 22) morning.setDate(morning.getDate() + 1);
    clock.add({ id: 'mail-signin', kind: 'say', ...(quiet ? { at: morning.getTime() } : { inMs: 0 }), keepFor: 12 * 3600_000, payload: { text: 'Google has signed me out of your Gmail. Sign in again in Settings, under Email, and I’ll go on watching it.', title: 'Email' } });
    return undefined;
  }
  // What's been found worth telling and not told yet: this look's, and the night's if the morning's brief didn't
  // take it. In the night it's left for the morning.
  const due = mail.unsaid();
  if (!due.length) return undefined;
  if (quiet) return void log(`mail: ${due.length} kept for the morning`);
  // Someone who wrote to them, with the linked Chrome there: he offers to draft a reply in Gmail, and leave it unsent.
  const writer = settings?.offerWork !== false && chromeLink?.linked ? due.find((message) => personal(message) && /^[0-9a-f]{6,32}$/.test(message.thread || '')) : null;
  const offered = writer && offers ? await offers.propose([draftOffer(writer)], { source: 'mail' }).catch(() => []) : [];
  // A line like any other he tells: said, sent to their phone or held, by where they are. Other people's words.
  clock.add({ kind: 'say', inMs: 0, keepFor: 12 * 3600_000, payload: { text: mailLine(due), card: mailCard(due), untrusted: true, title: 'Email', priority: 3, ...(offered.length ? { offers: offered } : {}) } });
  await mail.said(due.map((message) => message.id));
  return undefined;
}

/**
 * Getting started (setup.js): what a new user still has to set up, and what they can add, from how things stand.
 * @returns {Promise<{steps:object[], ready:boolean, left:number, more:number, words:string}>}
 */
async function setupState() {
  const saved = (await talking?.savedOnes().catch(() => [])) || [];
  const local = saved.length ? null : await talking?.localOne().catch(() => null);
  const model = saved.length > 0 || !!local?.model;
  const steps = setupSteps({
    missing: missingFor(permissions, settings).map((item) => item.label),
    model,
    // A key pasted and saved for actions alone: he still can't answer, and the list says why.
    otherModel: !model && ((await loadConnections().catch(() => [])) || []).length > 0,
    hearing: voiceState() !== 'missing',
    listening: !!settings?.continuousAssistant,
    ownVoice: (kokoro?.state || 'missing') !== 'missing',
    voiceprint: !!voiceprint,
    vault: !!vault,
    day: !!whereabouts?.connected || !!calendars?.connected,
    phone: phoneReady(),
    mail: !!google?.signedIn,
    chrome: !!chromeLink?.linked
  });
  const summary = setupSummary(steps);
  // Once he's been ready, he has been set up: a launch after that with a model away (Ollama not up yet) isn't a
  // first launch, and doesn't open his window to say so.
  if (summary.ready && !setUpOnce) void storage.local.set({ setUpOnce: (setUpOnce = true) }).catch(() => undefined);
  return { steps, ...summary };
}

/** Gmail's looked at every few minutes while they're signed in and want it watched, and not otherwise. */
function syncMail() {
  if (!clock || !google) return;
  const on = google.signedIn && settings?.mailWatch !== false;
  // The switch turned back on after a while off: his place in the inbox is made afresh, not a backlog announced.
  // (Signing in makes it afresh itself.)
  const wanted = settings?.mailWatch !== false;
  if (wanted && mailWatched === false && google.signedIn) mail.reset().catch(() => undefined);
  mailWatched = wanted;
  const job = clock.list().find((item) => item.id === 'mail-check');
  if (on && job?.everyMs !== CHECK_MS) clock.add({ id: 'mail-check', kind: 'mail', everyMs: CHECK_MS });
  else if (!on && job) clock.remove('mail-check');
}

/** A brief's been given, unasked or asked for: not again today. */
async function briefGiven(which, made = null) {
  // Today's, read: not given again today. One of another day's, read again, says nothing about today.
  if ((which === 'morning' || which === 'evening') && dayOf(made?.createdAt || Date.now()) === dayOf(Date.now())) {
    briefDays = { ...briefDays, [which]: dayOf(Date.now()) };
    await storage.local.set({ briefDays }).catch(() => undefined);
  }
  // The mail it told of has been told.
  if (made?.mailIds?.length) await mail?.said(made.mailIds);
}

function briefingHistory() {
  const old = (keeper?.list() || []).slice(0, 30).flatMap(({ id }) =>
    (keeper.get(id)?.lines || []).map((line) => ({ ...line, chat: id })));
  return [...old, ...(conversationLog?.entries() || [])]
    .filter((line) => !line.hidden).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-600);
}

function publishBriefings() {
  if (!briefingManager?.ready) return;
  post({ type: 'jester/briefings-changed', cards: briefingManager.list().map((record) => briefingManager.card(record)) });
}

/** What he's offered and what came of it, for his window's cards; and how that stood when it was last sent. */
let offersShown = '';
const offersKey = () => offers.list().map((offer) => `${offer.id}:${offer.status}`).join(',');
function publishOffers() {
  if (!offers?.ready) return;
  offersShown = offersKey();
  post({ type: 'jester/offers-changed', offers: offers.list() });
}

/** Whether he offers work at all (Settings › Assistant and voice), and what there is to do it with. */
const offering = () => ({ on: settings?.offerWork !== false, chrome: !!chromeLink?.linked, web: webReady() });

/** A brief as composed, with what it found to offer kept (offers.js) and named on it by id. */
async function withOffers(made, source) {
  if (!made?.offers?.length || !offers) return made ? { ...made, offers: undefined } : made;
  const kept = await offers.propose(made.offers, { source }).catch((err) => (log('offers: couldn’t keep them:', err.message), []));
  return { ...made, offers: undefined, offerIds: kept.map((offer) => offer.id) };
}

function briefingMade(record) {
  // What it offered and is still waiting on an answer: asked once it's been read.
  return record ? { ...record, card: briefingManager.card(record), briefingId: record.id, offers: settings?.offerWork === false ? [] : offers?.waiting(record.offerIds) || [] } : null;
}

async function readStoredBriefing(id) {
  const result = await briefingManager.respond(id, 'read');
  if (result.ok) clock?.remove(`brief-later-${id}`);
  return result.ok ? briefingMade(result.record) : null;
}

async function respondToBriefing(id, op) {
  const result = await briefingManager.respond(id, op);
  if (result.ok && op === 'later') {
    clock.add({ id: `brief-later-${id}`, kind: 'brief', at: result.record.laterUntil,
      keepFor: EVENING_KEEP_MS, payload: { which: result.record.kind, briefingId: id } });
  } else if (result.ok) clock.remove(`brief-later-${id}`);
  return result;
}

/** Custom topic briefings can read evidence; they never start computer control. */
async function researchForBriefing({ goal, context = '', signal }) {
  const abort = new AbortController();
  briefingResearchAbort?.abort();
  briefingResearchAbort = abort;
  const researchSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  try {
    // The bar's Stop stops this, and nothing else at work.
    const shown = { owner: abort, stop: () => abort.abort() };
    researchPresentation.update({ active: true, phase: 'reading', label: 'Gathering sources for your briefing…', goal }, shown);
    return await researchWeb({ goal, context, signal: researchSignal, model: (request) => talking(request), scrape: readWeb,
      onStep: ({ phase, label }) => {
        if (!researchSignal.aborted && briefingResearchAbort === abort) researchPresentation.update({ active: true, phase, label, goal }, shown);
      } });
  } finally {
    if (briefingResearchAbort === abort) briefingResearchAbort = null;
    researchPresentation.update({ active: false }, { owner: abort });
  }
}

/**
 * The model that words a brief: only a paid one, and only if it's the one that answers. A paid model resting is
 * covered for by a free one or this computer's (model-jobs.js), and qwen3.5:9b gave a wrap-up "seventy-five degree
 * weather" and a three o'clock call "this evening": what a model makes up in words can't be caught, so those say
 * the facts plainly instead.
 */
async function briefWriter(options) {
  const first = (await talking.savedOnes())[0];
  if (first?.plan !== 'paid') throw new Error('no paid model to word it');
  const reply = await talking(options);
  if (reply?.provider !== first.provider || reply?.model !== first.model) throw new Error('the paid model didn’t answer');
  return reply;
}

/**
 * They've sat down: if the morning's brief hasn't been given today and it's still that part of the day, it's put on
 * the clock for a few seconds from now, so it isn't the first thing they hear as the screen unlocks.
 */
function queueMorningBrief() {
  if (!clock || settings?.briefMorning === false) return;
  const at = Date.now();
  // Not in the small hours, which are still yesterday's day. JESTER_MORNING_ENDS: for a check run in the evening.
  const hour = new Date(at).getHours();
  if ((hour < DAY_STARTS && !env.JESTER_MORNING_ENDS) || hour >= (Number(env.JESTER_MORNING_ENDS) || MORNING_ENDS) || briefDays.morning === dayOf(at)) return;
  if (briefingManager?.ready && briefingManager.list().some((record) => record.kind === 'morning'
      && dayOf(record.createdAt) === dayOf(at) && (record.offeredAt || ['read', 'dismissed', 'later', 'reading', 'replaced'].includes(record.status)))) return;
  clock.add({ id: 'brief-morning', kind: 'brief', inMs: (Number(env.JESTER_SETTLE_MS) || SETTLE_MS) + 2000, keepFor: MORNING_KEEP_MS, payload: { which: 'morning' } });
}

/**
 * The evening wrap-up's place on the clock, at the hour Settings names, and a check-in for each thing on the calendar
 * in the next day: put on, moved or taken off as the settings and the calendar change. Asked every few minutes.
 */
function syncBriefs() {
  if (!clock || !briefs) return;
  const jobs = clock.list();
  const evening = jobs.find((job) => job.id === 'brief-evening');
  const hour = /^([01]?\d|2[0-3]):[0-5]\d$/.test(settings?.eveningAt || '') ? settings.eveningAt : EVENING_AT;
  if (settings?.briefEvening === false) evening && clock.remove('brief-evening');
  else if (evening?.daily !== hour) clock.add({ id: 'brief-evening', kind: 'brief', daily: hour, keepFor: EVENING_KEEP_MS, payload: { which: 'evening' } });
  const lead = Number(settings?.checkInMinutes) > 0 ? Math.min(Number(settings.checkInMinutes), 120) : CHECKIN_MIN;
  const wanted = settings?.checkIns === false ? [] : briefs.checkins(lead);
  const ids = new Set(wanted.map((job) => job.id));
  for (const job of jobs.filter((item) => item.kind === 'checkin' && !ids.has(item.id))) clock.remove(job.id);
  // One already said is done with, though its event is still to come and would be found again each time.
  for (const [id, start] of Object.entries(checkinsTold)) if (!(start > Date.now())) delete checkinsTold[id];
  for (const job of wanted) if (!checkinsTold[job.id] && jobs.find((item) => item.id === job.id)?.at !== job.at) clock.add({ ...job, kind: 'checkin' });
}

/** macOS drops synthetic input silently until Accessibility is allowed. */
function canPost() {
  if (env.JESTER_DRIVER_DRY || process.platform !== 'darwin') return true;
  return !!permissions.find((item) => item.id === 'accessibility')?.granted;
}

/** One report from the watch: asleep means a full stop for it too. */
function onWatchReport(report) {
  // The watch's Talk button: the mic opens for one command (or closes), as the ☝️ gesture has it, with no need of
  // his name or of the voice being known: a tap on their own paired watch is them.
  if (report.talk) {
    log('watch: talk');
    toggleVoice();
  }
  if (report.talk || report.steering || report.click) presence?.seen('watch');
  const refused = !report.steering ? '' : engine.state === ENGINE.SLEEPING ? `Jester is asleep: ${wakeWords()}` : canPost() ? '' : 'Allow Accessibility in Jester’s Settings first';
  if (refused && refused !== watchRefused) overlays.toast(refused, { tone: 'warn' });
  watchRefused = refused;
  if (refused) return pointer.nudge({ steering: false });
  const moved = steerBy(steady(report), { speed: settings?.watchSpeed, invertY: settings?.watchInvertY });
  return pointer.nudge({ ...moved, click: report.click && !report.typing, held: report.held && !report.typing, whole: report.whole, steering: report.steering });
}

function onJester(op) {
  if (op === 'voice') toggleVoice();
  else if (op === 'calibrate') showCalibration(pointerDisplay());
  else if (op === 'settings') showSettings();
  else if (op === 'sleep') sleep(true);
  else if (op === 'controls') showControlsScreen();
}

/**
 * Controls: a screen of his window (the user, 2026-11-18: "part of the view instead of ... a new window"), from the
 * menu bar, "open controls", or the sliders button beside the gear. Linked to the cloud, it's his website's, in the
 * Mac's window there (windows.js showHome).
 */
function showControlsScreen() {
  return showHome({ screen: 'controls' });
}

/**
 * Controls has come in: what's on is read again for each script that says so and wasn't read in the last half minute
 * (the user chose "check when Controls opens"). A served script stays logged in a minute after, so the first press is
 * quick.
 */
async function controlsOpened() {
  const { blocks } = await scripts.list();
  for (const block of blocks) if (block.hasStatus && (!block.state || Date.now() - block.state.at > 30000)) scripts.refresh(block.id).catch(() => undefined);
}

/** The folder dialog for adding a script: '' if it was cancelled. Asked for from his website, it's in front first. */
async function chooseScriptFolder({ fromServer = false } = {}) {
  if (fromServer) app.focus({ steal: true });
  const win = fromServer ? null : homeWindow();
  const options = { title: 'Add a script folder', buttonLabel: 'Add', message: 'Choose the folder your script is in.', properties: ['openDirectory'] };
  const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return canceled ? '' : filePaths?.[0] || '';
}

/**
 * What Controls asks of the scripts. The page sends a script's id, a control's id, a value and an aim, never a
 * command line: scripts.js makes that from the folder's jester.json. From his website, through the server, it's
 * scriptsRemote's to pass on (script-remote.js).
 */
async function scriptsAsked(message) {
  const id = String(message.script ?? '');
  switch (message.op) {
    case 'open':
      showControlsScreen();
      return { ok: true };
    case 'opened':
      await controlsOpened();
      return { ok: true };
    case 'list':
      return { ok: true, ...(await scripts.list()) };
    case 'run':
      return scripts.run({ script: id, control: String(message.control ?? ''), value: message.value, aim: typeof message.aim === 'string' ? message.aim : '', drag: message.drag === true });
    case 'refresh':
      await scripts.refresh(id);
      return { ok: true };
    case 'choose': {
      const folder = await chooseScriptFolder();
      return { ok: !!folder, folder };
    }
    case 'inspect':
      return scripts.inspect(String(message.folder ?? ''));
    case 'edit': {
      const view = scripts.view(id);
      if (!view) return { ok: false, why: 'That script isn’t in Controls any more.' };
      return { ...(await scripts.inspect(view.folder)), script: id };
    }
    case 'save':
      return scripts.save(String(message.folder ?? ''), message.manifest);
    case 'remove':
      return scripts.remove(id);
    case 'menu':
      return scripts.setMenu(id, message.on === true);
    case 'reveal': {
      const view = scripts.view(id);
      if (view) shell.showItemInFolder(path.join(view.folder, 'jester.json'));
      return { ok: !!view };
    }
    case 'scene-run':
      return scripts.runScene(String(message.id ?? ''));
    case 'scene-save':
      return scripts.saveScene(message.scene || {});
    case 'scene-remove':
      return scripts.removeScene(String(message.id ?? ''));
    default:
      return { ok: false };
  }
}

/** How to wake Jester, in a few words. */
const wakeWords = () => wakeHint(resumeGlyphs(settings), process.platform);

/**
 * Sleep or wake from a spoken command or the menu; a gesture's is done in the
 * engine. Asleep is a full stop, so a task running ends with it, as in Chrome.
 */
function sleep(on) {
  if (on) assistant.cancel();
  engineHost.sleep(on);
}

/** The ×, answered Yes. */
async function stopAutomation() {
  if (!assistant.running) return;
  log('assistant stopped from the pill');
  // The mic may be open for a spoken yes: anything said next isn't meant for it.
  engineHost.voice('cancel');
  conversation.hush();
  await assistant.cancel();
  overlays.toast('Automation stopped');
}

/** Why the mic can't open for a command right now, or '' if it can. `mic: false` leaves the permission out. */
function voiceProblem({ mic = true } = {}) {
  if (!settings?.enabled) return 'Jester is off';
  if (!settings.voiceEnabled) return 'Voice commands are off in Jester’s Settings';
  if (engine.state === ENGINE.SLEEPING) return `Jester is asleep: ${wakeWords()}`;
  if (voiceState() === 'missing') return 'The speech model isn’t installed (in desktop/: npm run models)';
  if (mic && !mediaAllowed('audio')) return 'Allow the Microphone in Jester’s Settings first';
  return '';
}

/** How often, at most, what a turn waits on is got ready: once Ollama has the notes' model, asking again is nothing. */
const WARM_EVERY_MS = 30000;
let warmedAt = 0;

/**
 * He's about to be asked something (his name was heard, the mic was opened, or they're typing to him): the model
 * that searches the user's notes by meaning is loaded meanwhile. Ollama drops it after ten idle minutes, and the
 * first question after that waited on it for up to 1.2 s, or went without (vault-index.js QUERY_MS).
 */
function warmUp() {
  if (Date.now() - warmedAt < WARM_EVERY_MS) return;
  warmedAt = Date.now();
  vaultIndex?.warm().catch((err) => log('couldn’t get the notes’ search ready:', err.message));
  // His voice too: half a second to load, and he'll want it within a few.
  if (listening) kokoro?.warm();
}

/** The voice shortcut, gesture or menu item: start listening, or finish. */
function toggleVoice() {
  // About to be spoken to: not across a ringing timer, which the mic would hear.
  ring?.stop('their talking to him');
  const problem = voiceProblem({ mic: false });
  if (problem) return overlays?.toast('Voice commands', { tone: 'warn', detail: problem });
  if (!mediaAllowed('audio')) {
    // Not asked yet: the first command asks macOS, and goes ahead if allowed.
    if (process.platform === 'darwin' && readStatuses().microphone === 'not-determined') {
      requestPermission('microphone').then((granted) => {
        checkPermissions();
        if (granted) toggleVoice();
      });
      return;
    }
    return overlays?.toast('Voice commands', { tone: 'warn', detail: voiceProblem() });
  }
  conversation.hush();
  voiceRunner.prepare();
  warmUp();
  engineHost.voice('toggle');
}

/** Each spoken command's number: an older one that ends late (a task it was cancelled out of) leaves the pill to the newer. */
let commandCount = 0;

/** A finished utterance, done; the pill says how it went. */
async function onVoiceCommand(text) {
  // Said aloud: what's asked about it is asked aloud.
  conversation.spoke();
  // An answer to the assistant's question, or "stop": the assistant's, not a command.
  if (assistant.heard(text)) return;
  // On purpose, and for him: he answers it as he would anything else, aloud.
  if (listening) return void conversation.told(text);
  const mine = ++commandCount;
  const { outcome } = await voiceRunner.run(text);
  if (mine !== commandCount) return;
  // `command`: his window says so too, which a conversation's own answers (in the chat already) aren't.
  post({ type: MSG.VOICE, voice: outcome ? { phase: 'answer', text: outcome.text, ok: outcome.ok, command: true } : { active: false } });
  voiceHeard?.({ text, outcome });
  voiceHeard = null;
}

/**
 * Twice a second: which display has the pointer (where feedback goes), and
 * whether the front window fills its display (which binding set is live).
 */
function watchFront() {
  let busy = false;
  let frontPid = null;
  setInterval(async () => {
    overlays?.track(settings?.showHud !== false);
    researchPresentation.observe();
    if (busy || !driver) return;
    busy = true;
    try {
      const front = await driver.call('frontmost');
      // Chromium apps take ~2 s to build the tree aim-assist reads: start as
      // soon as an app comes to the front, while the cursor is in use.
      // Not Jester itself: its own windows have nothing to aim at.
      if (settings?.pointerEnabled && front.app?.pid && front.app.pid !== frontPid && front.app.pid !== process.pid) driver.call('wake', { pid: front.app.pid }).catch(() => undefined);
      frontPid = front.app?.pid ?? frontPid;
      const inBrowser = !!chromeLink?.inFront(front.app?.pid);
      if (inBrowser !== browserMode) {
        browserMode = inBrowser;
        log('chrome link:', inBrowser ? 'Chrome in front, its gestures' : 'the app’s gestures');
        useBrowserBindings();
      }
      let bounds = front.window?.bounds;
      // The driver speaks physical pixels on Windows; displays are in DIPs.
      if (bounds && process.platform === 'win32') {
        const dip = screen.screenToDipRect(null, { x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h });
        bounds = { x: dip.x, y: dip.y, w: dip.width, h: dip.height };
      }
      const next = fillsDisplay(bounds, screen.getAllDisplays().map((display) => display.bounds)) ? 'fullscreen' : 'windowed';
      if (next !== context) {
        context = next;
        log('context', context, `(${front.app?.name || 'unknown app'})`);
        engineHost?.setContext(context);
      }
    } catch {
      /* no ordinary window in front: keep the last context */
    } finally {
      busy = false;
    }
  }, FRONT_POLL_MS);
}

function checkPermissions() {
  const before = JSON.stringify(permissions);
  const cameraBefore = permissions.find((item) => item.id === 'camera')?.granted;
  permissions = readPermissions();
  if (JSON.stringify(permissions) === before) return;
  const cameraNow = permissions.find((item) => item.id === 'camera')?.granted;
  // The engine checked the camera when it started and stopped there: start it again.
  if (cameraNow && cameraBefore === false) engineWindow?.webContents.reload();
  refresh();
}

async function onTrayAction(id, checked, item) {
  // A script's button or preset, or a scene, from the menu bar: done at once, and said on the screen.
  if (item?.step || item?.scene) {
    const outcome = item.scene ? await scripts.runScene(item.scene) : await scripts.run(item.step);
    if (outcome.text) overlays.toast(outcome.text, outcome.ok ? {} : { detail: 'From the menu bar' });
    return undefined;
  }
  switch (id) {
    case 'controls':
      return showControlsScreen();
    case 'enabled':
      return saveSettings({ enabled: checked });
    case 'gestures':
      return saveSettings({ gesturesEnabled: checked });
    case 'pointer':
      return saveSettings({ pointerEnabled: checked });
    case 'voice':
      return saveSettings({ voiceEnabled: checked });
    case 'watch':
      return saveSettings({ watchEnabled: checked });
    case 'continuous':
      return saveSettings({ continuousAssistant: checked });
    case 'ring':
      return void ring?.stop('his menu');
    case 'listen':
      return toggleVoice();
    case 'sleep':
      return sleep(true);
    case 'wake':
      return sleep(false);
    case 'talk':
      return showTalk();
    case 'permissions':
      return showSettings({ page: 'permissions' });
    case 'settings':
      return showSettings();
    case 'restart':
      return restart();
    case 'quit':
      return app.quit();
    default:
      return undefined;
  }
}

/** The new Jester starts once this one has quit, so its single-instance lock is free. */
function restart() {
  app.relaunch();
  app.quit();
}

function listenToPages() {
  onMessage(async (message, sender) => {
    const url = String(sender?.url || '');
    // The calibration screen asks the worker how the engine is, as in Chrome.
    if (message?.type === MSG.GET_STATE && url.startsWith('jester://ext/src/calibration/')) return { settings: await loadSettings(), engine };
    if (!url.startsWith('jester://app/')) return undefined;
    switch (message?.type) {
      // His website's Settings › Devices: the password that signs a new device in (web-login.js). Set or changed
      // only from a device that's signed in, and with the current one when there is one.
      case 'jester/web-login': {
        if (!SERVER || !webLogin || !sender?.remote) return { ok: false };
        const source = sender.remote.from || `page-${sender.remote.id}`;
        let done = { ok: true, error: '' };
        if (message.op === 'set') done = await webLogin.set(String(message.password ?? ''), { current: String(message.current ?? ''), source });
        else if (message.op === 'remove') done = await webLogin.remove({ current: String(message.current ?? ''), source });
        return { ...done, ...webLogin.state() };
      }
      // His website's Settings › Devices: notifications to this device, from his own app (push.js).
      case 'jester/push': {
        if (!SERVER || !push || !sender?.remote) return { ok: false };
        const device = devices.idOf(sender.remote);
        if (message.op === 'subscribe') {
          const ok = await push.subscribe(device, message.subscription);
          return { ok, on: push.has(device), error: ok ? '' : 'That isn’t a subscription a browser’s push service gave.' };
        }
        if (message.op === 'unsubscribe') await push.unsubscribe(device);
        else if (message.op === 'test') {
          const sent = await push.send({ title: 'Jester', text: 'This is Jester, on this device. What you’re due while you’re away from your devices comes here.' }, { devices: [device], anyway: true });
          return { ok: sent.went, on: push.has(device), error: sent.went ? '' : `It didn’t go: ${push.state().last?.problem || 'this device isn’t taking notifications'}.` };
        }
        return { ok: true, on: push.has(device), key: push.publicKey };
      }
      // His website's Settings › Devices: where he's open, a device's name, one forgotten.
      // A computer's switches, thrown from another device (the phone as a remote).
      case 'jester/computer':
        if (!SERVER || !remoteHands) return { ok: false };
        return remoteHands.set(String(message.device ?? ''), message.change && typeof message.change === 'object' ? message.change : {});
      case 'jester/devices': {
        if (!SERVER || !devices) return { ok: false, devices: [] };
        const here = devices.idOf(sender?.remote);
        if (message.op === 'rename') devices.rename(String(message.id ?? ''), message.name);
        else if (message.op === 'forget') devices.forget(String(message.id ?? ''));
        return { ok: true, here, devices: devices.list({ viewer: here }).map((device) => ({ ...device, notifies: !!push?.has(device.id) })) };
      }
      // His website's Settings: a sign-in link for another device, or his website on a Home Screen that asks. A code
      // that works for a day (web-gateway.js INSTALL_MS), never the key itself.
      case 'jester/web-link':
        return SERVER && webGateway ? { ok: true, code: webGateway.installToken() } : { ok: false };
      // On a server: a browser saying where it is, asked by device-location.js (web/shim.js answers).
      case 'jester/where-told':
        return { ok: !!sender?.remote && !!deviceLocate?.told(sender.remote, message) };
      case 'jester/research': {
        if (!url.startsWith('jester://app/home/')) return { ok: false };
        // The bar's Stop: what it shows (a search, or a briefing's reading), and nothing else at work.
        if (message.op === 'stop') {
          researchPresentation.stop();
          return { ok: true };
        }
        if (message.op === 'open') {
          const address = sourceAddress(message.url);
          if (!address) return { ok: false, error: 'That source is not a valid web address.' };
          try {
            await shell.openExternal(address.href);
            return { ok: true };
          } catch { return { ok: false, error: 'The source could not be opened.' }; }
        }
        return { ok: false };
      }
      // What he's offered to do: the list for its cards, and their click on Yes, Not now or No.
      case 'jester/offers': {
        if (!url.startsWith('jester://app/home/') || !offers?.ready) return { ok: false };
        const ids = (Array.isArray(message.ids) ? message.ids : []).map(String).filter(Boolean).slice(0, 3);
        if (message.op === 'yes' && ids.length) {
          const named = ids.map((id) => offers.get(id)).filter((offer) => offer && ['open', 'asked', 'later'].includes(offer.status));
          if (!named.length) return { ok: false, error: 'That’s already been answered.', offers: offers.list() };
          // Said aloud, as a briefing read from its card is: not waited for, it may take a while. Kept as theirs is a
          // plain yes: the offer's name holds a calendar's or a sender's words, which aren't the user's.
          void conversation.takeOffers(named.map((offer) => offer.id), named.length === 1 ? 'Yes, do that.' : 'Yes, do those.').catch((err) => log('offers: couldn’t do them:', err.message));
        } else if ((message.op === 'later' || message.op === 'no') && ids.length) {
          await offers.answer(ids, message.op);
          conversation.offersSettled(ids);
        }
        return { ok: true, offers: offers.list() };
      }
      case 'jester/briefings': {
        if (!url.startsWith('jester://app/home/') || !briefingManager?.ready) return { ok: false };
        try {
          const id = String(message.id || '');
          if (message.op === 'list') return { ok: true, cards: briefingManager.list().map((record) => briefingManager.card(record)) };
          if (message.op === 'open') return openBriefingItem({ manager: briefingManager, id, itemId: String(message.itemId || ''),
            openExternal: (address) => shell.openExternal(address),
            openMail: async (mailId) => {
              const who = google?.state().email;
              await shell.openExternal(`https://mail.google.com/mail/${who ? `?authuser=${encodeURIComponent(who)}` : ''}#inbox/${mailId}`);
            } });
          if (message.op === 'read') {
            const record = briefingManager.get(id);
            if (!record || record.status === 'reading' || briefingReadRequests.has(id)) return { ok: false, error: 'That briefing is already being read or is no longer available.' };
            briefingReadRequests.add(id);
            try {
              await conversation.readBriefing(id);
              return { ok: true, card: briefingManager.card(briefingManager.get(id)) };
            } finally { briefingReadRequests.delete(id); }
          }
          if (['later', 'dismiss'].includes(message.op)) {
            // Answered by a click: a "yes" said after it doesn't read it.
            conversation.briefingSettled(id);
            return respondToBriefing(id, message.op);
          }
          return { ok: false };
        } catch (error) { return { ok: false, error: error.message || 'That briefing could not be opened.' }; }
      }
      // Controls, a screen of his window. On a server, his website's: the Mac's scripts, through the Mac's link.
      case 'jester/scripts':
        if (!url.startsWith('jester://app/home/')) return { ok: false };
        if (SERVER) return remoteHands.scripts(message, devices.idOf(sender?.remote));
        if (!scripts) return { ok: false, why: 'Jester is still starting.' };
        return scriptsAsked(message);
      case 'jester/desktop-calibrate':
        showCalibration(pointerDisplay());
        return { ok: true };
      case 'jester/desktop-restart':
        restart();
        return { ok: true };
      case 'jester/desktop-state':
        researchPresentation.sync();
        return desktopState();
      case 'jester/desktop-permission':
        if (message.action === 'request') await requestPermission(String(message.id));
        else if (message.action === 'open-settings') openSettings(String(message.id));
        checkPermissions();
        return desktopState();
      // Settings' AI models. Keys go in; only masked ones come back out.
      case 'jester/desktop-connections':
        try {
          if (message.op === 'save') await assistant.connections.save(message.input || {});
          else if (message.op === 'remove') await assistant.connections.remove(String(message.id));
          else if (message.op === 'uses') await assistant.connections.uses(String(message.id), message.uses);
          return { ok: true, ...(await connectionsWithSpend()) };
        } catch (err) {
          return { ok: false, error: err.message, ...(await connectionsWithSpend()) };
        }
      // Settings' models: what Ollama has, and which one is this computer's.
      case 'jester/desktop-ollama':
        return { ...(await ollamaModels()), chosen: await chatModel() };
      case 'jester/desktop-voiceprint':
        if (message.op === 'teach') return { ok: !teachVoice(), error: voiceProblem() };
        if (message.op === 'cancel') await stopTeaching();
        else if (message.op === 'forget') await storage.local.remove(['voiceprint', 'voiceLearned']);
        await refresh();
        return { ok: true };
      case 'jester/desktop-forget':
        chatForgotten = true;
        for (const session of sessions.list()) session.conversation.forget();
        keeper.forgetAll();
        await briefingManager?.forgetAll();
        await offers?.forgetAll();
        return { ok: true };
      // His window's Tasks panel: the list, a task added by hand, one ticked off or put back, one removed.
      // Ticking off here is the user's own click: the only other way is their saying so (tasks.js).
      case 'jester/tasks': {
        if (message.op === 'add') tasks.add({ text: String(message.text ?? '').slice(0, 200) });
        else if (message.op === 'done') tasks.done(String(message.id ?? ''), message.on !== false);
        else if (message.op === 'remove') tasks.remove(String(message.id ?? ''));
        else if (message.op === 'snooze') tasks.snooze(String(message.id ?? ''), message.minutes);
        // A ringing timer's card: its Stop.
        else if (message.op === 'quiet') ring?.stop('a click');
        return { ok: true, count: tasks.count, ...tasks.list(), ringing: ring?.ringing || null };
      }
      // A note's card: opened in Obsidian, if it's one of the vault's; and the notes he's made or kept lately, for
      // the Tasks screen (the cards on his lines in the chat going on and those kept in Chats).
      case 'jester/notes': {
        if (message.op === 'open') {
          const rel = String(message.rel ?? '');
          const known = !!vault && vault.listNotes().some((note) => note.rel === rel);
          if (known) await shell.openExternal(vault.openUrl(rel));
          return { ok: known };
        }
        const cards = [currentChat(), ...keeper.list().map((chat) => keeper.get(chat.id)).filter(Boolean)]
          .flatMap((chat) => chat.lines.map((line) => ({ ...line.card, at: Date.parse(line.at) })))
          .filter((card) => (card.kind === 'note' || card.kind === 'remembered') && card.rel)
          .sort((a, b) => b.at - a.at);
        const seen = new Set();
        const notes = cards.filter((card) => !seen.has(card.rel) && seen.add(card.rel)).slice(0, 12);
        const there = new Set(vault ? vault.listNotes().map((note) => note.rel) : []);
        return { ok: true, notes: notes.filter((card) => there.has(card.rel)) };
      }
      // Getting started: what's left to set up, for his window's banner and its Getting started screen.
      case 'jester/setup':
        return { ok: true, ...(await setupState()) };
      // Settings › Email: the file from Google's console (chosen here, read here, never shown), signing in and out,
      // and a card's Open, which opens that conversation in Gmail.
      case 'jester/mail': {
        try {
          if (message.op === 'client') {
            // A server has no file picker: the file is the one JESTER_GOOGLE_CLIENT names.
            if (SERVER && !env.JESTER_GOOGLE_CLIENT) throw new Error('On the server, put Google’s file on it and name it in JESTER_GOOGLE_CLIENT (server/README.md).');
            const picked = SERVER
              ? { canceled: false, filePaths: [path.resolve(env.JESTER_GOOGLE_CLIENT)] }
              : await dialog.showOpenDialog({ title: 'Choose the file from Google', buttonLabel: 'Use this file', properties: ['openFile'], filters: [{ name: 'Google client', extensions: ['json'] }], defaultPath: app.getPath('downloads') });
            const file = picked.filePaths[0];
            if (picked.canceled || !file) return { ok: true, ...google.state() };
            if (fs.statSync(file).size > 100_000) throw new Error('That isn’t the file from Google: it’s far too big.');
            // Another client than before is another sign-in: nothing of the last one's mail is carried over.
            if (await google.setClient(fs.readFileSync(file, 'utf8'))) await mail.reset();
          } else if (message.op === 'connect') {
            // Gmail isn't looked at while this is finished: his place in the inbox is made before anything's read.
            mailBusy = true;
            try {
              const signed = await google.connect();
              if (signed.ok) {
                signInTold = false;
                await mail.reset();
                // The first look makes his mark in the inbox: from here on, what arrives is news.
                await mail.check().catch(() => undefined);
              }
              syncMail();
              return { ...signed, ...google.state() };
            } finally {
              mailBusy = false;
            }
          } else if (message.op === 'check') await checkMail();
          else if (message.op === 'cancel') google.cancel();
          else if (message.op === 'signout') {
            await google.signOut();
            await mail.reset();
          } else if (message.op === 'forget') {
            await google.forget();
            await mail.reset();
          } else if (message.op === 'open') {
            const id = String(message.id ?? '');
            const who = google.state().email;
            await shell.openExternal(`https://mail.google.com/mail/${who ? `?authuser=${encodeURIComponent(who)}` : ''}#inbox${/^[0-9a-f]{6,32}$/.test(id) ? `/${id}` : ''}`);
          }
          syncMail();
          return { ok: true, ...google.state() };
        } catch (err) {
          return { ok: false, error: err.message, ...google.state() };
        }
      }
      // Settings' "Your phone": the topic to subscribe to in the ntfy app, turning it on, and a test. The topic is
      // shown here and nowhere else: it's the key to what's sent.
      case 'jester/phone': {
        try {
          if (message.op === 'setup') await phone.setUp();
          else if (message.op === 'renew') await phone.renew();
          else if (message.op === 'on') await phone.setOn(message.on === true);
          else if (message.op === 'server') await phone.setServer(String(message.server ?? '').slice(0, 200));
          else if (message.op === 'test') {
            const { went } = await phone.send({ title: 'Jester', text: 'This is Jester, on your phone. What you’re due while you’re away from the computer comes here.', priority: 3 }, { anyway: true });
            return { ok: went, error: went ? '' : `It didn’t go: ${phone.state().last?.problem || 'no topic yet'}.`, ...phone.state() };
          }
          return { ok: true, ...phone.state() };
        } catch (err) {
          return { ok: false, error: err.message, ...phone.state() };
        }
      }
      // His clock, for his own window: what's on it, a line to tell them at a time, and taking one off.
      case 'jester/desktop-clock': {
        if (message.op === 'add') {
          const { inMs, at, payload } = message.job || {};
          const text = String(payload?.text ?? '').trim().slice(0, 600);
          const job = text ? clock.add({ kind: 'say', ...(Number.isFinite(at) ? { at } : { inMs: Number(inMs) }), payload: { text } }) : null;
          return { ok: !!job, id: job?.id || '' };
        }
        if (message.op === 'remove') return { ok: clock.remove(String(message.id ?? '')) };
        return { ok: true, where: presence.where, jobs: clock.list().map(({ id, kind, due, held, payload }) => ({ id, kind, due: Number.isFinite(due) ? due : null, held: !!held, text: String(payload?.text ?? '') })) };
      }
      // Settings' Memory section: the vault is only ever chosen, and so first read, from here.
      case 'jester/desktop-memory': {
        let imported;
        if (message.op === 'import' && vault) imported = await importChatsChosen();
        // Learning from them runs on after this answers: Settings hears how it's going as the state is posted.
        else if (message.op === 'learn' && vault) chatLearner.start().then(() => refreshVault());
        else if (message.op === 'learn-stop') chatLearner.stop();
        else if (message.op === 'choose' && SERVER) {
          // A server has no folder picker: its vault is the one JESTER_VAULT names, synced from the Mac.
          if (env.JESTER_VAULT) await saveSettings({ memoryVault: vaultRootIn(path.resolve(env.JESTER_VAULT)) || path.resolve(env.JESTER_VAULT) });
          settings = await loadSettings();
        } else if (message.op === 'choose') {
          const picked = await dialog.showOpenDialog({
            title: 'Choose your Obsidian vault',
            properties: ['openDirectory'],
            defaultPath: settings?.memoryVault || obsidianVaults()[0]?.path || app.getPath('documents')
          });
          // The folder above a vault is kept as that vault: just chosen, it's Jester's to look inside.
          const folder = picked.filePaths[0];
          if (!picked.canceled && folder) await saveSettings({ memoryVault: vaultRootIn(folder) || folder });
        } else if (message.op === 'use') {
          const found = obsidianVaults().find((item) => item.path === message.path);
          if (found) await saveSettings({ memoryVault: found.path });
        } else if (message.op === 'remove') await stopUsingVault();
        else if (message.op === 'open' && vault) await shell.openExternal(`obsidian://open?vault=${encodeURIComponent(vault.name)}`);
        else if (message.op === 'about' && vault) await shell.openExternal(vault.openUrl(PATHS.aboutMe));
        else if (message.op === 'privacy') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
        else if (message.op === 'reindex') refreshVault({ retry: true });
        await refresh();
        // The imported chats are counted when the Memory page opens and after an import: it reads every one's properties.
        if (vault && !chatLearner.status().running && (message.op === 'known' || imported || !chatLearner.counted())) chatLearner.count();
        // How much he knows, counted only when Settings asks: it walks the vault.
        return { ...desktopState(), memory: { ...memoryState(), known: knownCounts() }, ...(imported ? { imported } : {}) };
      }
      // Settings' Weather and calendars. A calendar's link goes in and never comes back out.
      case 'jester/desktop-day':
        try {
          if (message.op === 'source' && ['off', 'here', 'place'].includes(message.source)) {
            await saveDay({ locationSource: message.source });
            // Chosen here, on purpose: macOS's question comes now, with the user looking, and is waited for.
            if (message.source === 'here') whereabouts.locate({ patient: true }).then(() => noteWeather());
          } else if (message.op === 'place') {
            const place = await weather.findPlace(String(message.text ?? '').slice(0, 120));
            if (!place) return { ok: false, error: `Couldn’t find “${String(message.text ?? '').trim()}”. Try the town and its state or country, like “Springfield, IL”.`, ...desktopState() };
            await saveDay({ locationSource: 'place', locationPlace: place });
            await noteWeather();
          } else if (message.op === 'locate') {
            await whereabouts.locate({ patient: true });
            await noteWeather();
          } else if (message.op === 'units' && ['auto', 'fahrenheit', 'celsius'].includes(message.units)) {
            await saveDay({ weatherUnits: message.units });
            await noteWeather();
          } else if (message.op === 'privacy') {
            await shell.openExternal(process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices' : 'ms-settings:privacy-location');
          } else if (message.op === 'calendar-add') {
            await calendars.add({ url: String(message.url ?? '').slice(0, 4000), name: String(message.name ?? '') });
          } else if (message.op === 'calendar-remove') await calendars.remove(String(message.id));
          else if (message.op === 'calendar-rename') await calendars.rename(String(message.id), String(message.name ?? ''));
          else if (message.op === 'calendar-refresh') await calendars.refresh();
          return { ok: true, ...desktopState() };
        } catch (err) {
          return { ok: false, error: err.message, ...desktopState() };
        }
      // His window. A sentence typed is a command given on purpose, and he writes back.
      case 'jester/talk-type':
        presence?.seen('typed');
        // In the cloud, typed here is said to him there; his answer's in his window, which is the server's.
        if (cloudTarget) {
          showTalk();
          return cloudLink?.told(String(message.text).slice(0, TYPED_MAX)) ? { ok: true } : { ok: false, error: 'Jester’s server isn’t reachable right now.' };
        }
        sessionOf(sender).conversation.told(String(message.text).slice(0, TYPED_MAX), { typed: true });
        return { ok: true };
      // On a server: the address Google's sign-in landed on, pasted in a browser (web/shim.js), taken to his own port.
      case 'jester/sign-in-return':
        return SERVER ? signInReturned(String(message.url || '')) : undefined;
      // Settings › Jester in the cloud: his server's link saved (checked first), or forgotten. Either restarts him.
      case 'jester/desktop-cloud': {
        if (SERVER) return { ok: false, error: 'This is the server.' };
        if (message.op === 'off') {
          await storage.local.remove('cloudBrain');
          setTimeout(restart, 300);
          return { ok: true };
        }
        // With the server's address and the password set on his website (the user, 2026-11-19: "I need a better easier
        // way to signin"): the server answers with the key, which is kept as the link was. No link to find or paste.
        if (message.op === 'sign-in') {
          try {
            const key = await cloudKeyFor(message.server || cloudTarget?.origin, String(message.password ?? ''));
            const origin = serverOrigin(message.server || cloudTarget?.origin);
            if (cloudTarget && cloudTarget.origin === origin) await adoptCloudKey(key);
            else {
              await storage.local.set({ cloudBrain: { link: `${origin}/?key=${encodeURIComponent(key)}` } });
              setTimeout(restart, 300);
            }
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }
        const target = parseCloudLink(message.link);
        if (!target) return { ok: false, error: 'That isn’t the link his server printed: it starts with https:// and ends with ?key=…' };
        const reached = await fetch(target.page, { redirect: 'manual', signal: AbortSignal.timeout(8000) }).then((response) => response.status, (err) => err.message);
        if (reached !== 303) return { ok: false, error: reached === 401 ? 'The server says that key isn’t its own.' : `Couldn’t reach the server (${reached}). Is Tailscale on, on this Mac?` };
        await storage.local.set({ cloudBrain: { link: String(message.link).trim() } });
        setTimeout(restart, 300);
        return { ok: true };
      }
      // Typing to him: his model loads meanwhile, rather than after they press Return. Only this computer's needs it.
      case 'jester/talk-typing':
        talking.savedOnes().then(async (saved) => !saved.length && warmOllama({ model: (await talking.localOne())?.model }));
        warmUp();
        return { ok: true };
      case 'jester/talk-listen':
        await saveSettings({ continuousAssistant: message.on === true });
        return { ok: true };
      // His window's Chats: what's over, for a week. One opened again is carried on.
      case 'jester/chats': {
        const id = String(message.id ?? '');
        if (message.op === 'list') return { chats: keeper.list() };
        if (message.op === 'get') return { chat: keeper.get(id) };
        if (message.op === 'current') return { chat: currentChat(SERVER && sender?.remote ? viewingOf(sender.remote) : 'local'), ...(SERVER && sender?.remote ? otherChats(sender.remote) : {}) };
        if (message.op === 'resume') return resumeChat(id, message.text, sessionOf(sender));
        // On a server: another device's chat, looked at from this one (and typed into); '' goes back to its own.
        if (message.op === 'view' && SERVER && sender?.remote) {
          const key = String(message.key ?? '');
          sender.remote.viewing = key && sessions.has(key) ? key : '';
          showOtherChats();
          return { ok: true, chat: currentChat(viewingOf(sender.remote)), ...otherChats(sender.remote) };
        }
        // Deleted, it's forgotten: he isn't told of it again either.
        if (message.op === 'remove') return { ok: keeper.remove(id) };
        return { ok: false };
      }
      // What his window shows: the conversation's frames go to it alone while that's the orb. And whether it's on
      // screen yet, for the orb's intro: shown before its page had loaded, it missed jester/home-shown.
      case 'jester/home-screen':
        // On a server: which of his screens a device is showing (devices.js).
        if (SERVER) {
          devices.seen(sender?.remote, { screen: String(message.screen ?? '') });
          return { ok: true, shown: true };
        }
        noteHomeScreen(message.screen);
        researchPresentation.sync();
        return { ok: true, shown: !!homeWindow()?.isVisible() };
      // His window's Sleep and Wake.
      case 'jester/desktop-sleep':
        sleep(message.on === true);
        return { ok: true };
      // Settings' voice row: a line in the voice chosen, for the page to play. Never through the speakers he listens by.
      case 'jester/desktop-voice':
        try {
          const made = await kokoro?.sound('Hello. I’m Jester, and this is how I sound.');
          if (!made) return { ok: false, error: kokoro?.state === 'missing' ? 'His voice isn’t downloaded yet.' : 'His voice isn’t starting just now.' };
          return { ok: true, type: made.type, base64: Buffer.from(made.bytes).toString('base64') };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      // Settings' Apple Watch section: pairing is only ever started from here.
      case 'jester/desktop-watch':
        if (watch && ['pair', 'confirm', 'cancel', 'forget'].includes(message.op)) await watch[message.op]();
        return desktopState();
      // Settings' camera view: the engine draws one while someone asks, and
      // only takes asking from Jester's own (worker's) messages.
      case 'jester/desktop-preview':
        post({ type: MSG.PREVIEW_PING });
        return { ok: true };
      // The assistant's question window: Allow / Don't.
      case 'jester/approval-answer':
        assistant.answer(message.approved === true);
        return { ok: true };
      // The × beside the pill, and where the pill is for it to sit beside.
      // The Stop on a ringing timer's pill.
      case 'jester/ring':
        ring?.stop('a click');
        return { ok: true };
      case 'jester/stop':
        stopButton.clicked(String(message.op));
        return { ok: true };
      case 'jester/pill':
        stopButton.anchor(overlays.toScreen(message.display, message.end));
        return { ok: true };
      default:
        return undefined;
    }
  });
}

/**
 * JESTER_SELFTEST: open Settings without focus and check its two-way path to
 * the engine — what the page shows, and that its "Jester on" switch stops and
 * restarts the engine. JESTER_CAPTURE adds a picture of Settings, and of some
 * of its pages and the orb's screen beside it.
 */
function selfTest(capture) {
  const win = showSettings({ quiet: true });
  const page = (code) => win.webContents.executeJavaScript(code);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shows = () => page(`['status-text', 'camera-stats', 'last-gesture'].map((id) => document.getElementById(id).textContent).join(' | ')`);
  /** Waits for the engine to reach a state, and for the page's camera line to catch up. */
  const reach = async (state, ms = 8000) => {
    for (const until = Date.now() + ms; Date.now() < until; await pause(100)) {
      if (engine.state === state && (state !== 'running' || /fps/.test(await shows()))) return true;
    }
    return false;
  };
  /** One of the window's screens, at once (home/screens.js). */
  const go = (screen) => page(`window.jesterHome.go(${JSON.stringify(screen)}, { instant: true })`);
  win.webContents.once('did-finish-load', async () => {
    if (capture) {
      await pause(1500);
      fs.writeFileSync(capture, (await win.webContents.capturePage()).toPNG());
      log('selftest: captured', capture);
      // Some of its pages, and the orb's screen beside it.
      for (const screen of ['settings/permissions', 'settings/general', 'settings/models', 'settings/gestures', 'main']) {
        await go(screen);
        await pause(400);
        const file = capture.replace(/\.png$/, `-${screen.replace('/', '-')}.png`);
        fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        log('selftest: captured', file);
      }
      await go('settings');
    }
    await reach('running');
    log('selftest: settings shows', await shows());
    // The camera view is drawn only while its page is showing.
    await go('settings/activity');
    await pause(1500);
    log('selftest: camera view —', await page(`(() => { const img = document.getElementById('camera-preview'); return img.hidden ? 'not shown' : img.naturalWidth + '×' + img.naturalHeight; })()`));
    log('selftest: voice row —', await page(`(() => { const box = document.getElementById('voiceEnabled'); return (box.checked ? '☑ ' : '☐ ') + (box.disabled ? '(disabled) ' : '') + document.getElementById('voice-hint').textContent; })()`));
    log('selftest: speech model row —', await page(`(() => { const select = document.getElementById('speechModel'); return [...select.options].map((o) => (o.selected ? '▸' : '') + o.text + (o.disabled ? ' [off]' : '')).join(' | ') + ' — ' + document.getElementById('speech-model-hint').textContent; })()`));
    log('selftest: his voice row —', await page(`(async () => { const select = document.getElementById('jesterVoice'); const reply = await chrome.runtime.sendMessage({ type: 'jester/desktop-voice', op: 'hear' }); return (select.hidden ? '(no picker) ' : [...select.options].map((o) => (o.selected ? '▸' : '') + o.text).join(' | ') + ' — ') + document.getElementById('jester-voice-hint').textContent + ' — a line in it: ' + (reply?.ok ? reply.type + ', ' + Math.round(reply.base64.length * 0.75 / 1024) + ' KB' : reply?.error); })()`));
    // The assistant's models: listed, and a model saved without a key refused
    // before anything is stored (so no keychain is touched).
    log('selftest: assistant models —', await page(`document.getElementById('connections').textContent.replace(/\\s+/g, ' ').trim()`));
    await page(`document.getElementById('connection-model').value = 'gemini-2.5-flash'; document.getElementById('connection-key').value = ''; document.getElementById('connection-form').requestSubmit();`);
    await pause(500);
    log('selftest: a model without a key —', await page(`document.getElementById('connection-error').textContent`));
    await page(`document.getElementById('enabled').click()`);
    log('selftest: switched off —', (await reach('off')) ? 'engine off' : `engine still ${engine.state}`, '|', await shows());
    await page(`document.getElementById('enabled').click()`);
    log('selftest: switched on —', (await reach('running')) ? 'engine running' : `engine still ${engine.state}`, '|', await shows());
    // Gestures off closes the camera and leaves voice as it was.
    const voiceBefore = voiceProblem({ mic: false });
    await onTrayAction('gestures', false);
    log('selftest: gestures off —', (await reach('off')) ? `engine off (${engine.detail})` : `engine still ${engine.state}`, '| voice:', voiceProblem({ mic: false }) === voiceBefore ? 'unchanged' : voiceProblem({ mic: false }), '|', await shows());
    await onTrayAction('gestures', true);
    log('selftest: gestures on —', (await reach('running')) ? 'engine running' : `engine still ${engine.state}`, '|', await shows());

    // Gestures' actions, as far as the driver — and only a dry-run driver,
    // which describes input instead of sending it: never press real keys here.
    if (!env.JESTER_DRIVER_DRY) return log('selftest: skipping actions (set JESTER_DRIVER_DRY=1)');

    // The assistant, on this app's own Settings window only (never the
    // user's screen): what it reads there, then a whole run with a scripted
    // model, whose click the dry-run driver describes instead of doing.
    // What the assistant reads of the window is what's on screen: the page with Cursor control.
    if (env.JESTER_SELFTEST_AGENT) {
      await go('settings/general');
      await pause(500);
      await selfTestAgent();
    }
    if (env.JESTER_SELFTEST_APP) await selfTestApp(env.JESTER_SELFTEST_APP);

    for (const [action, gesture] of [['VOLUME_UP', 'Thumb_Up'], ['APP_NEXT', 'Victory'], ['SPEED_UP', 'ILoveYou']]) {
      log('selftest: dispatch', action, '→', JSON.stringify(await dispatch(action, { source: 'pose', gesture })));
    }
    const overlay = overlays.activeWindow();
    if (capture && overlay) {
      await dispatch('VOLUME_UP', { source: 'pose', gesture: 'Thumb_Up' });
      await pause(400);
      const file = capture.replace(/\.png$/, '-overlay.png');
      fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
      log('selftest: captured', file);
      // The assistant at work on the pill: its caption over the step it's on, then between steps.
      for (const [name, voice] of [['assistant', { phase: 'thinking', task: 'Playing Gunna on Spotify', step: 'Click “Play Gunna”' }], ['assistant-caption', { phase: 'thinking', task: 'Texting Trisha hello', step: '' }]]) {
        post({ type: MSG.VOICE, voice });
        await pause(400);
        const face = capture.replace(/\.png$/, `-${name}.png`);
        fs.writeFileSync(face, (await overlay.webContents.capturePage()).toPNG());
        log('selftest: captured', face);
      }
      post({ type: MSG.VOICE, voice: { phase: 'thinking' } });
      post({ type: MSG.VOICE, voice: { active: false } });
    }

    // The assistant's question window: shown, and a click on Allow (sent to
    // the page, not the OS) reaching the assistant.
    const question = createApprovalPrompt();
    question.show('Type “hello” in “Message”, then Enter?');
    await pause(1500);
    const asking = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('jester://app/overlay/approval.html'));
    if (!asking) log('selftest: question window — not shown');
    else {
      if (capture) {
        const file = capture.replace(/\.png$/, '-question.png');
        fs.writeFileSync(file, (await asking.webContents.capturePage()).toPNG());
        log('selftest: captured', file);
      }
      const answered = new Promise((resolve) => {
        const answer = assistant.answer;
        assistant.answer = (approved) => resolve(approved);
        setTimeout(() => resolve('no answer'), 2000);
        setTimeout(() => (assistant.answer = answer), 2100);
      });
      const at = await asking.webContents.executeJavaScript(`(() => { const box = document.getElementById('allow').getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; })()`);
      asking.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      asking.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      log('selftest: question window — Allow clicked, the assistant heard:', JSON.stringify(await answered), `· can become the active app: ${asking.isFocusable()}`);
    }
    question.hide();

    // The × beside the pill: its question on a click, No going back, and Yes
    // reaching whoever stops the task, all without Jester becoming the active
    // app. As above, clicks go to the page, not the OS.
    let stops = 0;
    const stop = createStopButton({ onStop: () => (stops += 1) });
    stop.show();
    await pause(1500);
    const stopWindow = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith('jester://app/overlay/stop.html'));
    if (!stopWindow) log('selftest: stop button — not shown');
    else {
      const pressStop = async (id) => {
        const at = await stopWindow.webContents.executeJavaScript(`(() => { const box = document.getElementById('${id}').getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; })()`);
        stopWindow.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        stopWindow.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await pause(400);
      };
      // The real button's clicks reach the main process's: this one listens in.
      const clicked = stopButton.clicked;
      stopButton.clicked = stop.clicked;
      const width = () => stopWindow.getBounds().width;
      const small = width();
      await pressStop('stop');
      const asked = width();
      if (capture) {
        const file = capture.replace(/\.png$/, '-stop.png');
        fs.writeFileSync(file, (await stopWindow.webContents.capturePage()).toPNG());
        log('selftest: captured', file);
      }
      await pressStop('no');
      const back = width();
      const activates = stopWindow.isFocusable();
      await pressStop('stop');
      await pressStop('yes');
      stopButton.clicked = clicked;
      log(`selftest: stop button — ${small} px, asking ${asked} px, No ${back} px, Yes stopped ${stops} time(s), gone: ${stopWindow.isDestroyed()} · can become the active app: ${activates}`);
    }
    stop.hide();

    // The cursor: frames as the engine sends them, a dry-run driver taking
    // the input, every call to it recorded.
    const bounds = pointerDisplay().bounds;
    const frame = (x, y, extra = {}) =>
      pointer.frame({ active: true, x, y, progress: 0, down: false, click: false, mode: 'head', errorPx: 40, display: { w: bounds.width, h: bounds.height }, ...extra });
    pointerCalls.length = 0;
    for (let i = 0; i < 12; i++) {
      frame(0.3, 0.4);
      await pause(50);
    }
    const moves = pointerCalls.filter(([cmd]) => cmd === 'move');
    log('selftest: cursor', moves.length, 'moves, ending at', JSON.stringify(moves.at(-1)?.[1]), `(aimed at ${Math.round(bounds.x + 0.3 * bounds.width)},${Math.round(bounds.y + 0.4 * bounds.height)})`);
    if (capture && overlay) {
      frame(0.3, 0.4, { progress: 0.5 });
      await pause(200);
      const file = capture.replace(/\.png$/, '-cursor.png');
      fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
      log('selftest: captured', file);
    }
    // Closing the hand freezes the aim; the click lands there, not where the eyes drifted.
    frame(0.3, 0.4, { progress: 0.6 });
    await pause(60);
    frame(0.36, 0.4, { progress: 1, click: true });
    await pause(1500);
    const clicked = pointerCalls.filter(([cmd]) => cmd === 'click').at(-1)?.[1];
    log('selftest: clicked at', JSON.stringify(clicked), `after ${pointerCalls.filter(([cmd]) => cmd === 'elementAt').length} aim-assist lookups`);
    pointer.frame({ active: false });

    // Voice: the fake mic plays JESTER_FAKE_AUDIO once, and the command in
    // it is heard, matched and done — by the dry-run driver.
    if (env.JESTER_SELFTEST_VOICE) {
      for (const until = Date.now() + 20000; voiceState() !== 'ready' && Date.now() < until; ) await pause(200);
      log('selftest: voice', voiceState(), '·', voiceProblem() || 'can listen');
      const heard = new Promise((resolve) => (voiceHeard = resolve));
      const started = Date.now();
      toggleVoice();
      if (capture && overlay) {
        await pause(1600);
        const file = capture.replace(/\.png$/, '-voice.png');
        fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
        log('selftest: captured', file);
      }
      const result = await Promise.race([heard, pause(20000).then(() => null)]);
      log('selftest: voice heard', JSON.stringify(result?.text ?? null), '→', JSON.stringify(result?.outcome ?? null), `after ${Date.now() - started} ms`);
      if (capture && overlay && result) {
        await pause(300);
        const file = capture.replace(/\.png$/, '-voice-answer.png');
        fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
        log('selftest: captured', file);
      }
      // Where the pill is on the screen itself, against the area apps may use.
      if (overlay && result) {
        const fit = await overlay.webContents.executeJavaScript(
          `(() => { const pill = document.getElementById('voice').getBoundingClientRect(); return { pillBottom: Math.round(window.screenY + pill.bottom), usableBottom: screen.availTop + screen.availHeight, screenBottom: screen.height, windowTop: window.screenY }; })()`
        );
        log('selftest: voice pill', JSON.stringify(fit));
      }
    }

    // The extension's calibration screen, unchanged: its checklist is fed by
    // the engine, so it shows whether the two are talking.
    const calibrationWindow = showCalibration(pointerDisplay(), { quiet: true });
    calibrationWindow.webContents.on('console-message', ({ level, message }) => level === 'error' && log('selftest: calibration error:', message));
    await new Promise((resolve) => calibrationWindow.webContents.once('did-finish-load', resolve));
    await pause(4000);
    const checklist = await calibrationWindow.webContents.executeJavaScript(
      `[...document.querySelectorAll('.check')].map((p) => p.textContent.trim() + (p.className.includes('ok') ? ' ✓' : p.className.includes('bad') ? ' ✗' : ' …')).join(', ') + ' — ' + document.getElementById('readout').textContent`
    );
    log('selftest: calibration page —', checklist);
    // Start, as a real click would (a user gesture), then what the page did.
    // Opt-in: a run takes over the whole screen for a moment.
    if (env.JESTER_SELFTEST_CALIBRATE) {
      await calibrationWindow.webContents.executeJavaScript(`document.getElementById('startBtn').click()`, true);
      await pause(2500);
      const after = await calibrationWindow.webContents.executeJavaScript(
        `JSON.stringify({ fullscreen: !!document.fullscreenElement, intro: !document.getElementById('intro').hidden, field: !document.getElementById('field').hidden, hint: document.getElementById('preflightHint').textContent })`
      );
      log('selftest: calibration after Start —', after, `· window full screen ${calibrationWindow.isFullScreen()}, simple ${calibrationWindow.isSimpleFullScreen?.()}`);
      // The page closing itself, as Done does after leaving full screen: the
      // request reaches the main process, which closes the window. (Whether
      // full screen itself goes smoothly needs a focused window: macOS won't
      // put an inactive one in full screen, so this test can't tell.)
      const closed = new Promise((resolve) => calibrationWindow.once('closed', () => resolve(true)));
      await calibrationWindow.webContents.executeJavaScript('window.close()', true).catch(() => undefined);
      const gone = await Promise.race([closed, pause(4000).then(() => false)]);
      log('selftest: calibration after Done —', gone ? 'window closed' : `window still open (full screen: ${calibrationWindow.isFullScreen()})`);
      if (gone) return;
    }
    calibrationWindow.close();
  });
}

/**
 * JESTER_SELFTEST_APP=name: what the assistant would see of that app's window
 * (its controls, so the user's own content: only on request). JESTER_SELFTEST_GOAL
 * ranks them as a command would.
 */
async function selfTestApp(name) {
  const { apps = [] } = await driver.call('apps').catch(() => ({}));
  const target = apps.find((app) => app.name?.toLowerCase() === name.toLowerCase());
  if (!target) return log('selftest: not running —', name);
  const seen = await driver.call('snapshot', { pid: target.pid }).catch((err) => ({ error: err.message }));
  if (seen.error) return log(`selftest: ${name} —`, seen.error);
  log(`selftest: ${name} — ${seen.elements.length} controls, ${seen.visits} looked at, in ${seen.ms} ms:\n${screenText(seen, { goal: env.JESTER_SELFTEST_GOAL || '', chars: 4000 })}`);
}

/** JESTER_SELFTEST_AGENT: see selfTest. Reads only Jester's own windows. */
async function selfTestAgent() {
  const goal = 'turn off cursor control';
  // The first read of a Chromium window waits while its page's tree is built.
  const own = await driver.call('snapshot', { pid: process.pid }).catch((err) => ({ error: err.message }));
  if (own.error) return log('selftest: snapshot —', own.error);
  log(`selftest: snapshot of Jester's ${JSON.stringify(own.window?.title)} — ${own.elements.length} elements in ${own.ms} ms${own.truncated ? ', truncated' : ''}:\n${screenText(own, { goal, chars: 1400 })}`);
  const calls = [];
  const watched = { call: async (cmd, params) => (calls.push(cmd === 'act' ? `act ${params.action} ${params.element}` : cmd), driver.call(cmd, params)) };
  const host = createDesktopHost({ driver: watched, openApp: async () => ({ ok: false, text: 'not in a self-test' }), openUrl: async () => undefined, dispatch, pid: process.pid });
  // A model that reads the screen it's given, as a real one would.
  const model = async ({ prompt }) => {
    const { screen, lastResult } = JSON.parse(prompt);
    if (lastResult) return { json: { action: { action: 'finish', say: 'Cursor control is off.', success: lastResult.ok } } };
    const line = screen.split('\n').find((text) => /^\[\d+\] (?:checkbox|switch) "Cursor control/.test(text));
    return { json: { action: line ? { action: 'click', id: Number(line.match(/^\[(\d+)\]/)[1]) } : { action: 'finish', say: 'No such switch.', success: false } } };
  };
  const result = await runDesktopAgent({ goal, host, model, confirm: async () => false, platform: process.platform });
  log('selftest: assistant —', JSON.stringify(result), '· driver:', calls.join(', '));
}

/** On a server: the last time anything was done in a browser with his window open (presence's idle seconds). */
let webActiveAt = Date.now();
let webGateway = null;
/** On a server: where the device being used is (device-location.js), for whereabouts. */
let deviceLocate = null;
/** This computer's own position (mac-location.js, or locateByPage): his, and the server's when asked through the link. */
let locateHere = null;
/** On a server: the Mac's hands, when it's connected (remote-hands.js). */
let remoteHands = null;
/** On a Mac using him in the cloud: the server's link ("https://…/?key=…", parsed), and the line to it (cloud-link.js). */
let cloudTarget = null;
let cloudLink = null;
/** What the Mac can do, for the server's conversation: worked out every few seconds, as some of it is asked of a model. */
let macAbilities = { computer: 'Mac' };

/** A sign-in's page, opened on a server: where's open is the browsers with his window, which ask for the address it lands on. */
let signInPage = null;
function openInBrowser(url) {
  signInPage = url;
  postRemote({ type: 'jester/open-url', url, landing: true });
}

/**
 * Google sends the browser back to http://127.0.0.1:<port>/?state=…&code=…, which on a phone or laptop is nothing:
 * the port is the server's. The user pastes that address, and it's taken to the port here. Only that one: the port
 * the sign-in opened, its root, with the sign-in's own state, so a page can't use this to reach anything else here.
 */
async function signInReturned(pasted) {
  const local = landingAddress(pasted, signInPage);
  if (!local) return { ok: false, error: 'That isn’t the address this sign-in ended on. Copy it from the address bar of the tab Google left you on.' };
  const status = await fetch(local, { redirect: 'error', signal: AbortSignal.timeout(5000) }).then((response) => response.status, () => 0);
  if (status !== 200) return { ok: false, error: 'That sign-in is over. Start it again from Settings › Email.' };
  signInPage = null;
  return { ok: true };
}

/** The key his website asks for: JESTER_WEB_KEY, or one made on first run and kept in the data folder. */
function webKey() {
  if (env.JESTER_WEB_KEY) return env.JESTER_WEB_KEY;
  const file = path.join(app.getPath('userData'), 'web-key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const key = makeKey();
    fs.writeFileSync(file, key, { mode: 0o600 });
    return key;
  }
}

/**
 * A Mac linking for the first time sent its Jester (move-in.js): kept as this server's own, and started again with
 * it, since tasks, reminders and the models are read at the start (the service starts him again by itself).
 */
async function movedIn(client, frame) {
  let result;
  try {
    result = await applyMove(frame.move, { storage: storage.local, dataDir: app.getPath('userData'), from: client.device?.name });
  } catch (err) {
    result = { ok: false, why: err.message };
  }
  log(result.ok ? `move: a Mac’s Jester moved in (${result.moved.length} things)` : `move: not taken: ${result.why}`);
  client.send({ t: 'moved-in', ok: result.ok, already: result.already === true, why: result.why || '' });
  // At once: nothing here writes its own tasks or reminders over the ones just moved in.
  if (result.ok && !env.JESTER_NO_RESTART) setTimeout(() => app.exit(0), 150);
}

/**
 * JESTER_SERVER: his window as a website (web-gateway.js). Its pages are his own window's, their messages answered
 * as that window's are, and the browser last clicked in is his ears and mouth.
 */
function startWebGateway() {
  const key = webKey();
  devices = createDevices({ storage: storage.local, computers: () => remoteHands?.list() || [], voiceClient: () => webGateway?.voiceClient || null, onChange: devicesChanged, log });
  devices.start().catch((err) => log('devices: couldn’t be read:', err.message));
  webLogin = createWebLogin({ storage: storage.local, log });
  webLogin.start().catch((err) => log('sign-in: the password couldn’t be read:', err.message));
  remoteHands = createRemoteHands({
    // A computer's task has a question: asked in the chat that started it, aloud or written, and answered there.
    onAsk: (label, chat) => sessions?.get(chat && chat !== 'local' ? chat : sessions.frontKey).conversation.ask(label),
    // Typed in a computer's own window: said to him in that computer's chat.
    onTold: (text, computer) => {
      webActiveAt = Date.now();
      sessions?.used(computer?.id || 'local').conversation.told(text, { typed: true });
    },
    // A task begun on a computer itself is the chat in front's.
    adopt: () => sessions?.frontKey || 'local',
    onChange: () => (post(desktopState()), devicesChanged()),
    // The Mac's scripts changed, or the Mac came or went: Controls, on his website, reads them again.
    onScriptsChanged: (change) => post({ type: 'jester/scripts-changed', ...change }),
    log
  });
  webGateway = createWebGateway({
    key,
    login: webLogin,
    port: Number(env.JESTER_WEB_PORT) || 8770,
    log,
    onConnect: (client) => {
      // Which of the user's devices it is, for where he's open and whose chat is whose (devices.js).
      devices.join(client);
      // A computer is his hands (and maybe his ears); a browser is his window.
      if (client.role === 'mac') return remoteHands.join(client);
      webActiveAt = Date.now();
      client.leave ||= addRemotePage(client);
      return undefined;
    },
    onClose: (client) => {
      client.leave?.();
      remoteHands.leave(client);
      deviceLocate?.gone(client);
      devices.leave(client);
    },
    onSeen: (client, seen) => devices.seen(client, seen),
    onOther: (client, frame) => (frame?.t === 'move-in' && client.role === 'mac' ? void movedIn(client, frame) : remoteHands.frame(client, frame)),
    onMessage: (client, message) => {
      webActiveAt = Date.now();
      // The page last heard from is the device in use, when none has been talked through (device-location.js).
      client.activeAt = webActiveAt;
      return fromRemote(client, message);
    },
    onStorage: (area, op, arg) => remoteStorage(area, op, arg),
    onAudio: (samples) => speech?.feed(samples),
    onVoiceStatus: (report) => voicePage?.status?.(report),
    onVoiceClient: () => {
      webActiveAt = Date.now();
      presence?.seen('typed');
    }
  });
  // Where the user is: where the device they're using is, its browser's or the Mac's.
  deviceLocate = createDeviceLocate({ gateway: webGateway, hands: remoteHands, log });
  // The key itself never goes to the log (it reaches the journal): setup.sh prints the link once, from its file.
  webGateway.ready.then(
    (port) => console.log(`Jester's window: listening on 127.0.0.1:${port}; its link, with the key, is in ${path.join(app.getPath('userData'), 'web-key')}`),
    (err) => console.error('Jester’s window couldn’t start:', err.message)
  );
}

/**
 * The first time this Mac links to a server, its Jester is sent there (move-in.js): keys, tasks, reminders, chats,
 * calendars, taught phrases, voiceprint and settings. Once per server: what's there afterwards is the one that counts.
 */
async function moveIn() {
  if ((await storage.local.get('cloudMoved')).cloudMoved === cloudTarget.origin) return;
  const move = await collectMove({ storage: storage.local, dataDir: app.getPath('userData') });
  if (cloudLink.send({ t: 'move-in', move })) log('cloud: sending this Mac’s Jester to the server, the first time it links');
}

/**
 * A new key for the server this Mac is linked to (signed in again, here or in his window): kept, and used at once,
 * with no restart.
 */
async function adoptCloudKey(key) {
  if (!cloudTarget || !key || key === cloudTarget.key) return false;
  const link = `${cloudTarget.origin}/?key=${encodeURIComponent(key)}`;
  const next = parseCloudLink(link);
  if (!next) return false;
  await storage.local.set({ cloudBrain: { link } });
  cloudTarget = next;
  setCloudPage(next.page, { onFocus: () => cloudLink?.claim() });
  cloudLink?.use(next);
  log('cloud: signed in again: this Mac’s key is the new one');
  post(desktopState());
  return true;
}

/**
 * His window here is his server's website, and signing in there (with the password) gives that window the key as a
 * cookie: this Mac's own line to the server takes the same key, so signing in once mends both.
 */
function watchCloudSignIn() {
  const mine = (cookie) => cookie?.name === 'jester_key' && cloudTarget && String(cookie.domain || '').replace(/^\./, '') === new URL(cloudTarget.origin).hostname;
  session.defaultSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (!removed && mine(cookie)) adoptCloudKey(decodeURIComponent(cookie.value)).catch(() => undefined);
  });
}

/** The server turned this Mac's key away: the key his window signed in with, if it has one; else his window, to sign in. */
async function cloudRefused() {
  post(desktopState());
  const cookies = await session.defaultSession.cookies.get({ url: cloudTarget.origin, name: 'jester_key' }).catch(() => []);
  const key = cookies[0] ? decodeURIComponent(cookies[0].value) : '';
  if (key && key !== cloudTarget.key && (await adoptCloudKey(key))) return;
  overlays.toast('Jester needs you to sign in again', { detail: 'Type your password in his window', tone: 'warn' });
  showHome({ screen: 'main' });
}

let thisDevice = null;
/** This computer, as his server knows it: an id made once and kept, and the name the user gave the computer. */
async function deviceIdentity() {
  let id = (await storage.local.get('deviceId')).deviceId;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id || ''))) {
    id = randomUUID();
    await storage.local.set({ deviceId: id });
  }
  let name = '';
  try {
    if (process.platform === 'darwin') name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    /* its host name will do */
  }
  name ||= os.hostname().replace(/\.local$/, '').replace(/-/g, ' ');
  return { id, name: name.slice(0, 40) };
}

/**
 * "Use Jester in the cloud": this Mac is the hands, eyes and ears of his brain on a server (cloud-link.js). His window
 * is the server's website; the mic, when the server opens it, is heard there; what the server asks done is done here.
 */
function startCloudLink() {
  setCloudPage(cloudTarget.page, { onFocus: () => cloudLink?.claim() });
  let voiceOpen = false;
  cloudLink = createCloudLink({
    link: cloudTarget,
    // Which of the user's computers this is, for where he's open (devices.js).
    device: thisDevice,
    log,
    onVoice: (op) => {
      const open = op === 'open';
      if (open === voiceOpen) return;
      voiceOpen = open;
      log(open ? 'cloud: the server is listening through this Mac' : 'cloud: the server stopped listening here');
      if (open) {
        speech.divert((samples) => cloudLink.audio(samples));
        voicePage.open();
      } else {
        speech.divert(null);
        voicePage.close();
      }
    },
    onPlay: (sound) => {
      if (sound.stop) return voicePage.stop();
      // Only with the voice page open (the server listening here): his voice is played by it.
      if (!voiceOpen) return cloudLink.status({ ended: sound.id });
      voicePage.play(sound.bytes, sound.type, { queued: sound.queued === true }).catch((err) => log('cloud: couldn’t play his voice:', err.message)).finally(() => cloudLink.status({ ended: sound.id }));
    },
    onHands: handsAsked,
    // What its hands are doing, and its own switches: his website shows them, and throws them (the phone as a remote).
    onRefused: () => cloudRefused().catch((err) => log('cloud: couldn’t ask to sign in again:', err.message)),
    // The server's answer to this Mac's Jester moving in: taken, or it has one already. Either way, not sent again.
    onFrame: (frame) => {
      if (frame?.t !== 'moved-in') return;
      log(frame.ok ? 'cloud: this Mac’s Jester moved to the server: it’s starting again with it' : `cloud: nothing moved to the server: ${frame.why || 'it didn’t say why'}`);
      if (frame.ok || frame.already) storage.local.set({ cloudMoved: cloudTarget.origin }).catch(() => undefined);
    },
    handsState: () => ({ running: assistant.running, asking: assistant.asking, abilities: macAbilities, doing: assistant.doing || '', engine: engine.state === ENGINE.SLEEPING ? 'sleeping' : String(engine.state || ''),
      switches: { enabled: settings?.enabled !== false, gestures: settings?.gesturesEnabled !== false, pointer: settings?.pointerEnabled !== false } }),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onChange: (connected) => {
      post(desktopState());
      if (connected) moveIn().catch((err) => log('cloud: couldn’t send this Mac’s Jester:', err.message));
    }
  });
  refreshMacAbilities();
  setInterval(refreshMacAbilities, 5000).unref?.();
}

/** What the Mac can do, as abilities.js counts it: sent to the server with the hands' state. */
async function refreshMacAbilities() {
  macAbilities = {
    computer: process.platform === 'darwin' ? 'Mac' : 'computer',
    chrome: !!chromeLink?.linked,
    web: webReady(),
    pictures: await assistant.canSee().catch(() => false),
    gestures: settings?.gesturesEnabled !== false,
    watch: !!watch?.state?.paired,
    scripts: (scripts?.count || 0) > 0
  };
}

/** The server's conversation asks the Mac's hands (remote-hands.js): done as this Mac's own conversation would have. */
async function handsAsked(frame) {
  const text = String(frame.text || '').slice(0, 4000);
  switch (frame.op) {
    case 'knows':
      return voiceRunner.knows(text);
    case 'risky':
      return voiceRunner.risky(text);
    case 'scriptsAsk':
      return voiceRunner.scriptsAsk(text);
    case 'run': {
      const { outcome } = await voiceRunner.run(text, { talking: true, said: frame.said, context: frame.context || {} });
      // Plain data only: what's said, its card and sources, never a function.
      return { outcome: outcome ? JSON.parse(JSON.stringify(outcome)) : null };
    }
    case 'confirm':
      return assistant.confirm(String(frame.label || '').slice(0, 300));
    case 'answer':
      assistant.answer(!!frame.yes);
      return true;
    case 'reask':
      return assistant.reask();
    case 'cancel':
      await assistant.cancel();
      return true;
    // Where this Mac is, for the server: the user's using it, or his website in its window (device-location.js).
    case 'where': {
      if (!locateHere) return { ok: false, code: 2 };
      const got = await locateHere({ timeoutMs: Math.min(Math.max(Number(frame.timeoutMs) || 25000, 5000), 90000) });
      return got?.ok ? { ok: true, lat: got.lat, lon: got.lon, accuracy: Number(got.accuracy) || 0 } : { ok: false, code: got?.code || 2, message: String(got?.message || '').slice(0, 200) };
    }
    // A switch of this Mac's Jester thrown from his website (the phone as a remote), or its task stopped.
    case 'set': {
      const change = frame.change && typeof frame.change === 'object' ? frame.change : {};
      if (typeof change.sleep === 'boolean') sleep(change.sleep);
      if (change.stop === true) await assistant.cancel();
      const next = {};
      if (typeof change.gestures === 'boolean') next.gesturesEnabled = change.gestures;
      if (typeof change.enabled === 'boolean') next.enabled = change.enabled;
      if (typeof change.pointer === 'boolean') next.pointerEnabled = change.pointer;
      if (Object.keys(next).length) await saveSettings(next);
      cloudLink?.stateChanged();
      return { ok: true };
    }
    // Controls on his website: this Mac's scripts, within what the server may ask (script-remote.js).
    case 'scripts':
      if (!scriptsRemote) return { ok: false, why: 'Jester is still starting on your Mac.' };
      return scriptsRemote.handle(frame.message && typeof frame.message === 'object' ? frame.message : {});
    default:
      throw new Error(`Not something the Mac does: ${frame.op}`);
  }
}

async function start() {
  if (!env.JESTER_KEEP_DOCK) app.dock?.hide();
  if (['light', 'dark'].includes(env.JESTER_THEME)) nativeTheme.themeSource = env.JESTER_THEME;
  serveFiles();
  // API keys are sealed on disk with the OS's keychain (macOS) or DPAPI (Windows),
  // which is first touched when a key is saved. Without either, saving fails:
  // a key is never written in the clear.
  // A server has neither: its own key file seals them (file-sealer.js).
  const sealer = SERVER
    ? createFileSealer(path.join(app.getPath('userData'), 'sealing.key'))
    : {
        seal: (text) => safeStorage.encryptString(text).toString('base64'),
        unseal: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64'))
      };
  installBridge({ onClose: closeSafely, sealer });
  await seedSettings();
  installMediaPermissions();
  // A server asks no OS for a camera or a mic: browsers ask for their own.
  permissions = SERVER ? [] : readPermissions();
  if (SERVER) startWebGateway();
  // "Use Jester in the cloud": set in Settings, taken up at launch (changing it restarts him).
  else cloudTarget = parseCloudLink((await storage.local.get('cloudBrain')).cloudBrain?.link);

  // JESTER_NO_OVERLAY (tests): no windows over the displays, toasts dropped.
  overlays = env.JESTER_NO_OVERLAY || SERVER
    ? { track() {}, toast() {}, cursor() {}, ripple() {}, whileHidden: (task) => task(), toScreen: () => null, windows: () => [], activeWindow: () => null, destroy() {} }
    : createOverlays();
  // A server's hands are the Mac's, when it's connected (none yet): no driver of its own, and no Chrome to link to.
  if (!SERVER) {
    startInput();
    startChromeLink();
  }
  // Whether they're at the computer: asked of the system's own count of quiet seconds, never of the camera. On a
  // server, nobody sits at it: it's how long since anything was done in a browser that has his window open.
  presence = createPresence({
    idleSeconds: () => (SERVER ? Math.min((Date.now() - webActiveAt) / 1000, remoteHands?.idleSeconds() ?? Infinity) : powerMonitor.getSystemIdleTime()),
    keptAwake: process.platform === 'darwin' && !SERVER ? () => macScreenKeptAwake(runFile) : undefined,
    file: path.join(app.getPath('userData'), 'presence.json'),
    tickMs: Number(env.JESTER_TICK_MS) || undefined,
    log,
    onChange: (where) => {
      teller?.moved(where);
      // Back at the Mac: it's the Mac he's talking to, if he's in the cloud.
      if (where === 'here') cloudLink?.claim();
    },
    // The day's first sit-down is when the morning brief belongs: and any later one, until it's been given.
    onArrive: () => queueMorningBrief()
  });
  pointer = createPointer({
    driver: {
      call: (...args) => {
        if (env.JESTER_SELFTEST) pointerCalls.push(args);
        return driver ? driver.call(...args) : Promise.reject(new Error('jester-driver is not running'));
      }
    },
    overlays,
    display: pointerDisplay,
    toast: (text, options) => overlays.toast(text, options),
    log,
    dryRun: !!env.JESTER_DRIVER_DRY,
    // A click on a page in the linked Chrome lands on the link the extension finds nearest.
    aimInBrowser: (request) => (browserMode && chromeLink?.linked ? chromeLink.aim(request) : null)
  });
  // The Apple Watch talks to the Mac on its own network: a server never sees it.
  if (!SERVER) watch = createWatch({
    loadKey: async () => (await storage.local.get('watchKey')).watchKey,
    saveKey: (watchKey) => storage.local.set({ watchKey }),
    forgetKey: () => storage.local.remove('watchKey'),
    onReport: onWatchReport,
    onChange: () => refresh(),
    log
  });
  // His own keys and clicks aren't the user's: presence is told while he's at them.
  const input = {
    call: (cmd, ...rest) => {
      if (!driver) return Promise.reject(new Error('jester-driver is not running'));
      if (!OWN_INPUT.has(cmd)) return driver.call(cmd, ...rest);
      const done = presence.own();
      return driver.call(cmd, ...rest).finally(done);
    }
  };
  dispatch = createDispatcher({ driver: input, getSettings: loadSettings, canPost, onJester, toast: (text, options) => overlays.toast(text, options), log });
  // Switched on by refresh(), from the settings.
  speech = startSpeech({ log });
  // A dry run describes `open`, `osascript` and `shortcuts` too, rather than running them.
  const runTool = env.JESTER_DRIVER_DRY ? async (file, args) => (log('dry run: would run', file, JSON.stringify(args)), '') : runFile;
  stopButton = createStopButton({ onStop: stopAutomation });
  spend = createSpend({ storage: storage.local, log });
  assistant = createAssistant({
    driver: input,
    openApp: (name) => voiceRunner.openApp(name),
    // Back to the front, for the app the assistant read: keys go wherever is in front.
    activate: (app) =>
      process.platform === 'darwin' ? runTool('open', app.bundleId ? ['-b', app.bundleId] : ['-a', String(app.name)]) : input.call('activateApp', { pid: app.pid }),
    openUrl: (url) => (process.platform === 'darwin' ? runTool('open', [url]) : runTool('rundll32.exe', ['url.dll,FileProtocolHandler', url])),
    dispatch,
    place: (request) => voiceRunner.place(request),
    prompt: createApprovalPrompt(),
    // Jester's own windows (Settings, say) are never the app meant.
    exclude: process.pid,
    // A question can be answered aloud: the mic opens for it, or is open, and he asks it.
    // Asked of someone typing to him, it's written, mic or no mic.
    // In the cloud, the conversation is the server's: it asks.
    listen: (label) => (cloudLink?.connected ? cloudLink.ask(label) : listening || conversation.typing ? conversation.ask(label) : !voiceProblem() && engineHost.voice('start')),
    // macOS reads no app's controls while a Jester overlay is up (README): the pill blinks out meanwhile.
    quietly: (task) => overlays.whileHidden(task),
    // A picture of the window, when its words aren't enough: with Screen Recording allowed, and not turned off in Settings.
    picture: windowShot(),
    onBusy: (busy, task) => researchPresentation.busy(busy, task),
    onVoice: (voice, task) => researchPresentation.voice(voice, task),
    onResearch: (state, task) => researchPresentation.update(state, { owner: task, stop: () => assistant.cancel(task) }),
    log,
    logScreens: !!env.JESTER_LOG_SCREENS,
    // Tasks go to this computer's model when no saved one can take them.
    localModel,
    modelHooks,
    web: readWeb,
    webReady
  });
  // Taught phrases, learned tasks and shortcuts, kept with the app's settings, and listed in the vault's Routines note.
  learned = createLearned({ storage: storage.local, onChange: writeRoutinesNote });
  // The user's own scripts: Controls' blocks, and his to run when asked. A folder with no jester.json is drafted by
  // the talking model, made a moment below, as are words no phrase of theirs fits.
  scripts = createScripts({
    storage: storage.local,
    draft: (folder) => draftManifest(folder, { request: (request) => talking(request), log }),
    request: (request) => talking(request),
    log,
    onChange: (change) => {
      post({ type: 'jester/scripts-changed', ...change });
      // Linked to the cloud, Controls on his website is this Mac's too.
      cloudLink?.scriptsChanged(change);
      updateTray();
    }
  });
  scripts.ready().then(updateTray);
  // What his website's Controls may ask of them, through the server (script-remote.js): a folder is chosen, and what
  // runs allowed, here on the Mac.
  scriptsRemote = createScriptsRemote({
    scripts,
    ask: (message) => scriptsAsked(message),
    choose: () => chooseScriptFolder({ fromServer: true }),
    confirm: async ({ adding, name, folder, lines }) => {
      app.focus({ steal: true });
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: [adding ? 'Add It' : 'Allow', 'Don’t Allow'],
        defaultId: 1,
        cancelId: 1,
        message: adding ? `Add “${name}” to Controls?` : `Change what “${name}” runs?`,
        detail: `Asked from Jester’s website. It would let Jester run these on this Mac, from ${folder.replace(/^\/Users\/[^/]+/, '~')}:\n\n${lines.slice(0, 16).join('\n')}${lines.length > 16 ? `\n…and ${lines.length - 16} more` : ''}`
      });
      return response === 0;
    },
    log
  });
  voiceRunner = createVoiceRunner({
    driver: input,
    dispatch,
    canPost,
    onJester,
    run: runTool,
    log,
    assistant,
    learned,
    displays: () => {
      const primary = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((display) => ({ id: display.id, bounds: display.bounds, workArea: display.workArea, internal: !!display.internal, primary: display.id === primary }));
    },
    toOsFrame: (frame) => toOsFrame(screen, frame),
    toDipFrame: (frame) => toDipFrame(screen, frame),
    quietly: (task) => overlays.whileHidden(task),
    // What's the browser's (its bookmarks, tabs and pages) the linked extension does.
    scripts,
    browser: {
      claims: (text) => chromeLink?.claims(text, { browserInFront: browserMode }) ?? false,
      run: (text, meant = '', options = {}) => assistant.elsewhere(text, (signal) => chromeLink.task(text, { signal, meant, ...options }))
    }
  });
  // On a server, the browser being talked to is the voice page (web-gateway.js).
  voicePage = SERVER ? createRemoteVoicePage(webGateway, { log }) : createVoicePage({ log });
  kokoro = startKokoro({
    fork: (file) => utilityProcess.fork(file, [], { serviceName: 'Jester voice', stdio: 'pipe' }),
    voice: () => settings?.jesterVoice,
    log
  });
  // The sign-in to the voice service he used before this one: nothing uses it now.
  storage.local.remove('puterToken').catch(() => undefined);
  speaker = createSpeaker({
    // A self-test is never heard: the fake mic would hear it, and so would the room.
    voice: env.JESTER_FAKE_MEDIA ? null : kokoro,
    play: (bytes, type, options) => voicePage.play(bytes, type, options),
    stopPlaying: () => voicePage.stop(),
    system: systemVoice({ muted: !!env.JESTER_FAKE_MEDIA }),
    log
  });
  talking = createModelJob({ job: 'talk', local: localModel, keepAlive: LOCAL_KEEP_ALIVE, log, ...modelHooks, onSelected: ({ provider, model }) => log('talking through:', provider, model) });
  vaultIndex = createVaultIndex({ vault: () => vault, file: vaultIndexFile(), log, onRefreshed: vaultRead });
  vaultMemory = createVaultMemory({
    vault: () => vault,
    index: vaultIndex,
    request: talking,
    log,
    openExternal: (url) => shell.openExternal(url),
    keepConversations: () => settings?.memoryConversations !== false,
    imported: () => chatLearner?.counted()
  });
  // A run tells Settings how it's going, at most twice a second: three chats a second are read.
  let learningTold = 0;
  let learningDue = null;
  chatLearner = createChatLearner({
    vault: () => vault,
    request: talking,
    file: path.join(app.getPath('userData'), 'chat-learning.json'),
    log,
    onChange: () => {
      const wait = 500 - (Date.now() - learningTold);
      if (learningDue) return;
      learningDue = setTimeout(() => {
        learningDue = null;
        learningTold = Date.now();
        post(desktopState());
      }, Math.max(0, wait));
    }
  });
  // The vault's opened before the conversation log is: one left from the last run ends as the log loads, and is
  // summed up knowing what About me holds, kept in the vault, and kept at all only if Remember conversations is on.
  settings = await loadSettings();
  // A server's vault is always the one it was started with, synced from the Mac: settings brought from a Mac name
  // the Mac's folder, which isn't here.
  if (SERVER && env.JESTER_VAULT) {
    const vaultHere = path.resolve(env.JESTER_VAULT);
    const root = fs.existsSync(vaultHere) ? vaultRootIn(vaultHere) || vaultHere : vaultHere;
    if (settings.memoryVault !== root) {
      await saveSettings({ memoryVault: root });
      settings = await loadSettings();
    }
  }
  openVault();
  // Where the user is, the weather and their calendars: nothing until they're connected in Settings.
  const showDay = () => post(desktopState());
  weather = createWeather({ log });
  // A Mac asks Location Services itself, as Jester: the first time, macOS asks whether "Jester" may know, and a
  // position waits for that answer, so it's first asked from Settings (90 s).
  const macLocation = loadMacLocation({ log });
  locateHere = macLocation ? createMacLocate({ native: macLocation }) : locateByPage;
  // On a server, "where you are" is where the device being used is: its browser's, or the Mac's (device-location.js).
  whereabouts = createWhereabouts({
    locate: SERVER ? (options) => deviceLocate?.locate(options) ?? { ok: false, code: 2 } : locateHere,
    device: SERVER ? () => deviceLocate?.device() || '' : null,
    setting: () => ({ source: settings?.locationSource, place: settings?.locationPlace }),
    log,
    onChange: showDay
  });
  // A calendar read again may have moved a class: the check-ins before each follow it.
  calendars = createCalendars({ storage: storage.local, log, onChange: () => (showDay(), syncBriefs()) });
  // In the cloud, the server reads their calendars.
  if (!cloudTarget) calendars.start().catch((err) => log('calendar: couldn’t start:', err.message));
  // His clock, and what's kept on it: the user's to-do list, reminders and timers.
  clock = createClock({ file: path.join(app.getPath('userData'), 'jobs.json'), log });
  tasks = createTasks({
    file: path.join(app.getPath('userData'), 'tasks.json'),
    clock,
    log,
    // His window's Tasks panel, and the count on its button.
    onChange: () => post({ type: 'jester/tasks-changed', count: tasks.count })
  });
  // A clock file lost or set aside mustn't lose a reminder: each is put back on it.
  tasks.reschedule();
  // Work he offers to do (offers.js): kept, so a "no" outlasts a restart, and shown in his window to answer.
  offers = createOffers({ storage: storage.local, log, onChange: publishOffers });
  await offers.start();
  runOffer = createOfferRunner({ tasks, calendars, openExternal: (url) => shell.openExternal(url) });
  // Past its time an offer is over, with nothing else changing: his window is told, looked at each minute.
  setInterval(() => offers.ready && offersKey() !== offersShown && publishOffers(), 60_000).unref?.();
  situation = createSituation({
    whereabouts,
    weather,
    calendars,
    units: () => unitsFor(settings?.weatherUnits, app.getLocaleCountryCode()),
    computer: process.platform === 'darwin' ? 'Mac' : 'computer',
    presence,
    tasks,
    // New mail that looked worth telling, once Gmail's connected (made further down).
    mail: { wanted: (text) => !!mail?.wanted(text), lines: () => mail.lines() }
  });
  recollections = createRecollections({
    file: path.join(app.getPath('userData'), 'recollections.json'),
    // One call sums a conversation up and keeps what's worth keeping in the vault: not if it's been deleted meanwhile.
    summarize: async (entries) => (await vaultMemory.ended(entries, { wanted: () => keeper.wanted(entries) })).summary,
    log
  });
  keeper = createChatKeeper({
    chats: createChatArchive({ file: path.join(app.getPath('userData'), 'chats.json'), log }),
    recollections,
    // Every chat going on, on any device (sessions.js).
    live: () => (sessions ? sessions.list().map((session) => session.log.chatId()).filter(Boolean) : []),
    onChats: chatsChanged,
    log
  });
  // A chat per device (sessions.js): on a server each device has its own conversation going on; in the app, the one.
  sessions = createSessions({ make: makeSession, frontKey: () => (SERVER ? frontDevice() : '') });
  conversation = following(() => sessions.front().conversation);
  conversationLog = following(() => sessions.front().log);
  // Chats that were going on when he last stopped, on devices that aren't back yet: theirs to end and keep.
  for (const file of fs.readdirSync(app.getPath('userData'))) if (sessionKeyOf(file)) sessions.get(sessionKeyOf(file));
  sessions.get('local');
  // The hour, and the week a chat's kept for, are kept to even with nothing said.
  setInterval(() => {
    for (const session of sessions.list()) session.log.expire();
    keeper.sweep();
  }, LOG_CHECK_MS);

  function makeSession(key) {
  // The computers' hands, for this chat: what it asks goes to its own device first, and their questions come back to it.
  const hands = SERVER ? remoteHands.for(key, () => key) : null;
  let own = null;
  // On a server he may be speaking for another device's chat: this one's turn doesn't cut that off.
  let speaking = 0;
  const voice = !SERVER ? speaker : {
    prepare: (...args) => speaker.prepare?.(...args),
    say: (...args) => {
      speaking += 1;
      return Promise.resolve(speaker.say(...args)).finally(() => (speaking -= 1));
    },
    stop: () => (speaking > 0 ? speaker.stop() : undefined)
  };
  // A conversation is over once it's gone quiet: kept then, rather than when the hour comes round.
  const memory = createConversationLog({
    file: path.join(app.getPath('userData'), sessionFile(key)),
    endAfterMs: NEW_AFTER_MS,
    // Not while a task he handed on is at work, or its result is being said: that's still this conversation.
    busy: () => !!own?.acting,
    onEnded: (entries) => keeper.over(entries, { device: deviceLabel(key) }),
    // His window shows the conversation going on, as it goes.
    onChange: () => (showChat(key), replied(key))
  });
  own = createConversation({
    chat: (request) => askModel({ ...request, request: talking }),
    // A timer ringing: turned off by their saying so, or by their talking to him at all.
    ring: { ringing: () => !!ring?.ringing, stop: (by) => !!ring?.stop(by) },
    speaker: voice,
    memory,
    // What's over is in Chats at once, word for word, and summed up for him once he's answered, whichever way it ended.
    archive: (entries) => keeper.keep(entries, { device: deviceLabel(key) }),
    recollections: {
      keep: (entries) => keeper.sumUp(entries),
      // A chat picked up again is the one going on, not one that's over.
      relevant: (text) => recollections.relevant(text, { except: memory.chatId() }),
      forget: () => recollections.forget()
    },
    warm: warmUp,
    // At a pause that may be the end of what's being said, his reply is begun, and thrown away if they go on: only
    // when the model that would be asked is a paid one, where that costs a few thousandths of a cent. A free plan
    // counts every request against its minute, and one on this computer does one thing at a time.
    thinkAhead: async () => (await talking.savedOnes())[0]?.plan === 'paid',
    // Only with the mic open: typing to him with it closed, there's nobody to wait for.
    knowsYou: () => !!voiceprint && listening,
    // On a server, the Mac's (remote-hands.js): what it knows and does, over its link.
    commands: SERVER
      ? hands.commands
      : {
          knows: (text) => voiceRunner.knows(text),
          risky: (text) => voiceRunner.risky(text),
          scriptsAsk: (text) => voiceRunner.scriptsAsk(text),
          run: (text, said, context) => voiceRunner.run(text, { talking: true, said, context })
        },
    // What he remembers and the user's notes, for each turn; "remember this"; notes made and opened.
    vaultMemory: {
      // Whether there's a vault to use. With none (not chosen, or macOS keeps him out), notes are made in the computer's own apps.
      ready: () => !!vault,
      recall: (text, history) => vaultMemory.recall(text, { history }),
      remember: (request) => vaultMemory.remember(request),
      forget: (request) => vaultMemory.forget(request),
      note: (request) => vaultMemory.note(request)
    },
    // Where the user is, the weather there and their calendars, once connected in Settings. On a server, where he's
    // open and what each device is being used for, too (devices.js): he's one Jester on all of them.
    situation: !SERVER ? situation : {
      live: () => situation.live(),
      brief: async (text, options) => {
        const got = await situation.brief(text, options);
        const open = devices?.lines(key) || '';
        return open ? { ...got, block: [got.block, open].filter(Boolean).join('\n') } : got;
      }
    },
    // Their to-do list, reminders and timers.
    tasks,
    // Their own scripts: run by "run", or kept with a task to run later.
    scripts,
    // Work he offers to do, answered (offers.js): kept as asked, put off or turned down, and done here or as a command.
    work: {
      asked: (ids) => offers.asked(ids),
      answer: (ids, op) => offers.answer(ids, op),
      run: (offer) => runOffer(offer),
      finish: (id, outcome) => offers.finish(id, outcome)
    },
    // The day's brief and its wrap-up, when they ask for one.
    briefs: {
      asked: briefingRequest,
      compose: async (request, options) => {
        const record = await briefingManager.requested(request, options);
        if (!record) return null;
        // An update replaces the day's earlier one: its "later" is called off.
        for (const id of record.replaced || []) clock.remove(`brief-later-${id}`);
        // Nothing to say, or none kept for that day: said as it is, and nothing saved.
        if (!record.id) return { text: record.text || '', card: null, untrusted: false };
        return readStoredBriefing(record.id);
      },
      read: readStoredBriefing,
      respond: respondToBriefing,
      given: (_request, made) => made?.briefingId
        ? briefingManager.respond(made.briefingId, 'read-complete', { token: made.readToken }) : undefined,
      interrupted: (made) => made?.briefingId
        ? briefingManager.respond(made.briefingId, 'interrupted', { token: made.readToken }) : undefined
    },
    // The rest of what's connected, read each turn, so what he says he can do is what's true now (abilities.js).
    abilities: async () => SERVER ? {
      // The Mac's, while it's connected; with none, there's no computer to work.
      ...(remoteHands.abilities || { computer: false }),
      web: webReady() || !!remoteHands.abilities?.web,
      voice: !!voiceprint,
      phone: !!push?.ready,
      mail: !!google?.signedIn
    } : ({
      chrome: !!chromeLink?.linked,
      web: webReady(),
      pictures: await assistant.canSee(),
      voice: !!voiceprint,
      gestures: settings?.gesturesEnabled !== false,
      watch: !!watch?.state?.paired,
      phone: phoneReady(),
      scripts: (scripts?.count || 0) > 0,
      mail: !!google?.signedIn,
      computer: process.platform === 'darwin' ? 'Mac' : 'computer'
    }),
    assistant: SERVER ? hands.assistant : assistant,
    show: (frame) => showConversation(frame, key),
    log
  });
  return { conversation: own, log: memory };
  }

  // Telling the user when something's time comes (tell.js): said if they're here, held until they're back if not.
  teller = createTeller({
    where: () => presence.where,
    // With the mic closed he has no voice: it's written, on the pill and in his window.
    // Not across the lines being read to teach him their voice, or anyone mid-sentence.
    // What he'd offer to do about it, if it's still waiting on an answer by the time it's said (held while they were away).
    announce: (text, card, more) => (teaching || (listening && speech.hearing) ? null : conversation.announce(text, { written: !listening, card, untrusted: more?.untrusted === true,
      offers: more?.offers?.length && settings?.offerWork !== false ? offers?.waiting(more.offers.map((offer) => offer.id)) || [] : [] })),
    release: () => clock.release(),
    // Held, or waiting on another try at their phone: back, they're told now.
    held: () => clock.held + clock.waiting,
    // Away, a line goes to their phone, if it's set up. With a film or a call on, it's shown and not said: on the
    // screen, and written in his window with its card.
    // On a server that's his own app's notifications (push.js), on every device that takes them.
    phone: (message) => (SERVER ? push.send(message) : phone.send(message)),
    watching: () => presence.watching,
    show: (text, title, card, more) => {
      overlays.toast(text, { detail: title });
      conversation.announce(text, { written: true, card, untrusted: more?.untrusted === true });
    },
    settleMs: Number(env.JESTER_SETTLE_MS) || undefined,
    log
  });
  ring = createRing({
    page: createRingPage({ muted: !!env.JESTER_FAKE_MEDIA }),
    ringMs: Number(env.JESTER_RING_MS) || undefined,
    log,
    onChange: () => {
      post({ type: 'jester/tasks-changed', count: tasks.count });
      updateTray();
    }
  });
  clock.on('say', teller.say);
  // A reminder's time, or a timer's end: told like any line, and only then counted as given.
  clock.on('task', async (job, info) => {
    const id = job.payload?.id;
    // Scripts set for a time ("turn the lights off at 11"): run, here or not. How it went is said if they're here
    // and it worked, and told like a reminder (held, or sent to their phone) if it didn't.
    const timed = tasks.get(id);
    if (timed?.run?.length && !timed.done) {
      // Run once: a job held to tell them it failed comes back here, and only tells it.
      if (!timed.failed) {
        // Much later than it was for (the Mac asleep, or Jester not running), it isn't done: the heater on at 6 isn't
        // wanted at 9. They're told it wasn't.
        if (info.late > RUN_LATE_MS) {
          const meant = new Date(info.meant).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          log(`scripts: a timed run ${Math.round(info.late / 60000)} min late: not done`);
          tasks.ran(id, false, `it was for ${meant}, when I couldn’t run it, so it wasn’t done`);
        } else {
          // Not waited for: the clock does one job at a time, and a device that doesn't answer takes half a minute a
          // step, which a timer due meanwhile mustn't wait behind. A failure comes back on the clock, to be told.
          const told = (outcome) => {
            log(`scripts: a timed run ${outcome.ok ? 'worked' : 'failed'}`);
            tasks.ran(id, outcome.ok, outcome.text);
            if (outcome.ok) {
              if (presence.where !== 'away') conversation.announce(outcome.text, { written: !listening });
            } else clock.add({ id: `task-${id}`, kind: 'task', at: Date.now(), payload: { id } });
          };
          scripts.runAll(timed.run).then(told, (err) => told({ ok: false, text: String(err?.message || 'it didn’t work') }));
          return undefined;
        }
      }
      const failed = tasks.get(id);
      if (!failed) return undefined;
      const answer = await teller.say({ ...job, payload: { text: `${failed.text}: ${failed.failed}`, late: `${failed.text}: ${failed.failed}`, card: tasks.cardFor(id), title: 'Scripts', priority: 4 } }, info);
      if (!answer) tasks.rang(id);
      return answer;
    }
    const text = tasks.ringLine(id);
    // Ticked off or removed meanwhile: there's nothing to say.
    if (!text) return undefined;
    const timer = !!tasks.get(id)?.timer;
    const label = tasks.get(id)?.text || 'Timer';
    // Told to stop while he was saying it's up: that was the answer, and it doesn't then ring.
    const hushed = conversation.hushes;
    let here = null;
    const answer = await teller.say({ ...job, payload: { text, late: tasks.ringLine(id, info.meant), card: tasks.cardFor(id), title: timer ? 'Timer' : 'Reminder', priority: 4 } }, { ...info, said: (how) => (here = how) });
    if (!answer) tasks.rang(id);
    // A timer that's up, said to them here and on time, rings until it's turned off. One they were told of late, on
    // coming back, has rung its hour out already; one sent to their phone rang there.
    if (!answer && timer && here && !here.late && conversation.hushes === hushed) ring.start({ id, label });
    return answer;
  });
  phone = createPhone({ storage: storage.local, log, onChange: () => post(desktopState()) });
  await phone.start();
  if (SERVER) {
    push = createPush({ storage: storage.local, log, onChange: devicesChanged });
    await push.start();
  }
  // Their Gmail: signed in to with Google, to read only, and watched for what matters.
  // On a server, Google's page opens in the browser that asked, and the address it lands on is pasted back (signInReturned).
  google = createGoogle({ storage: storage.local, open: (url) => (SERVER ? openInBrowser(url) : shell.openExternal(url)), log, onChange: () => post(desktopState()) });
  await google.start();
  mail = createMail({ google, storage: storage.local, request: talking, judged: () => settings?.mailJudge !== false, log });
  await mail.start();
  // Not waited for: a look at Gmail can take a while, and a timer mustn't wait behind it (the clock does one job at
  // a time). One look at a time is mail.js's own rule.
  clock.on('mail', () => void checkMail().catch((err) => log('mail: couldn’t look:', String(err?.code || 'error'))));
  syncMail();
  // The morning brief and the evening wrap-up (briefs.js): composed when it's time to say one, and counted as given
  // only once it's been said. Away, it's held; too late to be worth it, the clock drops it.
  briefs = createBriefs({ whereabouts, weather, calendars, tasks, mail, mailToModel: () => settings?.mailJudge !== false, presence, units: () => unitsFor(settings?.weatherUnits, app.getLocaleCountryCode()), request: briefWriter, research: researchForBriefing,
    offering, lately: () => recollections?.all?.() || [], log });
  briefingManager = createBriefingManager({ storage: storage.local, compose: async (kind, options) => withOffers(await briefs.compose(kind, options), kind),
    composeCustom: (request) => briefs.composeCustom(request), history: briefingHistory, onChange: publishBriefings, given: briefGiven });
  await briefingManager.start();
  ({ briefDays = {}, checkinsTold = {} } = await storage.local.get(['briefDays', 'checkinsTold']));
  setUpOnce = (await storage.local.get('setUpOnce')).setUpOnce === true;
  /** Times a brief found a connected source not ready (the network just after waking), and waited. */
  let unreadyTries = 0;
  clock.on('brief', async (job) => {
    const which = job.payload?.which === 'evening' ? 'evening' : 'morning';
    const today = dayOf(Date.now());
    const laterId = job.payload?.briefingId;
    if (!laterId && (settings?.[which === 'evening' ? 'briefEvening' : 'briefMorning'] === false || briefDays[which] === today)) return undefined;
    // Briefings wait until they are available, including across a film or call.
    if (presence.where === 'away' || presence.watching) return { hold: true };
    const composed = laterId ? briefingManager.get(laterId) : await briefingManager.prepare(which);
    // Nothing to say because the weather hadn't come yet: asked again in a minute, a few times, before it's let go.
    if (composed && !composed.text && composed.unready && unreadyTries < 4) {
      unreadyTries += 1;
      return { retryIn: 60_000 };
    }
    unreadyTries = 0;
    if (!composed?.id || !composed.text || ['read', 'dismissed', 'reading', 'replaced'].includes(composed.status)) return undefined;
    // Put off with Later: its own job (brief-later-<id>) asks again, not this one.
    if (!laterId && composed.status === 'later' && composed.laterUntil > Date.now()) return undefined;
    // As Duet opens its own: how much the day holds, and how much he could do for them.
    const waiting = settings?.offerWork === false ? [] : offers?.waiting(composed.offerIds) || [];
    const text = openerLine({ kind: composed.kind, count: composed.count || 0, offers: waiting.length, at: Date.now() });
    // Offered once it's been said to them, not before: a line held, or dropped by the clock, is offered another time.
    const card = briefingManager.card({ ...composed, status: 'offered' }, { offer: true });
    const said = () => briefingManager.offer(composed.id).then(() => log(`brief: the ${which} one offered`), () => undefined);
    return teller.say({ ...job, payload: { text, card, title: 'Your briefing', priority: 2, phone: false } }, { said });
  });
  // A word before each thing on the calendar: the calendar's own, and the clock's sum, never a model's.
  clock.on('checkin', async (job) => {
    if (settings?.checkIns === false) return undefined;
    const text = briefs.checkinLine(job.payload || {});
    // A call with a link: he offers to open it (offers.js), looked up on the calendar when it's opened.
    const call = text && settings?.offerWork !== false && job.payload?.call ? callOffer(job.payload) : null;
    const offered = call && offers ? await offers.propose([call], { source: 'checkin' }).catch(() => []) : [];
    const answer = text ? await teller.say({ ...job, payload: { text, untrusted: true, title: 'Coming up', priority: 4, ...(offered.length ? { offers: offered } : {}) } }) : undefined;
    if (text && !answer) {
      checkinsTold = { ...checkinsTold, [job.id]: job.payload.start };
      await storage.local.set({ checkinsTold }).catch(() => undefined);
    }
    return answer;
  });
  syncBriefs();
  setInterval(syncBriefs, 5 * 60_000).unref?.();
  presence.start();
  // What came due while he wasn't running is told once he's had a moment to start, not as he does.
  setTimeout(() => {
    // In the cloud, reminders, timers, mail and briefs are the server's: this clock would tell them twice.
    if (cloudTarget) return log('cloud: the clock here is off; the server keeps time');
    clock.start();
    // Restarted with them still about, nothing says they've come back: what was held is told as if they just had.
    teller.moved(presence.where === 'away' ? 'away' : 'here');
  }, Number(env.JESTER_SETTLE_MS) || SETTLE_MS);
  for (const [event, reason, on] of [['lock-screen', 'locked', true], ['unlock-screen', 'locked', false], ['suspend', 'suspended', true], ['resume', 'suspended', false]]) {
    powerMonitor.on(event, () => {
      if (on) away.add(reason);
      else away.delete(reason);
      // Nobody's there to turn it off, and it mustn't ring out its minute when the lid's next opened.
      if (on) ring?.stop('the screen locking or the computer sleeping');
      presence.screen(reason, on);
      updateListening();
      // Timers stood still while it slept: what came due meanwhile is seen to now.
      if (!on) clock.wake();
      // Back at the computer: it may be somewhere else now, and its calendars hours behind.
      if (!on) {
        if (whereabouts.source === 'here') whereabouts.locate().then(() => noteWeather());
        if (calendars.connected) calendars.refresh().catch(() => undefined);
      }
    });
  }

  let lastTelemetryLog = 0;
  let cursorFrames = 0;
  let micState = '';
  engineHost = startEngineHost({
    screen: primaryScreen,
    context: () => context,
    onStatus: (status) => {
      const started = status.state === ENGINE.RUNNING && engine.state !== ENGINE.RUNNING;
      const fell = status.state === ENGINE.SLEEPING && engine.state !== ENGINE.SLEEPING;
      const woke = status.state === ENGINE.RUNNING && engine.state === ENGINE.SLEEPING;
      engine = { state: status.state, detail: status.detail || '', camera: started ? '' : engine.camera || '' };
      const mic = status.mic ? `${status.mic.state}${status.mic.detail ? `: ${status.mic.detail}` : ''}` : '';
      if (mic !== micState) log('mic', (micState = mic));
      log('status', status.state, status.detail || '');
      if (started) noteCamera();
      // Asleep looks just like awake, so it's said, however it came about.
      if (fell) overlays.toast('Jester is asleep', { detail: wakeWords() });
      else if (woke) overlays.toast('Jester is awake');
      refresh();
    },
    onTrigger: (message) => {
      log('trigger', message.action, `(${message.source} ${message.gesture})`);
      presence.seen('gesture');
      const toggledSleep = message.action === 'SLEEP';
      // The camera sees the arm that's steering, and a swipe would move what it's aiming at.
      if (message.source === 'swipe' && !toggledSleep && pointer.aiming()) return log('trigger ignored: the watch is aiming');
      // While the assistant asks, 👍 and 👎 answer it instead of doing their
      // usual action, which sleep has already done: the engine does it on the spot.
      // A timer ringing is turned off by any gesture, which then does nothing else: a hand raised at it is "enough".
      if (ring?.stop('a gesture')) {
        if (toggledSleep) engineHost.sleep(!message.sleeping);
        return;
      }
      if (message.source === 'pose' && assistant.gesture(message.gesture)) {
        if (toggledSleep) engineHost.sleep(!message.sleeping);
        return;
      }
      if (toggledSleep && message.sleeping) assistant.cancel();
      // With the linked Chrome in front, the extension does what's Chrome's, on the page.
      if (browserMode && chromeLink?.linked && CHROME_SCOPES.has(ACTIONS[message.action]?.scope)) {
        chromeLink.act(message.action, { source: message.source, gesture: message.gesture }).then((result) => !result?.ok && log('chrome action', message.action, 'not done:', result?.detail));
        return;
      }
      dispatch(message.action, { source: message.source, gesture: message.gesture });
    },
    // The mic, opened for an answer to the assistant, may stop with none.
    onVoice: (message) => assistant.micEnded(message.voice),
    onCursor: (cursor) => {
      cursorFrames += 1;
      if (cursor?.click) log('cursor click at', cursor.x?.toFixed(3), cursor.y?.toFixed(3));
      pointer.frame(cursor);
    },
    onVoiceCommand: (text) => {
      log('voice command:', text);
      onVoiceCommand(text);
    },
    onTelemetry: (telemetry) => {
      // A hand in view, with the camera already on for gestures: someone's there.
      if (telemetry.handPresent) presence.seen('camera');
      const now = Date.now();
      if (now - lastTelemetryLog < 5000) return;
      lastTelemetryLog = now;
      const state = [telemetry.stalled && 'STALLED', telemetry.standby && 'asleep', telemetry.zoom && `zoom ${telemetry.zoom.state}`].filter(Boolean).join(' ');
      log(`telemetry fps ${telemetry.fps} ${telemetry.delegate}${state ? ` ${state}` : ''} hand ${telemetry.handPresent ? 'yes' : 'no'} gesture ${telemetry.gesture || '-'} · cursor frames ${cursorFrames} · ${cpuReport()}`);
      cursorFrames = 0;
    }
  });
  listenToPages();
  onStorageChanged((changes, area) => {
    if (area === 'local' && changes.settings) refresh();
  });

  if (cloudTarget) {
    thisDevice = await deviceIdentity();
    watchCloudSignIn();
    startCloudLink();
  }
  if (SERVER) {
    // No camera, menu bar, permissions or shortcut on a server: his window is the website, already listening.
    await refresh();
    return;
  }
  engineWindow = createEngineWindow(log);
  tray = createTray(onTrayAction);
  await refresh();
  setInterval(checkPermissions, PERMISSION_POLL_MS);
  watchFront();
  if (!globalShortcut.register(VOICE_SHORTCUT, () => onJester('voice'))) log(`${VOICE_SHORTCUT} is taken by another app`);

  if (env.JESTER_SELFTEST) selfTest(env.JESTER_CAPTURE && path.resolve(env.JESTER_CAPTURE));
  else if (env.JESTER_OPEN_SETTINGS) showSettings();
  // Something needed isn't there yet (a permission, a model, what he hears with): his window says what, with
  // Getting started a click away. A first launch is this.
  else if (missingFor(permissions, settings).length || (!(await setupState()).ready && !setUpOnce)) showHome();
  // Started from its icon, Jester opens no window: say it's there, once the overlay has loaded.
  else setTimeout(() => overlays.toast('Jester is on', { detail: 'It lives in the menu bar' }), STARTED_TOAST_MS);

  const seconds = Number(env.JESTER_SPIKE_SECONDS);
  // Destroy first: a window stuck mid-close must not keep a test run alive.
  if (seconds > 0) setTimeout(() => (BrowserWindow.getAllWindows().forEach((win) => win.destroy()), app.quit()), seconds * 1000);
}

// One Jester at a time: launching it again opens his window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Brought forward as it is: the Dock is clicked often to come back to it, mid-Settings, say.
  app.on('second-instance', () => reopenHome());
  app.on('activate', () => reopenHome());
  app.whenReady().then(start);
  // Closing his window leaves Jester running in the menu bar.
  app.on('window-all-closed', () => undefined);
  app.on('will-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    driver?.close();
    webScraper.close();
    watch?.close();
    linkTransport?.close();
    vaultIndex?.close();
    kokoro?.stop();
    calendars?.stop();
    presence?.stop();
    clock?.stop();
    spend?.flush().catch(() => undefined);
    scripts?.close();
    // Last: Jester.app made again if his icon or Electron changed, so the next start, however it's started, shows them.
    try {
      const done = remakeOnQuit(process.execPath);
      if (done) console.log(`[jester] ${done}`);
    } catch (err) {
      console.error(`[jester] Jester.app couldn't be remade: ${err.message}`);
    }
  });
}
