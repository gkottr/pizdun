#!/usr/bin/env node
'use strict';

/**
 * Кроссплатформенная установка whisper.cpp — без brew и прочей платформенной магии.
 *
 *   Windows / Linux : качаем готовые бинари из релиза whisper.cpp
 *   macOS и всё остальное : собираем из исходников через CMake
 *                           (сам CMake, если его нет, тоже качается официальным архивом Kitware)
 *
 * Результат: vendor/bin/<platform>-<arch>/whisper-cli(.exe) + сопутствующие библиотеки.
 * Скрипт идемпотентный: если бинарь уже на месте — выходит сразу.
 *
 * Переменные окружения:
 *   SKIP_WHISPER_SETUP=1  — пропустить (например, в CI)
 *   FORCE_WHISPER_SETUP=1 — переустановить, даже если бинарь есть
 *   WHISPER_BUILD_FROM_SOURCE=1 — не брать готовые бинари, собирать самому
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const WHISPER_VERSION = 'v1.9.1';
const CMAKE_VERSION = '3.31.6';

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor');
const WORK = path.join(VENDOR, '.build');
const { TAG, EXE } = require('../src/main/platform');
const TARGET_DIR = path.join(VENDOR, 'bin', TAG);
const BIN_NAME = `whisper-cli${EXE}`;

const log = (...a) => console.log('[whisper]', ...a);

// Готовые бинари из релиза whisper.cpp (macOS в релизе нет — там сборка из исходников).
const PREBUILT = {
  'win-x64': `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-x64.zip`,
  'win-ia32': `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-Win32.zip`,
  'linux-x64': `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-ubuntu-x64.tar.gz`,
  'linux-arm64': `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/whisper-bin-ubuntu-arm64.tar.gz`
};

function cmakeUrl() {
  const v = CMAKE_VERSION;
  const base = `https://github.com/Kitware/CMake/releases/download/v${v}/cmake-${v}`;
  if (process.platform === 'darwin') return `${base}-macos-universal.tar.gz`;
  if (process.platform === 'win32') return `${base}-windows-${process.arch === 'ia32' ? 'i386' : 'x86_64'}.zip`;
  if (process.platform === 'linux') return `${base}-linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.tar.gz`;
  return null;
}

async function download(url, dest) {
  log('качаю', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(dest);
  let got = 0;
  let lastPrint = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    out.write(chunk);
    if (total && Date.now() - lastPrint > 1000) {
      lastPrint = Date.now();
      process.stdout.write(`\r[whisper] ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} МБ`);
    }
  }
  await new Promise((r) => out.end(r));
  if (total) process.stdout.write('\n');
  return dest;
}

/** tar есть везде: на Windows 10+ это bsdtar, он же распаковывает zip. */
function extract(archive, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const res = spawnSync('tar', ['-xf', archive, '-C', dir], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`не смог распаковать ${path.basename(archive)} (tar вернул ${res.status})`);
}

function findFile(dir, predicate, depth = 8) {
  const stack = [[dir, 0]];
  while (stack.length) {
    const [cur, d] = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (d < depth) stack.push([full, d + 1]);
      } else if (predicate(e.name, full)) {
        return full;
      }
    }
  }
  return null;
}

function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(finder, [cmd], { encoding: 'utf8' }).split(/\r?\n/)[0].trim() || null;
  } catch (_) {
    return null;
  }
}

async function ensureCmake() {
  const found = which('cmake');
  if (found) {
    log('cmake найден:', found);
    return found;
  }
  const url = cmakeUrl();
  if (!url) throw new Error(`не знаю, где взять cmake для ${TAG}. Поставь cmake сам и повтори.`);

  const cached = findFile(path.join(WORK, 'cmake'), (n, full) => n === `cmake${EXE}` && path.basename(path.dirname(full)) === 'bin');
  if (cached) {
    log('cmake из кэша:', cached);
    return cached;
  }

  log('cmake не найден — качаю официальную сборку Kitware', CMAKE_VERSION);
  fs.mkdirSync(WORK, { recursive: true });
  const archive = path.join(WORK, path.basename(url));
  await download(url, archive);
  extract(archive, path.join(WORK, 'cmake'));
  fs.unlinkSync(archive);

  const bin = findFile(path.join(WORK, 'cmake'), (n, full) => n === `cmake${EXE}` && path.basename(path.dirname(full)) === 'bin');
  if (!bin) throw new Error('в архиве cmake не нашёлся исполняемый файл');
  fs.chmodSync(bin, 0o755);
  log('cmake установлен:', bin);
  return bin;
}

function copyArtifacts(fromDir) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  const bin = findFile(fromDir, (n) => n === BIN_NAME);
  if (!bin) throw new Error(`после сборки не нашёл ${BIN_NAME} в ${fromDir}`);

  fs.copyFileSync(bin, path.join(TARGET_DIR, BIN_NAME));
  fs.chmodSync(path.join(TARGET_DIR, BIN_NAME), 0o755);

  // Динамические библиотеки рядом с бинарём (для готовых сборок они обязательны).
  const libDirs = new Set([path.dirname(bin)]);
  const libRe = /\.(dll|dylib|so(\.\d+)*)$/i;
  for (const dir of libDirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!libRe.test(name)) continue;
      fs.copyFileSync(path.join(dir, name), path.join(TARGET_DIR, name));
    }
  }
  return path.join(TARGET_DIR, BIN_NAME);
}

async function installPrebuilt() {
  const url = PREBUILT[TAG];
  if (!url) return null;
  log('беру готовый бинарь для', TAG);
  fs.mkdirSync(WORK, { recursive: true });
  const archive = path.join(WORK, path.basename(url));
  await download(url, archive);
  const dir = path.join(WORK, `prebuilt-${TAG}`);
  fs.rmSync(dir, { recursive: true, force: true });
  extract(archive, dir);
  fs.unlinkSync(archive);
  return copyArtifacts(dir);
}

async function buildFromSource() {
  log('собираю whisper.cpp', WHISPER_VERSION, 'из исходников');
  fs.mkdirSync(WORK, { recursive: true });

  const srcDir = path.join(WORK, `whisper.cpp-${WHISPER_VERSION.replace(/^v/, '')}`);
  if (!fs.existsSync(srcDir)) {
    const url = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_VERSION}.tar.gz`;
    const archive = path.join(WORK, `whisper-${WHISPER_VERSION}.tar.gz`);
    await download(url, archive);
    extract(archive, WORK);
    fs.unlinkSync(archive);
  }
  if (!fs.existsSync(srcDir)) throw new Error(`исходники не распаковались в ${srcDir}`);

  const cmake = await ensureCmake();
  const build = path.join(srcDir, 'build');
  const jobs = String(Math.max(2, os.cpus().length));

  const configure = [
    '-B', build,
    '-S', srcDir,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',      // самодостаточный бинарь — проще упаковывать
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON'
  ];
  if (process.platform === 'darwin') configure.push('-DGGML_METAL_EMBED_LIBRARY=ON');

  run(cmake, configure);
  run(cmake, ['--build', build, '--config', 'Release', '-j', jobs, '--target', 'whisper-cli']);

  return copyArtifacts(build);
}

function run(cmd, args) {
  log('>', path.basename(cmd), args.slice(0, 4).join(' '), '…');
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`${path.basename(cmd)} завершился с кодом ${res.status}`);
}

async function main() {
  if (process.env.SKIP_WHISPER_SETUP === '1') {
    log('SKIP_WHISPER_SETUP=1 — пропускаю');
    return;
  }
  const target = path.join(TARGET_DIR, BIN_NAME);
  if (fs.existsSync(target) && process.env.FORCE_WHISPER_SETUP !== '1') {
    log('уже установлен:', target);
    return;
  }

  let installed = null;
  if (process.env.WHISPER_BUILD_FROM_SOURCE !== '1') {
    try {
      installed = await installPrebuilt();
    } catch (err) {
      log('готовый бинарь не подошёл:', err.message, '— собираю из исходников');
    }
  }
  if (!installed) installed = await buildFromSource();

  const check = spawnSync(installed, ['--help'], { encoding: 'utf8' });
  const output = `${check.stdout || ''}${check.stderr || ''}`;
  if (!/usage|whisper/i.test(output)) throw new Error(`бинарь не запускается: ${output.slice(0, 200)}`);

  log('готово:', installed);
  log('модели качаются из интерфейса приложения (Настройки → Модель).');
}

main().catch((err) => {
  console.error('\n[whisper] установка не удалась:', err.message);
  console.error('[whisper] приложение запустится, но распознавание работать не будет.');
  console.error('[whisper] повторить: npm run setup:whisper');
  // Не роняем npm install — путь к бинарю всегда можно указать руками в настройках.
  process.exit(0);
});
