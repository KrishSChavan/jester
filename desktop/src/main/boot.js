/**
 * Settled before anything else of his is loaded (main.js imports this first): where his own things are.
 *
 * Run from a checkout, they're where they always were: models/ beside src/, the helpers in native/, the extension's
 * folder next door. Installed (the app electron-builder packages: package.json "build", scripts/pack.mjs), his own
 * folder can't be written to and nothing's built on the user's computer, so:
 *
 *   Resources/app/               this folder (src/, node_modules/, scraping/), as plain files
 *   Resources/jester-extension/  the extension's folder, which src/ reaches by the same ../../../ as in a checkout
 *   Resources/package.json       { "type": "module" }: what the repository's root one says for the extension's files
 *   Resources/bin/               jester-driver, and on a Mac jester-watch-bridge and jester-location.node
 *   <userData>/models/           what he hears and speaks with, which he fetches himself (speech/model-fetch.js)
 *   <userData>/scrapling/        the page-reading helper's Python, if it's ever set up
 *
 * The folders reach the modules that use them, and the speech and voice services, which inherit this environment,
 * as environment variables: they're read where a module is loaded, before main.js's own code runs.
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';

const env = process.env;

if (env.JESTER_DATA_DIR) {
  app.setPath('userData', path.resolve(env.JESTER_DATA_DIR));
  // A test Jester's log is its own, not the user's.
  app.setAppLogsPath(path.join(path.resolve(env.JESTER_DATA_DIR), 'logs'));
}

// A test's Jester on a computer someone's using (scripts/dist-check.mjs): his windows open faint, unfocused and
// click-through, so they're in nobody's way, and he never takes the front.
if (env.JESTER_QUIET) {
  BrowserWindow.prototype.show = function show() {
    this.setOpacity(0.02);
    this.setIgnoreMouseEvents(true);
    this.showInactive();
  };
  BrowserWindow.prototype.focus = () => undefined;
  app.focus = () => undefined;
}

/** Installed, not run from a checkout. */
export const PACKAGED = app.isPackaged;

/** Where the helpers built for him are, installed; null from a checkout, where each is in its own build folder. */
export const BIN = PACKAGED ? path.join(process.resourcesPath, 'bin') : null;

if (PACKAGED) {
  const data = app.getPath('userData');
  env.JESTER_MODELS_DIR ||= path.join(data, 'models');
  env.JESTER_SCRAPLING_DIR ||= path.join(data, 'scrapling');
  // An installed Jester always keeps a log of his last two runs: it's the only way to tell what went wrong.
  env.JESTER_LOG ||= '1';
}

/** His log's name: the launcher and dev:mac made dev.log what a checkout's is called. */
export const LOG_NAME = PACKAGED ? 'jester.log' : 'dev.log';
