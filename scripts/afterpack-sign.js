'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Ad-hoc подпись собранного .app.
 *
 * Без подписи macOS не даёт бандлу стабильной идентичности, и TCC либо не
 * показывает запрос на «Запись экрана и системного звука», либо не заносит
 * приложение в список. Настоящий Developer ID тут не нужен — хватает `-`.
 *
 * Важно: ad-hoc подпись привязана к содержимому, поэтому после каждой пересборки
 * идентичность меняется и разрешение придётся выдать заново.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  const res = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.log(`  • ad-hoc подпись не удалась: ${(res.stderr || '').trim()}`);
    return;
  }

  const check = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
  const signature = /Signature=(\S+)/.exec(check.stderr || '');
  console.log(`  • ad-hoc подпись поставлена (${signature ? signature[1] : 'ok'}) — нужно для запроса доступа к записи экрана`);
};
