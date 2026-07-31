'use strict';

// Тег платформы для папок с бинарями: vendor/bin/<tag>/whisper-cli.
// Имена совпадают с макросами electron-builder (${platform}-${arch}),
// чтобы extraResources подхватывал нужную папку без лишних хуков.
const EB_OS = { darwin: 'mac', win32: 'win', linux: 'linux' };

const OS_TAG = EB_OS[process.platform] || process.platform;
const TAG = `${OS_TAG}-${process.arch}`;
const EXE = process.platform === 'win32' ? '.exe' : '';

module.exports = { OS_TAG, TAG, EXE };
