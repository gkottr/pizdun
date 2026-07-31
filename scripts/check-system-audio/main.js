const { app, BrowserWindow, desktopCapturer, systemPreferences } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const arg = (name, def) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : def;
};
const MODE = arg('mode', 'nopicker');

app.whenReady().then(async () => {
  const out = (m) => process.stdout.write(`${m}\n`);
  out(`RESULT screen-access: ${systemPreferences.getMediaAccessStatus('screen')}`);
  out(`RESULT mic-access: ${systemPreferences.getMediaAccessStatus('microphone')}`);
  out(`RESULT versions: electron=${process.versions.electron} chromium=${process.versions.chrome}`);
  out(`RESULT mode: ${MODE}`);

  const win = new BrowserWindow({
    width: 520,
    height: 320,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    out('RESULT handler-called: true');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    callback({ video: sources[0], audio: 'loopback' });
  }, MODE === 'picker' ? { useSystemPicker: true } : undefined);

  win.webContents.on('console-message', (_e, _l, msg) => {
    out(msg);
    if (msg.includes('verdict')) setTimeout(() => app.exit(0), 300);
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  const wav = arg('wav', null);
  if (wav) spawn('afplay', [wav], { detached: true, stdio: 'ignore' });

  setTimeout(() => {
    out('RESULT verdict: ТАЙМАУТ (ничего не произошло)');
    app.exit(2);
  }, 25000);
});
