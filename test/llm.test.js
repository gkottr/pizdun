const http = require('http');
const llm = require('../src/main/llm');
const { Session } = require('../src/main/session');
const { DEFAULTS } = require('../src/main/settings');
const fs = require('fs'), os = require('os'), path = require('path');

const seen = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    seen.push({ auth: req.headers.authorization, url: req.url, sys: j.messages[0].content.slice(0, 40), user: j.messages.at(-1).content });
    const isFacts = j.messages[0].content.includes('вычленяет фактуру');
    const content = isFacts
      ? '```json\n[{"text":"Релиз перенесён на пятницу","category":"решение","who":"Вася"},{"text":"Релиз перенесли на пятницу","category":"решение","who":""}]\n```'
      : '## Краткое резюме\nСозвон про релиз.\n\n## Ключевые решения\n- Перенос на пятницу';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

srv.listen(45999, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pizdun-llm-'));
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.llm.baseUrl = 'http://127.0.0.1:45999/v1';
  cfg.llm.apiKey = 'test-token';
  cfg.storage.dataDir = dir;
  cfg.facts.windowChars = 200;
  const settings = { get: () => cfg };

  let fails = 0;
  const ok = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`); if (!c) fails++; };

  const s = new Session(settings);
  s.on('error', (m) => console.log('  [session error]', m));
  s.start('LLM тест');
  s.engine.stop();           // движок whisper не нужен — подаём сегменты руками
  const text = 'Обсудили сроки релиза. '.repeat(12);
  s._onSegment({ text, start: 10 });
  await new Promise((r) => setTimeout(r, 600));

  ok('факты извлеклись', s.facts.length === 1, `${s.facts.length} шт: ${JSON.stringify(s.facts)}`);
  ok('дубль отсеян дедупликацией', s.facts.length === 1);
  ok('Bearer-токен ушёл', seen[0] && seen[0].auth === 'Bearer test-token', seen[0] && seen[0].auth);
  ok('путь /v1/chat/completions', seen[0] && seen[0].url === '/v1/chat/completions', seen[0] && seen[0].url);

  s.active = true; s.engine = { flush: async () => {}, stop: () => {} };
  const res = await s.stop({ summarize: true });
  ok('итоги собраны', res.summary.includes('Ключевые решения'), res.summary.slice(0, 40));
  ok('summary.md записан', fs.existsSync(path.join(res.dir, 'summary.md')));
  ok('в промпт суммаризации попали факты', seen.at(-1).user.includes('Релиз перенесён на пятницу'));
  ok('и расшифровка тоже', seen.at(-1).user.includes('Обсудили сроки релиза'));
  ok('окно фактов с перекрытием', seen[0].user.includes('Фрагмент расшифровки'));

  console.log('\nФайлы:', fs.readdirSync(res.dir).join(', '));
  fs.rmSync(dir, { recursive: true, force: true });
  srv.close();
  console.log(fails ? `\n${fails} провал(ов)` : '\nВсе проверки прошли');
  process.exit(fails ? 1 : 0);
});
