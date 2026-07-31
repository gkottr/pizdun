// Проверки установки whisper.cpp и подсистемы моделей.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { TAG, EXE } = require('../src/main/platform');
const { bundledWhisperBin, modelsDir } = require('../src/main/paths');
const { resolveBinary, findModel } = require('../src/main/whisper');
const models = require('../src/main/models');

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fails++;
};

// --- платформенный тег
ok('тег платформы в стиле electron-builder', /^(mac|win|linux)-/.test(TAG), TAG);

// --- бинарь whisper
const bin = bundledWhisperBin();
ok('whisper-cli установлен в vendor/bin', !!bin, bin || 'не найден — запусти npm run setup:whisper');
if (bin) {
  ok('лежит в папке под текущую платформу', bin.includes(path.join('vendor', 'bin', TAG)), bin);
  const help = spawnSync(bin, ['--help'], { encoding: 'utf8' });
  ok('бинарь запускается', /usage/i.test(`${help.stdout}${help.stderr}`));
  ok('resolveBinary находит его без настроек', resolveBinary('') === bin);
  ok('явный путь в настройках приоритетнее', resolveBinary('/custom/whisper') === '/custom/whisper');
}

// --- каталог моделей
const list = models.list();
ok('каталог моделей не пуст', list.length >= 10, `${list.length} шт`);
ok('есть рекомендованная модель', list.some((m) => m.recommended));
ok('у всех моделей есть id/размер/файл', list.every((m) => m.id && m.size > 0 && m.file));
ok('modelsDir создаётся', fs.existsSync(modelsDir()), modelsDir());

const downloaded = list.filter((m) => m.downloaded);
ok('findModel подхватывает скачанное', downloaded.length === 0 || !!findModel(''), findModel('') || 'моделей ещё нет');

// --- проверка формата файла
const fake = path.join(modelsDir(), 'ggml-fake-test.bin');
fs.writeFileSync(fake, Buffer.from('это не модель, а текст'));
ok('мусорный файл не считается моделью', !models.looksLikeModel(fake));
fs.unlinkSync(fake);
if (downloaded.length) {
  ok('скачанная модель проходит проверку магии', models.looksLikeModel(downloaded[0].file), downloaded[0].id);
}

// --- системный звук: реакция на разрешения macOS
const systemAudio = require('../src/main/system-audio');

const denied = systemAudio.status(() => 'denied', 'darwin');
ok('macOS без разрешения — не ok', !denied.ok && denied.status === 'denied');
ok('macOS без разрешения — предлагает настройки', denied.canOpenSettings && /разрешение/i.test(denied.hint));
ok('без разрешения захват всё равно пробуем', denied.shouldTry, 'иначе macOS никогда не покажет запрос');

const granted = systemAudio.status(() => 'granted', 'darwin');
ok('macOS с разрешением — ok', granted.ok);

const notDetermined = systemAudio.status(() => 'not-determined', 'darwin');
ok('not-determined — не granted, но попытку делаем', !notDetermined.ok && notDetermined.shouldTry);

// bundle id нужен для tccutil
const fakePlist = '<key>CFBundleIdentifier</key>\n\t<string>dev.pizdun.app</string>';
ok('bundle id читается из Info.plist',
  systemAudio.bundleIdentifier('/A/Pizdun.app/Contents/MacOS/Pizdun', () => fakePlist) === 'dev.pizdun.app');
ok('вне бандла bundle id не выдумывается',
  systemAudio.bundleIdentifier('/usr/local/bin/node', () => fakePlist) === null);
ok('нечитаемый Info.plist не роняет',
  systemAudio.bundleIdentifier('/A/X.app/Contents/MacOS/X', () => { throw new Error('нет файла'); }) === null);

// сброс TCC
let tccArgs = null;
const resetOk = systemAudio.resetScreenAccess('dev.pizdun.app', (cmd, args) => {
  tccArgs = [cmd, ...args];
  return { status: 0, stdout: '', stderr: '' };
});
ok('сброс зовёт tccutil с нужными аргументами',
  resetOk.ok && tccArgs.join(' ') === 'tccutil reset ScreenCapture dev.pizdun.app', (tccArgs || []).join(' '));
ok('без bundle id сброс не выполняется',
  !systemAudio.resetScreenAccess(null, () => { throw new Error('не должно вызываться'); }).ok);
ok('ошибка tccutil возвращается наружу',
  !systemAudio.resetScreenAccess('x', () => ({ status: 1, stderr: 'нет такой записи' })).ok);

ok('падение systemPreferences не роняет проверку',
  systemAudio.status(() => { throw new Error('нет API'); }, 'darwin').status === 'unknown');

ok('Windows — без разрешений', systemAudio.status(() => 'denied', 'win32').ok);
ok('Linux — пропускаем к loopback', systemAudio.status(() => 'denied', 'linux').ok);

console.log(fails ? `\n${fails} провал(ов)` : '\nВсе проверки прошли');
process.exit(fails ? 1 : 0);
