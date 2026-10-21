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
  // NVIDIA Parakeet TDT 110M, int8. A transducer, so it takes hotwords.
  'parakeet-110m': {
    kind: 'offline',
    folder: 'sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8',
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
  },
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

/** The model's folder, or an error naming the command that downloads it. */
export function modelDir(name) {
  const model = SPEECH_MODELS[name];
  if (!model) throw new Error(`Unknown speech model "${name}"`);
  const dir = path.join(MODELS_DIR, model.folder);
  if (!fs.existsSync(dir)) throw new Error(`Speech model "${name}" is missing; run: node scripts/fetch-models.mjs ${name}`);
  return dir;
}
