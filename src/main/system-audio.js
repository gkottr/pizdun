'use strict';

// Системный звук (голос собеседников) берётся через loopback в getDisplayMedia.
// Особенность macOS: звук приложений отдаётся только вместе с разрешением
// «Запись экрана и системного звука», а при его отсутствии getDisplayMedia
// не бросает ошибку, а виснет навсегда. Поэтому статус проверяем заранее.

const path = require('path');

const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * @param {(media: string) => string} getAccessStatus  systemPreferences.getMediaAccessStatus
 * @param {string} platform  process.platform
 */
function status(getAccessStatus, platform = process.platform) {
  if (platform === 'darwin') {
    let access = 'unknown';
    try {
      access = getAccessStatus('screen');
    } catch (_) {
      access = 'unknown';
    }
    const ok = access === 'granted';
    return {
      platform,
      status: access,
      ok,
      // Пока разрешения нет, пробовать захват ОБЯЗАТЕЛЬНО: именно попытка
      // заставляет macOS показать запрос и внести приложение в список
      // «Запись экрана и системного звука». Без попытки его там не будет.
      shouldTry: true,
      canOpenSettings: true,
      hint: ok
        ? 'Разрешение на запись экрана выдано — системный звук доступен.'
        : 'macOS спросит разрешение при первой попытке захвата. Если запроса не было — выдай доступ вручную и перезапусти приложение.'
    };
  }

  if (platform === 'win32') {
    return {
      platform,
      status: 'granted',
      ok: true,
      shouldTry: true,
      canOpenSettings: false,
      hint: 'Системный звук берётся через loopback, отдельных разрешений не нужно.'
    };
  }

  return {
    platform,
    status: 'unknown',
    ok: true,
    shouldTry: true,
    canOpenSettings: false,
    hint: 'Звук приложений отдаёт PulseAudio/PipeWire: если loopback не сработает, выбери monitor-устройство как микрофон.'
  };
}

/** CFBundleIdentifier текущего приложения — нужен для tccutil. */
function bundleIdentifier(execPath = process.execPath, readFile = require('fs').readFileSync) {
  // .../Pizdun.app/Contents/MacOS/Pizdun -> .../Pizdun.app/Contents/Info.plist
  const parts = execPath.split(path.sep);
  const macos = parts.lastIndexOf('MacOS');
  if (macos < 1) return null;
  const plist = [...parts.slice(0, macos), 'Info.plist'].join(path.sep);
  try {
    const xml = readFile(plist, 'utf8');
    const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

/**
 * Сбрасывает запись TCC для приложения.
 *
 * Если пользователь однажды отклонил запрос (или система записала отказ),
 * macOS больше никогда не покажет диалог — остаётся только ручное включение
 * в списке. Сброс возвращает приложение в состояние «ещё не спрашивали»,
 * после чего следующая попытка захвата снова вызывает диалог.
 */
function resetScreenAccess(bundleId, run = require('child_process').spawnSync) {
  if (!bundleId) return { ok: false, error: 'не удалось определить bundle id приложения' };
  const res = run('tccutil', ['reset', 'ScreenCapture', bundleId], { encoding: 'utf8' });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return res.status === 0
    ? { ok: true, bundleId, output }
    : { ok: false, bundleId, error: output || `tccutil вернул ${res.status}` };
}

module.exports = { status, bundleIdentifier, resetScreenAccess, SCREEN_SETTINGS_URL };
