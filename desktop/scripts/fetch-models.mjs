/**
 * Download speech models into desktop/models/.
 *
 *   node scripts/fetch-models.mjs [name ...]   (no names: the default set)
 *
 * The app fetches what it needs itself the first time it's opened; this does the same from a terminal, for a
 * checkout or a server. Both use src/main/speech/model-fetch.js, which has the list.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModelFetcher, megabytes, MODEL_FILES, modelPath } from '../src/main/speech/model-fetch.js';

export const MODELS = MODEL_FILES;
const DEFAULT_SET = ['vad', 'voice', 'moonshine-tiny'];

const dir = process.env.JESTER_MODELS_DIR ? path.resolve(process.env.JESTER_MODELS_DIR) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const asked = process.argv.slice(2);
  const keys = asked.length ? asked : DEFAULT_SET;
  const live = process.stdout.isTTY;
  let fetcher;
  fetcher = createModelFetcher({
    dir,
    retryMs: [],
    onChange: (done) => {
      const { fetching } = fetcher.state();
      if (done) console.log(`${live ? '\r\x1b[K' : ''}${done}: ${modelPath(done, dir)}`);
      else if (live && fetching) process.stdout.write(`\r\x1b[K${fetching.id}: ${fetching.unpacking ? 'unpacking' : `${fetching.percent}% (${megabytes(fetching.got, fetching.total)})`}`);
    }
  });
  try {
    for (const key of keys) if (fetcher.has(key)) console.log(`${key}: ${modelPath(key, dir)}`);
    await fetcher.want(keys).done;
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { error } = fetcher.state();
  if (error) {
    console.error(`${live ? '\n' : ''}${error}`);
    process.exit(1);
  }
}
