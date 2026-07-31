// Сквозная проверка распознавания: реальный whisper.cpp на реальном аудио.
// Требует установленный бинарь и хотя бы одну скачанную модель, иначе — пропуск.
// Аудио берётся из test/fixtures/*.wav либо синтезируется системным TTS
// (macOS `say`, Linux `espeak`), поэтому тест необязательный.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { WhisperEngine, mergeOverlap, resolveBinary, findModel } = require('../src/main/whisper');
const { DEFAULTS } = require('../src/main/settings');

const skip = (why) => {
  console.log(`SKIP  сквозной тест распознавания — ${why}`);
  process.exit(0);
};

if (!resolveBinary('')) skip('нет whisper-cli (npm run setup:whisper)');
if (!findModel('')) skip('нет ни одной модели (Настройки → Модель)');

const PHRASE = 'Мы решили перенести релиз на пятницу.';
const KEYWORDS = ['перенест', 'релиз', 'пятниц'];

function makeWav() {
  const fixture = path.join(__dirname, 'fixtures', 'speech-ru.wav');
  if (fs.existsSync(fixture)) return { file: fixture, temp: false };

  const out = path.join(os.tmpdir(), `pizdun-e2e-${process.pid}.wav`);
  if (process.platform === 'darwin') {
    const r = spawnSync('say', ['-v', 'Milena', '-o', out, '--data-format=LEI16@16000', PHRASE]);
    if (r.status === 0 && fs.existsSync(out)) return { file: out, temp: true };
  } else if (process.platform === 'linux') {
    const r = spawnSync('espeak', ['-v', 'ru', '-s', '130', '-w', out, PHRASE]);
    if (r.status === 0 && fs.existsSync(out)) return { file: out, temp: true };
  }
  return null;
}

const wav = makeWav();
if (!wav) skip('нечем синтезировать речь и нет test/fixtures/speech-ru.wav');

const buf = fs.readFileSync(wav.file);
const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2);

const cfg = JSON.parse(JSON.stringify(DEFAULTS));
cfg.whisper.language = 'ru';
const engine = new WhisperEngine({ get: () => cfg });

let text = '';
engine.on('segment', (s) => { text = `${text} ${mergeOverlap(text.slice(-400), s.text)}`.trim(); });
engine.on('error', (e) => console.error('  ошибка движка:', e.message));

(async () => {
  const started = Date.now();
  for (let o = 0; o < pcm.length; o += 1600) engine.push(pcm.subarray(o, o + 1600));
  await engine.flush();
  if (wav.temp) fs.unlinkSync(wav.file);

  const low = text.toLowerCase();
  const hits = KEYWORDS.filter((k) => low.includes(k));
  const audioSec = pcm.length / 16000;
  const workSec = (Date.now() - started) / 1000;

  console.log(`      распознано: "${text}"`);
  console.log(`      ${audioSec.toFixed(1)} с аудио за ${workSec.toFixed(1)} с (x${(audioSec / workSec).toFixed(1)} реального времени)`);

  const ok = hits.length >= 2;
  console.log(`${ok ? 'PASS' : 'FAIL'}  сквозное распознавание — совпало ключевых слов: ${hits.length}/${KEYWORDS.length}`);
  process.exit(ok ? 0 : 1);
})();
