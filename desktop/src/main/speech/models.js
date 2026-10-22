/**
 * Recognizer configs for the speech models Jester can use.
 *
 * All run on the CPU, offline, through sherpa-onnx. `offline` models hear a
 * whole utterance and decode it once speech has ended (a voice-activity
 * detector decides when); `streaming` ones decode as audio arrives and
 * decide the end themselves.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../models');

const SAMPLE_RATE = 16000;
const threads = 2;

function parakeet(folder) {
  return {
    kind: 'offline',
    folder,
    config: (dir) => ({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, 'encoder.int8.onnx'),
          decoder: path.join(dir, 'decoder.int8.onnx'),
          joiner: path.join(dir, 'joiner.int8.onnx')
        },
        modelType: 'nemo_transducer',
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: threads,
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    })
  };
}

export const SPEECH_MODELS = {
  // Moonshine v2 tiny, MIT. Built for short commands on small devices.
  'moonshine-tiny': {
    kind: 'offline',
    folder: 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27',
    config: (dir) => ({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        moonshine: { encoder: path.join(dir, 'encoder_model.ort'), mergedDecoder: path.join(dir, 'decoder_model_merged.ort') },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: threads,
        provider: 'cpu',
        debug: 0
      }
    })
  },
  // NVIDIA Parakeet TDT 110M, int8, CC-BY-4.0. (A transducer: sherpa-onnx's
  // hotwords would need its BPE vocabulary, which this package doesn't ship.)
  'parakeet-110m': parakeet('sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8'),
  // The same, 0.6B (v2), CC-BY-4.0: steadier on real microphones and accents,
  // at ~650 MB on disk.
  'parakeet-0.6b': parakeet('sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'),
  // Kroko streaming Zipformer: partial text while you talk, built-in endpointing.
  kroko: {
    kind: 'streaming',
    folder: 'sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06',
    config: (dir) => ({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, 'encoder.onnx'),
          decoder: path.join(dir, 'decoder.onnx'),
          joiner: path.join(dir, 'joiner.onnx')
        },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: threads,
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 20
    })
  }
};

export const VAD_MODEL = path.join(MODELS_DIR, 'silero_vad.onnx');

/** The models Settings offers, most accurate first: without a choice, the first one downloaded. */
export const SPEECH_CHOICES = [
  { id: 'parakeet-0.6b', label: 'Accurate', hint: 'Fewer mistakes. Uses up to about 800 MB of memory while in use.' },
  { id: 'parakeet-110m', label: 'Light', hint: 'About half the memory and quicker to load, with a few more mistakes.' }
];

/** Whether a model, and the voice-activity detector it needs, are downloaded. */
export function isInstalled(id) {
  try {
    modelDir(id);
    return fs.existsSync(VAD_MODEL);
  } catch {
    return false;
  }
}

/** The model to use for a setting: the one asked for if it's downloaded, else the best one that is. */
export function pickModel(wanted, installed = isInstalled) {
  if (SPEECH_CHOICES.some((choice) => choice.id === wanted) && installed(wanted)) return wanted;
  return SPEECH_CHOICES.find((choice) => installed(choice.id))?.id || null;
}

/** The model's folder, or an error naming the command that downloads it. */
export function modelDir(name) {
  const model = SPEECH_MODELS[name];
  if (!model) throw new Error(`Unknown speech model "${name}"`);
  const dir = path.join(MODELS_DIR, model.folder);
  if (!fs.existsSync(dir)) throw new Error(`Speech model "${name}" is missing; run: node scripts/fetch-models.mjs ${name}`);
  return dir;
}
