'use strict';

const fs = require('fs');
const path = require('path');

// Всё хранится в markdown. Одна папка = один созвон:
//   index.md      — метаданные (YAML frontmatter) + ссылки
//   transcript.md — расшифровка (дописывается на лету)
//   facts.md      — факты (дописываются на лету)
//   summary.md    — итоговая суммаризация (после созвона)

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function slugify(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'pizdun';
}

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fmtStamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function escapeYaml(value) {
  return String(value == null ? '' : value).replace(/"/g, '\\"');
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"');
    out[kv[1]] = v;
  }
  return out;
}

class SessionStore {
  constructor(dataDir, title) {
    this.dataDir = dataDir;
    this.startedAt = new Date();
    this.title = title && title.trim() ? title.trim() : `Созвон ${this.startedAt.toLocaleString('ru-RU')}`;
    this.id = `${fmtStamp(this.startedAt)}_${slugify(title)}`;
    this.dir = path.join(dataDir, this.id);

    fs.mkdirSync(this.dir, { recursive: true });

    this.transcriptFile = path.join(this.dir, 'transcript.md');
    this.factsFile = path.join(this.dir, 'facts.md');
    this.summaryFile = path.join(this.dir, 'summary.md');
    this.indexFile = path.join(this.dir, 'index.md');

    fs.writeFileSync(this.transcriptFile, `# Расшифровка — ${this.title}\n\n`, 'utf8');
    fs.writeFileSync(this.factsFile, `# Факты — ${this.title}\n\n`, 'utf8');
    this.writeIndex({ status: 'recording' });
  }

  writeIndex(extra = {}) {
    const meta = {
      title: this.title,
      id: this.id,
      started: this.startedAt.toISOString(),
      ended: extra.ended || '',
      duration: extra.duration || '',
      status: extra.status || 'recording'
    };
    const fm = Object.entries(meta)
      .map(([k, v]) => `${k}: "${escapeYaml(v)}"`)
      .join('\n');
    const body = [
      '---',
      fm,
      '---',
      '',
      `# ${this.title}`,
      '',
      `- Начало: ${this.startedAt.toLocaleString('ru-RU')}`,
      meta.ended ? `- Конец: ${new Date(meta.ended).toLocaleString('ru-RU')}` : '',
      meta.duration ? `- Длительность: ${meta.duration}` : '',
      '',
      '## Файлы',
      '',
      '- [Итоги](./summary.md)',
      '- [Факты](./facts.md)',
      '- [Расшифровка](./transcript.md)',
      ''
    ].filter((l) => l !== '').join('\n');
    fs.writeFileSync(this.indexFile, body + '\n', 'utf8');
  }

  appendTranscript(entry) {
    const line = `**[${fmtClock(entry.start)}]** ${entry.text.trim()}\n\n`;
    fs.appendFileSync(this.transcriptFile, line, 'utf8');
  }

  appendFacts(facts) {
    if (!facts.length) return;
    const chunk = facts
      .map((f) => `- \`${fmtClock(f.at)}\` **[${f.category || 'факт'}]** ${f.text}`)
      .join('\n');
    fs.appendFileSync(this.factsFile, chunk + '\n', 'utf8');
  }

  writeSummary(markdown) {
    fs.writeFileSync(this.summaryFile, `# Итоги — ${this.title}\n\n${markdown.trim()}\n`, 'utf8');
  }

  readTranscriptText() {
    try {
      return fs.readFileSync(this.transcriptFile, 'utf8');
    } catch (_) {
      return '';
    }
  }

  finish(durationSec) {
    this.writeIndex({
      status: 'done',
      ended: new Date().toISOString(),
      duration: fmtClock(durationSec)
    });
  }
}

function listSessions(dataDir) {
  let names = [];
  try {
    names = fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (_) {
    return [];
  }
  const items = [];
  for (const name of names) {
    const indexFile = path.join(dataDir, name, 'index.md');
    let meta = {};
    try {
      meta = parseFrontmatter(fs.readFileSync(indexFile, 'utf8'));
    } catch (_) {
      continue;
    }
    items.push({
      id: meta.id || name,
      dir: path.join(dataDir, name),
      title: meta.title || name,
      started: meta.started || '',
      ended: meta.ended || '',
      duration: meta.duration || '',
      status: meta.status || '',
      hasSummary: fs.existsSync(path.join(dataDir, name, 'summary.md'))
    });
  }
  items.sort((a, b) => String(b.started).localeCompare(String(a.started)));
  return items;
}

function readSession(dir) {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch (_) {
      return '';
    }
  };
  return {
    dir,
    index: read('index.md'),
    summary: read('summary.md'),
    facts: read('facts.md'),
    transcript: read('transcript.md')
  };
}

/** Расшифровка из markdown обратно в плоский текст для LLM. */
function parseTranscriptMd(md) {
  return String(md || '')
    .split(/\r?\n/)
    .map((line) => {
      const m = /^\*\*\[\d{2}:\d{2}:\d{2}\]\*\*\s*(.*)$/.exec(line.trim());
      return m ? m[1].trim() : '';
    })
    .filter(Boolean)
    .join(' ');
}

/** Факты из markdown обратно в объекты. */
function parseFactsMd(md) {
  const out = [];
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = /^-\s*`(\d{2}):(\d{2}):(\d{2})`\s*\*\*\[([^\]]*)\]\*\*\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    out.push({
      at: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]),
      category: m[4].trim(),
      text: m[5].trim(),
      who: ''
    });
  }
  return out;
}

/** Записать итоги в готовую папку созвона (для пересборки архивных). */
function writeSummaryTo(dir, title, markdown) {
  fs.writeFileSync(path.join(dir, 'summary.md'), `# Итоги — ${title}\n\n${String(markdown).trim()}\n`, 'utf8');
}

module.exports = {
  SessionStore,
  listSessions,
  readSession,
  parseTranscriptMd,
  parseFactsMd,
  writeSummaryTo,
  parseFrontmatter,
  fmtClock,
  slugify
};
