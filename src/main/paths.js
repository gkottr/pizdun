'use strict';

const path = require('path');
const fs = require('fs');

// Модуль обязан работать и вне Electron (в тестах): вне рантайма Electron
// require('electron') отдаёт строку с путём, а не объект с app.
let app = null;
try {
  const electron = require('electron');
  app = electron && electron.app ? electron.app : null;
} catch (_) {
  app = null;
}

const { TAG, EXE } = require('./platform');

const ROOT = path.join(__dirname, '..', '..');

/** Где искать whisper-cli: сначала в упакованных ресурсах, потом в vendor/ репозитория. */
function whisperBinDirs() {
  const dirs = [];
  if (app && app.isPackaged) {
    dirs.push(path.join(process.resourcesPath, 'whisper'));
    dirs.push(path.join(process.resourcesPath, 'whisper', TAG));
  }
  dirs.push(path.join(ROOT, 'vendor', 'bin', TAG));
  return dirs;
}

function bundledWhisperBin() {
  for (const dir of whisperBinDirs()) {
    const bin = path.join(dir, `whisper-cli${EXE}`);
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return bin;
    } catch (_) { /* дальше */ }
  }
  return null;
}

/** Куда качаются модели ggml. */
function modelsDir() {
  const dir = app
    ? path.join(app.getPath('userData'), 'models')
    : path.join(ROOT, 'vendor', 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { ROOT, TAG, EXE, whisperBinDirs, bundledWhisperBin, modelsDir };
