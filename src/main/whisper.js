'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, execFileSync } = require('child_process');

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 мс при 16 кГц

const { bundledWhisperBin, modelsDir } = require('./paths');
const { stripHallucinations, compileExtra } = require('./hallucinations');

const CANDIDATE_BINS = [
  'whisper-cli',
  'whisper-cpp',
  '/opt/homebrew/bin/whisper-cli',
  '/opt/homebrew/bin/whisper-cpp',
  '/usr/local/bin/whisper-cli',
  '/usr/local/bin/whisper-cpp',
  path.join(os.homedir(), 'whisper.cpp/build/bin/whisper-cli'),
  path.join(os.homedir(), 'whisper.cpp/main')
];

function resolveBinary(configured) {
  if (configured && configured.trim()) return configured.trim();
  const bundled = bundledWhisperBin(); // то, что поставил scripts/setup-whisper.js
  if (bundled) return bundled;
  for (const cand of CANDIDATE_BINS) {
    try {
      if (cand.includes('/')) {
        fs.accessSync(cand, fs.constants.X_OK);
        return cand;
      }
      execFileSync('which', [cand], { stdio: 'ignore' });
      return cand;
    } catch (_) { /* пробуем дальше */ }
  }
  return null;
}

function findModel(configured) {
  if (configured && configured.trim()) return configured.trim();
  const dirs = [
    modelsDir(), // скачанные из интерфейса
    path.join(os.homedir(), 'whisper.cpp/models'),
    path.join(os.homedir(), '.cache/whisper'),
    '/opt/homebrew/share/whisper-cpp/models'
  ];
  for (const d of dirs) {
    try {
      const f = fs.readdirSync(d).find((n) => /^ggml-.*\.bin$/.test(n));
      if (f) return path.join(d, f);
    } catch (_) { /* дальше */ }
  }
  return null;
}

function writeWav(file, int16) {
  const dataSize = int16.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // моно
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  Buffer.from(int16.buffer, int16.byteOffset, dataSize).copy(buf, 44);
  fs.writeFileSync(file, buf);
}

function concatInt16(parts, total) {
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Потоковый движок: принимает PCM 16 кГц mono int16, режет по паузам (VAD по RMS),
 * прогоняет куски через whisper.cpp с перекрытием и отдаёт события `segment`.
 */
class WhisperEngine extends EventEmitter {
  constructor(settings) {
    super();
    this.cfg = settings;
    this.reset();
  }

  reset() {
    this.frames = [];        // Int16Array по FRAME сэмплов
    this.frameLen = 0;
    this.leftover = new Int16Array(0);
    this.hasVoice = false;
    this.silence = 0;        // сэмплов тишины подряд
    this.totalSamples = 0;   // всего принято (для таймкодов)
    this.chunkStart = 0;     // индекс начала текущего куска
    this.tail = new Int16Array(0); // перекрытие с прошлого куска
    this.queue = [];
    this.busy = false;
    this.stopped = false;
    this.seq = 0;
  }

  get params() {
    const s = this.cfg.get().stream;
    return {
      min: Math.round(s.minChunkSec * SAMPLE_RATE),
      max: Math.round(s.maxChunkSec * SAMPLE_RATE),
      silenceNeed: Math.round((s.silenceMs / 1000) * SAMPLE_RATE),
      overlap: Math.round(s.overlapSec * SAMPLE_RATE),
      thr: s.vadThreshold
    };
  }

  /** @param {Int16Array} pcm */
  push(pcm) {
    if (this.stopped || !pcm || !pcm.length) return;
    let data = pcm;
    if (this.leftover.length) {
      const merged = new Int16Array(this.leftover.length + pcm.length);
      merged.set(this.leftover, 0);
      merged.set(pcm, this.leftover.length);
      data = merged;
    }
    const p = this.params;
    let i = 0;
    for (; i + FRAME <= data.length; i += FRAME) {
      const frame = data.subarray(i, i + FRAME);
      let sum = 0;
      for (let k = 0; k < FRAME; k++) {
        const v = frame[k] / 32768;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / FRAME);
      this.emit('level', rms);

      if (rms >= p.thr) {
        this.hasVoice = true;
        this.silence = 0;
      } else {
        this.silence += FRAME;
      }

      this.frames.push(new Int16Array(frame));
      this.frameLen += FRAME;
      this.totalSamples += FRAME;

      const longPause = this.hasVoice && this.silence >= p.silenceNeed && this.frameLen >= p.min;
      const tooLong = this.frameLen >= p.max;
      if (longPause || tooLong) this._cut(); // при отсутствии речи _cut сам выбросит кусок
    }
    this.leftover = data.subarray(i).slice();
  }

  _drop() {
    // Кусок из чистой тишины — не гоняем модель впустую.
    this.frames = [];
    this.frameLen = 0;
    this.silence = 0;
    this.hasVoice = false;
    this.chunkStart = this.totalSamples;
  }

  _cut() {
    if (!this.frameLen) return;
    if (!this.hasVoice) return this._drop(); // в куске нет речи — модель не запускаем

    const body = concatInt16(this.frames, this.frameLen);
    const p = this.params;
    const prevTailLen = this.tail.length;
    const audio = prevTailLen ? concatInt16([this.tail, body], prevTailLen + body.length) : body;

    this.tail = body.length > p.overlap ? body.slice(body.length - p.overlap) : body.slice();

    const startSec = Math.max(0, (this.chunkStart - prevTailLen) / SAMPLE_RATE);
    this.chunkStart = this.totalSamples;
    this.frames = [];
    this.frameLen = 0;
    this.silence = 0;
    this.hasVoice = false;

    if (audio.length < SAMPLE_RATE) return; // < 1 c — whisper на таком бесполезен
    this.queue.push({ audio, startSec, seq: this.seq++ });
    this.emit('queue', this.queue.length);
    this._drain();
  }

  /** Дорезать хвост (конец созвона) и дождаться очереди. */
  async flush() {
    this._cut();
    while (this.queue.length || this.busy) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  stop() {
    this.stopped = true;
    if (this.proc) {
      try { this.proc.kill(); } catch (_) { /* уже мёртв */ }
    }
    this.queue = [];
  }

  async _drain() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    const job = this.queue.shift();
    try {
      const text = await this._transcribe(job.audio);
      if (text && text.trim()) {
        this.emit('segment', { text: text.trim(), start: job.startSec, seq: job.seq });
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.busy = false;
      this.emit('queue', this.queue.length);
      if (this.queue.length) setImmediate(() => this._drain());
    }
  }

  _transcribe(audio) {
    return new Promise((resolve, reject) => {
      const cfg = this.cfg.get().whisper;
      const bin = resolveBinary(cfg.binPath);
      const model = findModel(cfg.modelPath);
      if (!bin) return reject(new Error('Не найден бинарь whisper.cpp (whisper-cli). Укажи путь в настройках.'));
      if (!model) return reject(new Error('Не найдена модель ggml-*.bin. Укажи путь в настройках.'));

      const base = path.join(os.tmpdir(), `pizdun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const wav = `${base}.wav`;
      writeWav(wav, audio);

      const args = [
        '-m', model,
        '-f', wav,
        '-t', String(cfg.threads || 4),
        '-oj', '-of', base,
        '-np', '-nt'
      ];
      if (cfg.language && cfg.language !== 'auto') args.push('-l', cfg.language);
      else args.push('-l', 'auto');
      if (cfg.extraArgs && cfg.extraArgs.trim()) args.push(...cfg.extraArgs.trim().split(/\s+/));

      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc = proc;
      let stderr = '';
      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('error', (e) => {
        this.proc = null;
        cleanup();
        reject(new Error(`Не удалось запустить ${bin}: ${e.message}`));
      });

      const cleanup = () => {
        for (const f of [wav, `${base}.json`]) {
          try { fs.unlinkSync(f); } catch (_) { /* нет файла — ок */ }
        }
      };

      proc.on('close', (code) => {
        this.proc = null;
        if (code !== 0) {
          cleanup();
          return reject(new Error(`whisper.cpp завершился с кодом ${code}: ${stderr.slice(-400)}`));
        }
        let text = '';
        try {
          const json = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
          text = (json.transcription || []).map((s) => s.text).join(' ');
        } catch (_) {
          text = stdout; // fallback: whisper напечатал текст в stdout
        }
        cleanup();
        resolve(cleanText(text, cfg.extraHallucinations));
      });
    });
  }
}

const NOISE_RE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;

function cleanText(text, extraHallucinations = '') {
  const withoutNoise = String(text || '')
    .replace(NOISE_RE, ' ')      // [музыка], (смех), *тишина*
    .replace(/\s+/g, ' ')
    .trim();
  // На тишине whisper любит дописывать титры роликов — вычищаем их.
  return stripHallucinations(withoutNoise, compileExtra(extraHallucinations));
}

/**
 * Нормализация слова для сравнения перекрытий: whisper на границе куска
 * слышит слово иначе («шлюзом» / «шлюзы»), поэтому сравниваем огрызки основ.
 */
function normWord(w) {
  const clean = w.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');
  return clean.length > 4 ? clean.slice(0, 4) : clean;
}

/**
 * Склейка кусков с перекрытием.
 *
 * В зоне перекрытия распознавание расходится, поэтому ищем не точное совпадение,
 * а лучшее выравнивание: хвост из k слов накопленного текста сопоставляем с окном
 * нового куска, начинающимся со сдвигом i (первые слова нового куска часто мусорные —
 * это обрубок фразы из перекрытия). Срезаем всё до конца найденного совпадения.
 */
function mergeOverlap(prev, next, maxWords = 12, maxShift = 4) {
  if (!prev) return next;
  if (!next) return '';
  const prevWords = prev.trim().split(/\s+/).map(normWord).filter(Boolean);
  const nextRaw = next.trim().split(/\s+/);
  const nextWords = nextRaw.map(normWord);
  if (!prevWords.length || !nextRaw.length) return next;

  let best = null;
  const maxK = Math.min(maxWords, prevWords.length);
  for (let k = maxK; k >= 2; k--) {
    const tail = prevWords.slice(prevWords.length - k);
    for (let i = 0; i <= Math.min(maxShift, Math.max(0, nextRaw.length - k)); i++) {
      const window = nextWords.slice(i, i + k);
      if (window.length < k) continue;
      let hits = 0;
      for (let j = 0; j < k; j++) if (window[j] && window[j] === tail[j]) hits++;
      const score = hits / k;
      // Короткие совпадения принимаем только точные, длинные — с допуском на ослышки.
      const need = k === 2 ? 1 : 0.6;
      if (score < need) continue;
      const weight = k * score;
      if (!best || weight > best.weight) best = { weight, cut: i + k };
    }
    if (best && best.weight >= k * 0.9) break; // уверенное совпадение — дальше не ищем
  }
  return best ? nextRaw.slice(best.cut).join(' ') : next;
}

module.exports = { WhisperEngine, mergeOverlap, resolveBinary, findModel, SAMPLE_RATE };
