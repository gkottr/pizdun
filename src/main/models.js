'use strict';

const fs = require('fs');
const path = require('path');
const { modelsDir } = require('./paths');

const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

// Каталог моделей ggml. size — примерный размер файла в МБ (для UI).
const CATALOG = [
  { id: 'tiny-q5_1', size: 31, langs: 'multi', quality: 'черновое', note: 'самая быстрая, для слабого железа' },
  { id: 'tiny', size: 75, langs: 'multi', quality: 'черновое' },
  { id: 'base-q5_1', size: 57, langs: 'multi', quality: 'слабое' },
  { id: 'base', size: 142, langs: 'multi', quality: 'слабое' },
  { id: 'small-q5_1', size: 181, langs: 'multi', quality: 'среднее', note: 'разумный минимум для русского' },
  { id: 'small', size: 466, langs: 'multi', quality: 'среднее' },
  { id: 'medium-q5_0', size: 514, langs: 'multi', quality: 'хорошее', note: 'хороший баланс' },
  { id: 'medium', size: 1530, langs: 'multi', quality: 'хорошее' },
  { id: 'large-v3-turbo-q5_0', size: 574, langs: 'multi', quality: 'отличное', note: 'рекомендуется: быстрая и точная', recommended: true },
  { id: 'large-v3-turbo', size: 1620, langs: 'multi', quality: 'отличное' },
  { id: 'large-v3-q5_0', size: 1080, langs: 'multi', quality: 'максимальное' },
  { id: 'large-v3', size: 3100, langs: 'multi', quality: 'максимальное', note: 'самая тяжёлая' },
  { id: 'tiny.en', size: 75, langs: 'en', quality: 'черновое' },
  { id: 'base.en', size: 142, langs: 'en', quality: 'слабое' },
  { id: 'small.en', size: 466, langs: 'en', quality: 'среднее' },
  { id: 'medium.en', size: 1530, langs: 'en', quality: 'хорошее' }
];

const fileName = (id) => `ggml-${id}.bin`;
const modelPath = (id) => path.join(modelsDir(), fileName(id));
const url = (id) => `${HF_BASE}/${fileName(id)}`;

/** Файл модели ggml начинается с магии 0x67676d6c. */
function looksLikeModel(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const s = buf.toString('binary');
    return s === 'lmgg' || s === 'ggml';
  } catch (_) {
    return false;
  }
}

function list() {
  const dir = modelsDir();
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(dir).filter((n) => n.endsWith('.bin'));
  } catch (_) { /* пусто */ }

  const items = CATALOG.map((m) => {
    const file = path.join(dir, fileName(m.id));
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch (_) { /* не скачана */ }
    return { ...m, file, downloaded: bytes > 0, bytes };
  });

  // Модели, положенные пользователем руками.
  const known = new Set(CATALOG.map((m) => fileName(m.id)));
  for (const name of onDisk) {
    if (known.has(name)) continue;
    const file = path.join(dir, name);
    items.push({
      id: name.replace(/^ggml-|\.bin$/g, ''),
      size: Math.round(fs.statSync(file).size / 1048576),
      langs: '—',
      quality: 'своя',
      custom: true,
      file,
      downloaded: true,
      bytes: fs.statSync(file).size
    });
  }
  return items;
}

const active = new Map(); // id -> AbortController

/**
 * Качает модель в userData/models. Прогресс отдаётся колбэком.
 * Файл пишется во временный .part и переименовывается только после проверки.
 */
async function download(id, onProgress) {
  const entry = CATALOG.find((m) => m.id === id);
  if (!entry) throw new Error(`Неизвестная модель: ${id}`);
  const dest = modelPath(id);
  if (fs.existsSync(dest) && looksLikeModel(dest)) return dest;
  if (active.has(id)) throw new Error('Эта модель уже качается');

  const tmp = `${dest}.part`;
  const controller = new AbortController();
  active.set(id, controller);

  try {
    const res = await fetch(url(id), { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке ${fileName(id)}`);
    const total = Number(res.headers.get('content-length') || 0) || entry.size * 1048576;

    const out = fs.createWriteStream(tmp);
    let got = 0;
    let last = 0;
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - last > 300) {
        last = now;
        onProgress && onProgress({ id, got, total, percent: total ? got / total : 0 });
      }
    }
    await new Promise((r) => out.end(r));

    if (!looksLikeModel(tmp)) throw new Error('Скачался не файл модели (проверь URL/прокси)');
    fs.renameSync(tmp, dest);
    onProgress && onProgress({ id, got, total, percent: 1, done: true });
    return dest;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* нечего убирать */ }
    if (err.name === 'AbortError') throw new Error('Загрузка отменена');
    throw err;
  } finally {
    active.delete(id);
  }
}

function cancel(id) {
  const c = active.get(id);
  if (c) c.abort();
  return !!c;
}

function remove(id) {
  const file = modelPath(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

module.exports = { list, download, cancel, remove, modelPath, modelsDir, CATALOG, looksLikeModel };
