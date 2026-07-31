'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, desktopCapturer, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

const { Settings } = require('./src/main/settings');
const { Session } = require('./src/main/session');
const storage = require('./src/main/storage');
const whisper = require('./src/main/whisper');
const llm = require('./src/main/llm');
const models = require('./src/main/models');
const systemAudio = require('./src/main/system-audio');

let win = null;
let settings = null;
let session = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#12141a',
    title: 'Созвон — расшифровка и итоги',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  const ses = win.webContents.session;

  // Микрофон и захват экрана нужны для записи созвона.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'audioCapture', 'display-capture'].includes(permission));
  });

  // Системный звук берём через loopback: Chromium умеет это на Windows,
  // а на macOS 13+ — через ScreenCaptureKit. Системный пикер НЕ включаем:
  // с ним аудиоисточник выбирает ОС и loopback до нас не доезжает.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback({}));
  });

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' });
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
  }
}

function wireSession() {
  session = new Session(settings);
  session.on('transcript', (e) => send('evt:transcript', e));
  session.on('facts', (f) => send('evt:facts', f));
  session.on('status', (s) => send('evt:status', s));
  session.on('error', (m) => send('evt:error', m));
  session.on('level', (l) => send('evt:level', l));
  session.on('state', (s) => send('evt:state', s));
  session.on('finished', (r) => send('evt:finished', r));
}

// Самодиагностика прямо в бандле: важно проверять доступ именно от имени
// собранного приложения — TCC различает Electron из dev и Pizdun.app.
async function runAudioCheck() {
  const lines = [];
  const say = (m) => { lines.push(m); process.stdout.write(`${m}\n`); };

  say(`процесс: ${process.execPath}`);
  say(`упаковано: ${app.isPackaged}`);
  say(`screen-access ДО запроса: ${systemPreferences.getMediaAccessStatus('screen')}`);
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    say(`источников экрана видно: ${sources.length}`);
  } catch (err) {
    say(`getSources упал: ${err.message}`);
  }
  say(`screen-access ПОСЛЕ getSources: ${systemPreferences.getMediaAccessStatus('screen')}`);

  // Главное: боевой путь через окно. Именно getDisplayMedia заставляет macOS
  // показать запрос — desktopCapturer при отказе просто падает и молчит.
  const probe = new BrowserWindow({ width: 460, height: 260, webPreferences: { contextIsolation: true } });
  probe.webContents.session.setPermissionRequestHandler((_w, _p, cb) => cb(true));
  probe.webContents.session.setDisplayMediaRequestHandler((_req, callback) => {
    say('handler захвата вызван');
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch((err) => { say(`источники недоступны: ${err.message}`); callback({}); });
  });

  await new Promise((resolve) => {
    probe.webContents.on('console-message', (_e, _l, msg) => {
      say(msg);
      if (msg.startsWith('ИТОГ')) resolve();
    });
    probe.loadFile(path.join(__dirname, 'src', 'renderer', 'audio-check.html'));
    setTimeout(resolve, 20000);
  });

  say(`screen-access В КОНЦЕ: ${systemPreferences.getMediaAccessStatus('screen')}`);

  // При запуске через LaunchServices (двойной клик, `open`) stdout не виден,
  // поэтому дублируем отчёт в файл.
  const outArg = process.argv.find((a) => a.startsWith('--check-out='));
  const file = outArg ? outArg.split('=')[1] : path.join(require('os').tmpdir(), 'pizdun-audio-check.txt');
  try {
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    process.stdout.write(`отчёт: ${file}\n`);
  } catch (_) { /* не смогли — не страшно */ }
  app.exit(0);
}

app.whenReady().then(() => {
  if (process.argv.includes('--check-audio')) return runAudioCheck();

  settings = new Settings(app.getPath('userData'));
  fs.mkdirSync(settings.get().storage.dataDir, { recursive: true });
  wireSession();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (session) session.abort();
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------

ipcMain.handle('settings:get', () => settings.get());

ipcMain.handle('settings:update', (_e, patch) => {
  const next = settings.update(patch);
  fs.mkdirSync(next.storage.dataDir, { recursive: true });
  return next;
});

ipcMain.handle('settings:detectWhisper', () => {
  const cfg = settings.get().whisper;
  return {
    bin: whisper.resolveBinary(cfg.binPath),
    model: whisper.findModel(cfg.modelPath)
  };
});

ipcMain.handle('dialog:pickFile', async (_e, { title, filters }) => {
  const res = await dialog.showOpenDialog(win, {
    title,
    properties: ['openFile'],
    filters: filters || []
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('dialog:pickDir', async (_e, { title }) => {
  const res = await dialog.showOpenDialog(win, {
    title,
    properties: ['openDirectory', 'createDirectory']
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('llm:test', async () => llm.testConnection(settings.get().llm));
ipcMain.handle('llm:models', async () => llm.listModels(settings.get().llm));

ipcMain.handle('session:start', (_e, title) => session.start(title));

ipcMain.handle('session:stop', async (_e, opts) => session.stop(opts || {}));

ipcMain.handle('session:state', () => session.state);

ipcMain.handle('session:resummarize', async () => session.resummarize());

ipcMain.on('audio:chunk', (_e, buffer) => {
  if (!session || !session.active) return;
  const int16 = new Int16Array(buffer.buffer || buffer, buffer.byteOffset || 0, (buffer.byteLength || buffer.length) / 2);
  session.pushAudio(int16);
});

// ---------- системный звук ----------

ipcMain.handle('audio:systemStatus', () =>
  systemAudio.status((media) => systemPreferences.getMediaAccessStatus(media)));

// Прямой триггер запроса TCC: обращение к источникам экрана заставляет macOS
// показать диалог и добавить приложение в список «Запись экрана и системного звука».
ipcMain.handle('audio:requestScreenAccess', async () => {
  const before = systemPreferences.getMediaAccessStatus('screen');
  try {
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch (err) {
    return { before, after: systemPreferences.getMediaAccessStatus('screen'), error: err.message };
  }
  return { before, after: systemPreferences.getMediaAccessStatus('screen') };
});

// Сброс TCC-записи: без него macOS не покажет запрос повторно.
ipcMain.handle('audio:resetScreenAccess', () => {
  const bundleId = systemAudio.bundleIdentifier();
  const res = systemAudio.resetScreenAccess(bundleId);
  return { ...res, status: systemPreferences.getMediaAccessStatus('screen') };
});

ipcMain.handle('audio:openScreenSettings', async () => {
  if (process.platform !== 'darwin') return false;
  await shell.openExternal(systemAudio.SCREEN_SETTINGS_URL);
  return true;
});

// ---------- модели whisper ----------

ipcMain.handle('models:list', () => ({
  items: models.list(),
  dir: models.modelsDir(),
  selected: settings.get().whisper.modelPath
}));

ipcMain.handle('models:download', async (_e, id) => {
  const file = await models.download(id, (p) => send('evt:modelProgress', p));
  // Скачали — сразу делаем её активной.
  settings.update({ whisper: { modelPath: file } });
  return file;
});

ipcMain.handle('models:cancel', (_e, id) => models.cancel(id));
ipcMain.handle('models:remove', (_e, id) => {
  const file = models.modelPath(id);
  const removed = models.remove(id);
  if (removed && settings.get().whisper.modelPath === file) {
    settings.update({ whisper: { modelPath: '' } });
  }
  return removed;
});

ipcMain.handle('models:select', (_e, file) => {
  settings.update({ whisper: { modelPath: file } });
  return settings.get().whisper.modelPath;
});

ipcMain.handle('sessions:list', () => storage.listSessions(settings.get().storage.dataDir));
ipcMain.handle('sessions:read', (_e, dir) => storage.readSession(dir));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
