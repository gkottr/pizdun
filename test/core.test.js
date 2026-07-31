// Оффлайн-проверка ядра: VAD-нарезка, склейка перекрытий, markdown-хранилище, парсер фактов.
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const { WhisperEngine, mergeOverlap } = require(path.join(ROOT, 'src/main/whisper'));
const { SessionStore, listSessions } = require(path.join(ROOT, 'src/main/storage'));
const { parseFacts } = require(path.join(ROOT, 'src/main/llm'));
const { DEFAULTS } = require(path.join(ROOT, 'src/main/settings'));

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails++;
};

// --- mergeOverlap
ok('overlap срезается',
  mergeOverlap('мы решили перенести релиз на пятницу', 'перенести релиз на пятницу и позвать QA') === 'и позвать QA',
  mergeOverlap('мы решили перенести релиз на пятницу', 'перенести релиз на пятницу и позвать QA'));
ok('без перекрытия текст не режется',
  mergeOverlap('привет всем', 'начинаем стендап') === 'начинаем стендап');
ok('пустой prev', mergeOverlap('', 'что-то') === 'что-то');

// Реальные стыки кусков: в зоне перекрытия whisper слышит слова иначе
// и добавляет мусор в начало нового куска.
ok('нечёткое перекрытие со сдвигом',
  mergeOverlap('Василия берёт на себя доработку шлюзом.',
    'Ребя доработку шлюзы обещает закончить к среде.') === 'обещает закончить к среде.',
  mergeOverlap('Василия берёт на себя доработку шлюзом.', 'Ребя доработку шлюзы обещает закончить к среде.'));
ok('чужой текст не режется по случайному совпадению',
  mergeOverlap('до конца месяца.', 'Третий вопрос, нам согласовали две вакансии')
    === 'Третий вопрос, нам согласовали две вакансии');

// --- галлюцинации whisper на тишине
const { stripHallucinations, compileExtra } = require(path.join(ROOT, 'src/main/hallucinations'));

const junk = [
  'Субтитры сделал DimaTorzok',
  'Субтитры создавал DimaTorzok',
  'Продолжение следует...',
  'Подписывайтесь на канал!',
  'Спасибо за просмотр!',
  'Редактор субтитров А.Синецкая Корректор А.Егорова',
  'Subtitles by the Amara.community',
  'Thanks for watching!',
  'Please subscribe to my channel'
];
for (const j of junk) {
  ok(`вырезается: "${j.slice(0, 34)}"`, stripHallucinations(j) === '', JSON.stringify(stripHallucinations(j)));
}

ok('галлюцинация в хвосте реплики срезается, речь остаётся',
  stripHallucinations('Значит, релиз переносим на пятницу. Субтитры сделал DimaTorzok')
    === 'Значит, релиз переносим на пятницу.',
  stripHallucinations('Значит, релиз переносим на пятницу. Субтитры сделал DimaTorzok'));

// Живая речь пострадать не должна
const legit = [
  'Спасибо за внимание, коллеги',
  'Нужно добавить субтитры к обучающему видео',
  'Продолжение обсудим завтра',
  'Подписывайтесь под актом сверки',
  'Дима Торжок звонил по поводу счёта'
];
for (const l of legit) {
  ok(`живая речь цела: "${l.slice(0, 34)}"`, stripHallucinations(l) === l, JSON.stringify(stripHallucinations(l)));
}

ok('свои фразы из настроек тоже режутся',
  stripHallucinations('Реплика. Продолжение в описании', compileExtra('Продолжение в описании')) === 'Реплика.');
ok('спецсимволы в своей фразе не ломают регулярку',
  stripHallucinations('текст ((c) канал)', compileExtra('((c) канал)')) === 'текст');

// --- парсер фактов LLM
const parsed = parseFacts('```json\n[{"text":"Релиз перенесли на пятницу","category":"решение","who":"Вася"},{"text":"x"}]\n```');
ok('parseFacts чистит fence и мусор', parsed.length === 1 && parsed[0].who === 'Вася', JSON.stringify(parsed));
ok('parseFacts на болтовне модели', parseFacts('Извините, вот результат: [] ').length === 0);

// --- нарезка потока
const settings = { get: () => JSON.parse(JSON.stringify(DEFAULTS)) };
const eng = new WhisperEngine(settings);
const cuts = [];
eng._transcribe = async (audio) => { cuts.push(audio.length / 16000); return 'кусок'; };

const SR = 16000;
function tone(sec, amp) {
  const a = new Int16Array(Math.round(sec * SR));
  for (let i = 0; i < a.length; i++) a[i] = Math.round(Math.sin(i / 12) * 32767 * amp);
  return a;
}
// речь 5с, пауза 1с, речь 6с, пауза 1с
for (const part of [tone(5, 0.5), tone(1, 0), tone(6, 0.5), tone(1, 0)]) {
  for (let o = 0; o < part.length; o += 1600) eng.push(part.subarray(o, o + 1600));
}

(async () => {
  await eng.flush();
  ok('нарезал по паузам на 2 куска', cuts.length === 2, `куски: ${cuts.map((c) => c.toFixed(1)).join(', ')} с`);
  ok('второй кусок содержит перекрытие ~1с', cuts[1] > 6.5 && cuts[1] < 8.5, `${(cuts[1] || 0).toFixed(2)} с`);
  ok('первый кусок не длиннее max+overlap', cuts[0] <= DEFAULTS.stream.maxChunkSec + 1.1);

  // тишина не должна порождать запусков
  const eng2 = new WhisperEngine(settings);
  let runs = 0;
  eng2._transcribe = async () => { runs++; return ''; };
  const sil = tone(30, 0);
  for (let o = 0; o < sil.length; o += 1600) eng2.push(sil.subarray(o, o + 1600));
  await eng2.flush();
  ok('30 с тишины = 0 запусков whisper', runs === 0, `запусков: ${runs}`);

  // --- storage
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pizdun-test-'));
  const store = new SessionStore(dir, 'Тест Созвон');
  store.appendTranscript({ start: 65, text: 'Первая реплика' });
  store.appendFacts([{ at: 65, category: 'решение', text: 'Релиз в пятницу' }]);
  store.writeSummary('## Краткое резюме\nВсё ок.');
  store.finish(3725);
  const list = listSessions(dir);
  ok('сессия видна в архиве', list.length === 1 && list[0].title === 'Тест Созвон', JSON.stringify(list[0] || {}));
  ok('длительность в frontmatter', list[0] && list[0].duration === '01:02:05', list[0] && list[0].duration);
  ok('таймкод в транскрипте', fs.readFileSync(store.transcriptFile, 'utf8').includes('**[00:01:05]** Первая реплика'));
  ok('факт записан', fs.readFileSync(store.factsFile, 'utf8').includes('**[решение]** Релиз в пятницу'));
  ok('итоги записаны', fs.existsSync(store.summaryFile));
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(fails ? `\n${fails} провал(ов)` : '\nВсе проверки прошли');
  process.exit(fails ? 1 : 0);
})();
