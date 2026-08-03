'use strict';

const fs = require('fs');
const path = require('path');

const storage = require('./storage');
const llm = require('./llm');

/**
 * Пересборка итогов для уже сохранённого созвона.
 *
 * Исходники берём из markdown-файлов папки, а не из памяти: это работает
 * и для созвонов из прошлых запусков приложения, и для файлов, которые
 * пользователь правил руками.
 */
async function resummarize(dir, cfg, client = llm) {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (_) {
      return '';
    }
  };

  const meta = storage.parseFrontmatter(read('index.md'));
  const title = meta.title || path.basename(dir);
  const transcript = storage.parseTranscriptMd(read('transcript.md'));
  const facts = storage.parseFactsMd(read('facts.md'));

  if (!transcript && !facts.length) {
    throw new Error('В этом созвоне нет ни расшифровки, ни фактов — пересобирать нечего');
  }

  const summary = await client.summarize(cfg.llm, {
    transcript,
    facts,
    mapChunkChars: cfg.summary.mapChunkChars,
    basedOn: cfg.summary.basedOn
  });

  storage.writeSummaryTo(dir, title, summary);
  return { dir, title, summary };
}

module.exports = { resummarize };
