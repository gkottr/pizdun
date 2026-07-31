'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  // --- LLM (OpenAI-совместимый API) ---
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: 2048,
    timeoutMs: 120000
  },

  // --- whisper.cpp ---
  whisper: {
    binPath: '',           // путь к whisper-cli (пусто => автодетект)
    modelPath: '',         // путь к ggml-*.bin
    language: 'ru',        // 'auto' для автоопределения
    threads: Math.max(2, Math.min(8, os.cpus().length - 1)),
    extraArgs: '',         // например: "-bs 5 --suppress-nst"
    extraHallucinations: '' // свои фразы-галлюцинации, по одной на строку
  },

  // --- потоковая сегментация аудио ---
  stream: {
    minChunkSec: 3,        // не резать короче
    maxChunkSec: 14,       // жёсткий предел длины куска
    silenceMs: 700,        // пауза, по которой режем
    overlapSec: 1.0,       // перекрытие аудио между кусками
    vadThreshold: 0.012    // порог RMS (0..1)
  },

  // --- извлечение фактов на лету ---
  facts: {
    enabled: true,
    windowChars: 1600,     // сколько нового текста накопить перед запросом
    overlapChars: 400,     // перекрытие с предыдущим окном
    minChunkSec: 0         // резерв
  },

  // --- суммаризация ---
  summary: {
    mapChunkChars: 12000,  // размер куска при map-reduce
    basedOn: 'both'        // 'facts' | 'transcript' | 'both'
  },

  // --- хранилище ---
  storage: {
    dataDir: path.join(os.homedir(), 'Documents', 'Созвоны')
  },

  ui: {
    autoScroll: true
  }
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (typeof base !== 'object' || Array.isArray(base) || base === null) return override;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(override)) {
    out[key] = deepMerge(base[key], override[key]);
  }
  return out;
}

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.data = this._read();
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return deepMerge(DEFAULTS, JSON.parse(raw));
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  get() {
    return this.data;
  }

  update(patch) {
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

module.exports = { Settings, DEFAULTS };
