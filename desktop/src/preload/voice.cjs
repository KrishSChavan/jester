// The voice page's whole connection to the app (src/voice/voice.js): audio from
// the mic out, sounds to play in. It isn't given the chrome shim the other pages
// get, having no use for settings, messages or anything else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jesterVoice', {
  audio: (samples) => ipcRenderer.send('jester:listen-audio', samples),
  status: (report) => ipcRenderer.send('jester:voice-status', report),
  onPlay: (fn) => void ipcRenderer.on('jester:voice-play', (_event, sound) => fn(sound))
});
