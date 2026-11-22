const { app, BrowserWindow } = require('electron');
app.setActivationPolicy?.('accessory');
app.whenReady().then(() => {
  const win = new BrowserWindow({ x: 320, y: 220, width: 460, height: 320, show: false, title: 'efix', webPreferences: { backgroundThrottling: false } });
  win.loadFile(__dirname + '/page.html');
  win.on('page-title-updated', () => undefined);
  win.once('ready-to-show', () => { win.showInactive(); if (process.argv.includes('back')) { /* stays where shown; other windows may cover it */ } console.log('pid ' + process.pid); });
  setTimeout(() => app.quit(), Number(process.argv.find((arg) => /^\d+$/.test(arg)) || 30) * 1000);
});
app.on('window-all-closed', () => app.quit());
