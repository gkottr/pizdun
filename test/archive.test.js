// Пересборка итогов для архивных созвонов и параллельная финализация:
// новый созвон должен стартовать, пока предыдущий ещё досуммаризовывается.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const storage = require('../src/main/storage');
const archive = require('../src/main/archive');
const { Session } = require('../src/main/session');
const { DEFAULTS } = require('../src/main/settings');

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- разбор markdown обратно в данные
const store0 = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pizdun-parse-'));
  const s = new storage.SessionStore(dir, 'Разбор');
  s.appendTranscript({ start: 5, text: 'Первая реплика' });
  s.appendTranscript({ start: 3725, text: 'Вторая реплика' });
  s.appendFacts([{ at: 65, category: 'решение', text: 'Релиз в пятницу' }]);
  return { dir, s };
})();

const transcript = storage.parseTranscriptMd(fs.readFileSync(store0.s.transcriptFile, 'utf8'));
ok('расшифровка читается обратно из markdown',
  transcript === 'Первая реплика Вторая реплика', JSON.stringify(transcript));
ok('заголовок файла в текст не попадает', !transcript.includes('Расшифровка'));

const facts = storage.parseFactsMd(fs.readFileSync(store0.s.factsFile, 'utf8'));
ok('факты читаются обратно с таймкодом и категорией',
  facts.length === 1 && facts[0].at === 65 && facts[0].category === 'решение' && facts[0].text === 'Релиз в пятницу',
  JSON.stringify(facts));

// --- пересборка архивного созвона
(async () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let seenPrompt = '';
  const fakeLlm = {
    summarize: async (_llmCfg, { transcript: t, facts: f }) => {
      seenPrompt = `${t}|${f.map((x) => x.text).join(',')}`;
      return '## Краткое резюме\nПересобрано.';
    }
  };

  const res = await archive.resummarize(store0.s.dir, cfg, fakeLlm);
  ok('пересборка вернула название из index.md', res.title === 'Разбор', res.title);
  ok('в LLM ушли и расшифровка, и факты',
    seenPrompt.includes('Первая реплика') && seenPrompt.includes('Релиз в пятницу'), seenPrompt);
  ok('summary.md перезаписан',
    fs.readFileSync(path.join(store0.s.dir, 'summary.md'), 'utf8').includes('Пересобрано'));

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pizdun-empty-'));
  let refused = false;
  try {
    await archive.resummarize(empty, cfg, fakeLlm);
  } catch (err) {
    refused = /нечего/.test(err.message);
  }
  ok('пустой созвон пересобирать отказывается', refused);
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(store0.dir, { recursive: true, force: true });

  // --- параллельная работа: пока А досуммаризовывается, Б уже пишется
  const srv = http.createServer((req, res2) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const j = JSON.parse(body);
      const user = j.messages.at(-1).content;
      const isFacts = j.messages[0].content.includes('вычленяет фактуру');
      // Суммаризация отвечает медленно — как настоящая на длинном созвоне.
      if (!isFacts) await sleep(400);
      const content = isFacts
        ? '[]'
        : `## Краткое резюме\nИсходник: ${(/Обсудили\s+\S+/.exec(user) || ['?'])[0]}`;
      res2.writeHead(200, { 'Content-Type': 'application/json' });
      res2.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
  });

  await new Promise((r) => srv.listen(45998, r));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pizdun-parallel-'));
  const cfg2 = JSON.parse(JSON.stringify(DEFAULTS));
  cfg2.llm.baseUrl = 'http://127.0.0.1:45998/v1';
  cfg2.storage.dataDir = dataDir;
  cfg2.facts.enabled = false; // здесь проверяем именно итоги
  const settings = { get: () => cfg2 };

  const mkSession = (title, text) => {
    const s = new Session(settings);
    s.on('error', (m) => console.log('  [ошибка]', m));
    s.start(title);
    s.engine.stop();
    s.engine = { flush: async () => sleep(50), stop: () => {} };
    s.active = true;
    s._onSegment({ text, start: 1 });
    return s;
  };

  const a = mkSession('Созвон А', 'Обсудили АААА подробности первого созвона');
  const stopA = a.stop({ summarize: true });      // намеренно НЕ ждём

  // Пока А собирает итоги, стартует Б.
  const b = mkSession('Созвон Б', 'Обсудили БББД подробности второго созвона');
  ok('второй созвон стартовал, пока первый ещё финализируется', b.active && a.active === false);
  ok('папки у созвонов разные', a.store.dir !== b.store.dir);

  const resA = await stopA;
  const resB = await b.stop({ summarize: true });

  const summaryA = fs.readFileSync(path.join(resA.dir, 'summary.md'), 'utf8');
  const summaryB = fs.readFileSync(path.join(resB.dir, 'summary.md'), 'utf8');

  ok('итоги А собраны из своей расшифровки', summaryA.includes('АААА'), summaryA.split('\n')[2]);
  ok('итоги Б собраны из своей расшифровки', summaryB.includes('БББД'), summaryB.split('\n')[2]);
  ok('данные созвонов не перемешались', !summaryA.includes('БББД') && !summaryB.includes('АААА'));

  const transcriptA = fs.readFileSync(path.join(resA.dir, 'transcript.md'), 'utf8');
  ok('расшифровка А не получила реплик Б', !transcriptA.includes('БББД'));
  ok('у обоих созвонов проставлен статус done',
    storage.listSessions(dataDir).every((s) => s.status === 'done'),
    JSON.stringify(storage.listSessions(dataDir).map((s) => s.status)));

  fs.rmSync(dataDir, { recursive: true, force: true });
  srv.close();

  console.log(fails ? `\n${fails} провал(ов)` : '\nВсе проверки прошли');
  process.exit(fails ? 1 : 0);
})();
