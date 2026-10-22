/**
 * The mic, for speech, on the audio thread. The engine page's main thread
 * also runs the camera's hand and face tracking, and a script processor
 * there drops audio when its callback runs late; from here, audio only
 * queues while the page is busy.
 *
 * Posts CHUNK samples at a time (128 ms at 16 kHz), as the recognizer takes them.
 */

const CHUNK = 2048;

class SpeechCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    for (let at = 0; channel && at < channel.length; ) {
      const count = Math.min(channel.length - at, CHUNK - this.filled);
      this.chunk.set(channel.subarray(at, at + count), this.filled);
      this.filled += count;
      at += count;
      if (this.filled === CHUNK) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(CHUNK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('jester-speech-capture', SpeechCapture);
