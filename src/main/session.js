'use strict';

const { EventEmitter } = require('events');
const { WhisperEngine, mergeOverlap } = require('./whisper');
const { SessionStore } = require('./storage');
const llm = require('./llm');

// Грубый «стемминг»: обрезаем слово до 5 символов, чтобы словоформы
// («перенесён» / «перенесли») считались одним и тем же словом.
function normWords(text) {
  return new Set(
    String(text)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => w.slice(0, 5))
  );
}

function similar(a, b) {
  const A = normWords(a);
  const B = normWords(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

class Session extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.engine = null;
    this.store = null;
    this.active = false;

    this.segments = [];       // {start, text, offset}
    this.transcript = '';     // плоский текст для LLM
    this.facts = [];
    this.factCursor = 0;
    this.extracting = false;
    this.startedAt = 0;
    this.pendingFactRun = false;
  }

  get id() {
    return this.store ? this.store.id : null;
  }

  get state() {
    return {
      id: this.id,
      active: this.active,
      title: this.store ? this.store.title : '',
      dir: this.store ? this.store.dir : '',
      startedAt: this.startedAt,
      segments: this.segments.length,
      facts: this.facts.length
    };
  }

  start(title) {
    if (this.active) throw new Error('Созвон уже идёт');
    const cfg = this.settings.get();
    this.store = new SessionStore(cfg.storage.dataDir, title);
    this.segments = [];
    this.transcript = '';
    this.facts = [];
    this.factCursor = 0;
    this.startedAt = Date.now();
    this.active = true;

    this.engine = new WhisperEngine(this.settings);
    this.engine.on('segment', (seg) => this._onSegment(seg));
    this.engine.on('error', (err) => this.emit('error', err.message || String(err)));
    this.engine.on('queue', (n) => this.emit('status', { queue: n }));
    this.engine.on('level', (rms) => this.emit('level', rms));

    this.emit('state', this.state);
    return this.state;
  }

  pushAudio(int16) {
    if (this.active && this.engine) this.engine.push(int16);
  }

  _onSegment(seg) {
    // Сравниваем только хвост — перекрытие никогда не длиннее пары сотен символов.
    const merged = mergeOverlap(this.transcript.slice(-400), seg.text);
    if (!merged.trim()) return;
    const entry = { start: seg.start, text: merged.trim(), offset: this.transcript.length };
    this.segments.push(entry);
    this.transcript = (this.transcript ? `${this.transcript} ` : '') + entry.text;
    this.store.appendTranscript(entry);
    this.emit('transcript', entry);
    this._maybeExtractFacts();
  }

  _windowStartSec(fromOffset) {
    for (const s of this.segments) {
      if (s.offset >= fromOffset) return s.start;
    }
    return this.segments.length ? this.segments[this.segments.length - 1].start : 0;
  }

  async _maybeExtractFacts(force = false) {
    const cfg = this.settings.get();
    if (!cfg.facts.enabled) return;
    if (this.extracting) {
      this.pendingFactRun = true;
      return;
    }
    const fresh = this.transcript.length - this.factCursor;
    if (!force && fresh < cfg.facts.windowChars) return;
    if (fresh < 80) return; // совсем крохи — не тратим запрос

    const from = Math.max(0, this.factCursor - cfg.facts.overlapChars);
    const windowText = this.transcript.slice(from);
    const at = this._windowStartSec(this.factCursor);
    this.factCursor = this.transcript.length;
    this.extracting = true;
    this.emit('status', { extracting: true });

    try {
      const found = await llm.extractFacts(cfg.llm, windowText, this.facts);
      const fresh_ = [];
      for (const f of found) {
        if (this.facts.some((old) => similar(old.text, f.text) >= 0.7)) continue;
        if (fresh_.some((n) => similar(n.text, f.text) >= 0.7)) continue;
        fresh_.push({ ...f, at });
      }
      if (fresh_.length) {
        this.facts.push(...fresh_);
        this.store.appendFacts(fresh_);
        this.emit('facts', fresh_);
      }
    } catch (err) {
      this.emit('error', `Извлечение фактов: ${err.message}`);
    } finally {
      this.extracting = false;
      this.emit('status', { extracting: false });
      if (this.pendingFactRun) {
        this.pendingFactRun = false;
        setImmediate(() => this._maybeExtractFacts());
      }
    }
  }

  /** Завершение: дорезать аудио, добить факты, сделать итоговую суммаризацию. */
  async stop({ summarize = true } = {}) {
    if (!this.active) throw new Error('Созвон не запущен');
    this.active = false;
    this.emit('status', { phase: 'Дораспознаю хвост аудио…' });
    try {
      await this.engine.flush();
    } catch (err) {
      this.emit('error', err.message);
    }
    this.engine.stop();
    this.engine = null;

    const durationSec = (Date.now() - this.startedAt) / 1000;

    if (this.settings.get().facts.enabled && this.transcript.length > this.factCursor) {
      this.emit('status', { phase: 'Добираю факты из хвоста…' });
      await this._maybeExtractFacts(true);
    }

    let summary = '';
    if (summarize && this.transcript.trim()) {
      this.emit('status', { phase: 'Собираю итоги созвона…' });
      try {
        const cfg = this.settings.get();
        summary = await llm.summarize(cfg.llm, {
          transcript: this.transcript,
          facts: this.facts,
          mapChunkChars: cfg.summary.mapChunkChars,
          basedOn: cfg.summary.basedOn
        });
        this.store.writeSummary(summary);
      } catch (err) {
        this.emit('error', `Суммаризация: ${err.message}`);
      }
    }

    this.store.finish(durationSec);
    this.emit('status', { phase: '' });
    const result = {
      id: this.store.id,
      dir: this.store.dir,
      title: this.store.title,
      summary,
      facts: this.facts.length,
      durationSec
    };
    this.emit('finished', result);
    this.emit('state', this.state);
    return result;
  }

  abort() {
    if (this.engine) this.engine.stop();
    this.engine = null;
    this.active = false;
    this.emit('state', this.state);
  }
}

module.exports = { Session };
