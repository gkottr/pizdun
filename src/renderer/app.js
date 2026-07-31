'use strict';

const $ = (id) => document.getElementById(id);

const ui = {
  title: $('title'),
  recDot: $('recDot'),
  meter: $('meter'),
  timer: $('timer'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  status: $('status'),
  chipQueue: $('chipQueue'),
  chipSources: $('chipSources'),
  chipFacts: $('chipFacts'),
  chipDir: $('chipDir'),
  transcript: $('transcript'),
  facts: $('facts'),
  factsLive: $('factsLive'),
  autoScroll: $('autoScroll'),
  toasts: $('toasts')
};

const state = {
  settings: null,
  recording: false,
  startedAt: 0,
  timerId: null,
  audio: null,          // { ctx, node, streams: [] }
  factsCount: 0,
  lastDir: '',
  models: [],
  archive: { items: [], current: null, tab: 'summary' }
};

// ---------------------------------------------------------------- утилиты

function toast(text, kind = '', action = null) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-mini';
    btn.textContent = action.label;
    btn.onclick = () => { action.action(); el.remove(); };
    el.appendChild(btn);
  }
  ui.toasts.appendChild(el);
  setTimeout(() => el.remove(), action ? 20000 : (kind === 'err' ? 9000 : 4500));
}

function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** Минимальный markdown → HTML (заголовки, списки, чекбоксы, bold/italic/code). */
function md2html(src) {
  const inline = (t) => escapeHtml(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const rawLine of String(src || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { closeList(); continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const lvl = Math.min(h[1].length, 4);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }
    if (/^(---|\*\*\*)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(li[1]);
      out.push(task
        ? `<li>${task[1].toLowerCase() === 'x' ? '☑' : '☐'} ${inline(task[2])}</li>`
        : `<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function autoscroll(el) {
  if (ui.autoScroll.checked) el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- настройки

const FIELDS = [
  ['s_baseUrl', 'llm.baseUrl', 'str'],
  ['s_apiKey', 'llm.apiKey', 'str'],
  ['s_model', 'llm.model', 'str'],
  ['s_temperature', 'llm.temperature', 'num'],
  ['s_maxTokens', 'llm.maxTokens', 'num'],
  ['s_binPath', 'whisper.binPath', 'str'],
  ['s_modelPath', 'whisper.modelPath', 'str'],
  ['s_language', 'whisper.language', 'str'],
  ['s_threads', 'whisper.threads', 'num'],
  ['s_extraArgs', 'whisper.extraArgs', 'str'],
  ['s_extraHallucinations', 'whisper.extraHallucinations', 'str'],
  ['s_minChunkSec', 'stream.minChunkSec', 'num'],
  ['s_maxChunkSec', 'stream.maxChunkSec', 'num'],
  ['s_silenceMs', 'stream.silenceMs', 'num'],
  ['s_overlapSec', 'stream.overlapSec', 'num'],
  ['s_vadThreshold', 'stream.vadThreshold', 'num'],
  ['s_factsEnabled', 'facts.enabled', 'bool'],
  ['s_windowChars', 'facts.windowChars', 'num'],
  ['s_overlapChars', 'facts.overlapChars', 'num'],
  ['s_basedOn', 'summary.basedOn', 'str'],
  ['s_mapChunkChars', 'summary.mapChunkChars', 'num'],
  ['s_dataDir', 'storage.dataDir', 'str']
];

const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function setDeep(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = cur[keys[i]] || {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function fillSettingsForm() {
  for (const [id, path, type] of FIELDS) {
    const el = $(id);
    const val = dig(state.settings, path);
    if (type === 'bool') el.checked = !!val;
    else el.value = val == null ? '' : val;
  }
}

function collectSettingsForm() {
  const patch = {};
  for (const [id, path, type] of FIELDS) {
    const el = $(id);
    let val;
    if (type === 'bool') val = el.checked;
    else if (type === 'num') val = el.value === '' ? dig(state.settings, path) : Number(el.value);
    else val = el.value.trim();
    setDeep(patch, path, val);
  }
  return patch;
}

async function loadSettings() {
  state.settings = await window.api.settings.get();
  fillSettingsForm();
}

// ---------------------------------------------------------------- аудио

async function listDevices() {
  const sel = $('s_audioInput');
  const saved = localStorage.getItem('audioInput') || '';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'По умолчанию';
    sel.appendChild(def);
    for (const d of devices.filter((d) => d.kind === 'audioinput')) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Микрофон ${sel.length}`;
      sel.appendChild(o);
    }
    sel.value = saved;
  } catch (err) {
    toast(`Устройства: ${err.message}`, 'err');
  }
}

/**
 * Системный звук (loopback). На macOS он приезжает только при выданном
 * разрешении на запись экрана, а при отказе getDisplayMedia не падает,
 * а виснет навсегда — поэтому статус проверяем заранее и ставим таймаут.
 */
async function addSystemAudio(ctx, merger, streams) {
  const perm = await window.api.audio.systemStatus();

  // Захват пробуем даже без разрешения: сама попытка заставляет macOS
  // показать запрос и внести приложение в список. Отказ ловим таймаутом ниже.
  if (!perm.ok) await window.api.audio.requestScreenAccess();

  let sys;
  try {
    sys = await Promise.race([
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }),
      new Promise((_r, reject) => setTimeout(
        () => reject(new Error('ОС не ответила на запрос захвата за 10 с — проверь разрешение на запись экрана')),
        10000
      ))
    ]);
  } catch (err) {
    toast(`Пишу только микрофон — системный звук не пришёл: ${err.message}`, 'err',
      perm.canOpenSettings
        ? { label: 'Открыть настройки', action: () => window.api.audio.openScreenSettings() }
        : null);
    return false;
  }

  // Видео нам не нужно, но без video: true loopback-аудио не выдают.
  sys.getVideoTracks().forEach((t) => t.stop());

  if (!sys.getAudioTracks().length) {
    sys.getTracks().forEach((t) => t.stop());
    toast('Пишу только микрофон: ОС отдала захват без аудиодорожки. Запасной путь — виртуальный девайс (BlackHole / VB-Cable).', 'err');
    return false;
  }

  streams.push(sys);
  ctx.createMediaStreamSource(new MediaStream(sys.getAudioTracks())).connect(merger);
  return true;
}

async function startAudio() {
  const deviceId = localStorage.getItem('audioInput') || '';

  const ctx = new AudioContext({ sampleRate: 16000 });
  const streams = [];
  const merger = ctx.createGain();

  const mic = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    }
  });
  streams.push(mic);
  ctx.createMediaStreamSource(mic).connect(merger);

  // Системный звук берём всегда: без него в расшифровке не будет собеседников.
  // Если ОС его не отдаёт — пишем один микрофон, созвон из-за этого не срывается.
  const systemAudioOn = await addSystemAudio(ctx, merger, streams);

  let node;
  try {
    await ctx.audioWorklet.addModule('audio-worklet.js');
    node = new AudioWorkletNode(ctx, 'pcm-collector');
    node.port.onmessage = (e) => sendPcm(e.data);
  } catch (err) {
    // Fallback на устаревший ScriptProcessor, если AudioWorklet недоступен.
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => sendPcm(e.inputBuffer.getChannelData(0));
  }
  merger.connect(node);

  // Узлу нужен «сток» графа, но звук в динамики не пускаем — иначе эхо.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);

  state.audio = { ctx, node, streams };
  return { systemAudio: systemAudioOn };
}

function sendPcm(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const v = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  window.api.session.pushAudio(int16.buffer);
}

function stopAudio() {
  if (!state.audio) return;
  const { ctx, node, streams } = state.audio;
  try { node.disconnect(); } catch (_) { /* уже отключён */ }
  if (node.port) node.port.onmessage = null;
  node.onaudioprocess = null;
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  ctx.close().catch(() => {});
  state.audio = null;
  ui.meter.style.width = '0%';
}

// ---------------------------------------------------------------- сессия

async function startSession() {
  if (state.recording) return;
  ui.btnStart.disabled = true;
  let sources;
  try {
    sources = await startAudio();
  } catch (err) {
    ui.btnStart.disabled = false;
    toast(`Микрофон: ${err.message}`, 'err');
    return;
  }
  try {
    const st = await window.api.session.start(ui.title.value);
    state.recording = true;
    state.startedAt = Date.now();
    state.factsCount = 0;
    state.lastDir = st.dir;
    ui.transcript.innerHTML = '';
    ui.facts.innerHTML = '';
    ui.recDot.classList.add('rec');
    ui.btnStop.disabled = false;
    ui.title.disabled = true;
    ui.chipDir.textContent = st.dir;
    ui.chipFacts.textContent = 'фактов: 0';
    ui.chipSources.textContent = sources.systemAudio
      ? 'источники: микрофон + системный звук'
      : 'источники: только микрофон';
    ui.status.textContent = 'Идёт запись и распознавание';
    state.timerId = setInterval(() => {
      ui.timer.textContent = clock((Date.now() - state.startedAt) / 1000);
    }, 500);
    await listDevices(); // после выдачи прав появятся названия устройств
  } catch (err) {
    stopAudio();
    ui.btnStart.disabled = false;
    toast(err.message, 'err');
  }
}

async function stopSession() {
  if (!state.recording) return;
  ui.btnStop.disabled = true;
  state.recording = false;
  clearInterval(state.timerId);
  stopAudio();
  ui.recDot.classList.remove('rec');
  ui.status.textContent = 'Завершаю…';
  try {
    const res = await window.api.session.stop({ summarize: true });
    showSummary(res.title, res.summary || '_Итоги не собраны — проверь настройки LLM._');
    toast(`Готово: ${res.facts} фактов, ${clock(res.durationSec)}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    ui.btnStart.disabled = false;
    ui.title.disabled = false;
    ui.status.textContent = 'Готов к работе';
  }
}

// ---------------------------------------------------------------- рендер событий

window.api.onTranscript((e) => {
  if (ui.transcript.querySelector('.empty')) ui.transcript.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'line fresh';
  div.innerHTML = `<span class="ts">${clock(e.start)}</span><span class="txt">${escapeHtml(e.text)}</span>`;
  ui.transcript.appendChild(div);
  autoscroll(ui.transcript);
});

window.api.onFacts((facts) => {
  if (ui.facts.querySelector('.empty')) ui.facts.innerHTML = '';
  for (const f of facts) {
    const div = document.createElement('div');
    div.className = 'fact';
    div.dataset.cat = f.category || 'факт';
    div.innerHTML =
      `<div class="head"><span class="cat">${escapeHtml(f.category || 'факт')}</span>` +
      `<span>${clock(f.at)}</span>${f.who ? `<span>· ${escapeHtml(f.who)}</span>` : ''}</div>` +
      `<div>${escapeHtml(f.text)}</div>`;
    ui.facts.appendChild(div);
  }
  state.factsCount += facts.length;
  ui.chipFacts.textContent = `фактов: ${state.factsCount}`;
  autoscroll(ui.facts);
});

window.api.onStatus((s) => {
  if (typeof s.queue === 'number') ui.chipQueue.textContent = `очередь: ${s.queue}`;
  if (typeof s.extracting === 'boolean') ui.factsLive.hidden = !s.extracting;
  if (typeof s.phase === 'string' && s.phase) ui.status.textContent = s.phase;
});

window.api.onError((msg) => {
  toast(msg, 'err');
  ui.status.textContent = msg.slice(0, 120);
});

window.api.onLevel((rms) => {
  ui.meter.style.width = `${Math.min(100, Math.round(rms * 400))}%`;
});

// ---------------------------------------------------------------- итоги

function showSummary(title, markdown) {
  $('summaryTitle').textContent = `Итоги — ${title}`;
  $('summaryBody').innerHTML = md2html(markdown);
  $('summaryModal').hidden = false;
}

$('btnCloseSummary').onclick = () => { $('summaryModal').hidden = true; };
$('btnOpenFolder').onclick = () => state.lastDir && window.api.shell.openPath(state.lastDir);
$('btnResummarize').onclick = async () => {
  const btn = $('btnResummarize');
  btn.disabled = true;
  btn.textContent = 'Собираю…';
  try {
    const md = await window.api.session.resummarize();
    $('summaryBody').innerHTML = md2html(md);
    toast('Итоги пересобраны', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Пересобрать';
  }
};

// ---------------------------------------------------------------- архив

async function openArchive() {
  $('archiveModal').hidden = false;
  const items = await window.api.archive.list();
  state.archive.items = items;
  const list = $('archiveList');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<li class="empty">Пока пусто</li>';
    return;
  }
  items.forEach((it, i) => {
    const li = document.createElement('li');
    const when = it.started ? new Date(it.started).toLocaleString('ru-RU') : '';
    li.innerHTML = `<span class="n">${escapeHtml(it.title)}</span><span class="d">${when}${it.duration ? ` · ${it.duration}` : ''}</span>`;
    li.onclick = () => selectArchive(i, li);
    list.appendChild(li);
    if (i === 0) selectArchive(0, li);
  });
}

async function selectArchive(index, li) {
  document.querySelectorAll('.archive-list li').forEach((e) => e.classList.remove('active'));
  if (li) li.classList.add('active');
  const item = state.archive.items[index];
  state.archive.current = await window.api.archive.read(item.dir);
  state.archive.current.dir = item.dir;
  renderArchiveTab();
}

function renderArchiveTab() {
  const cur = state.archive.current;
  const body = $('archiveBody');
  if (!cur) return;
  const text = cur[state.archive.tab] || '';
  body.innerHTML = text.trim()
    ? md2html(text)
    : '<p class="empty">Пусто — этот файл не создавался.</p>';
  body.scrollTop = 0;
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.archive.tab = tab.dataset.tab;
    renderArchiveTab();
  };
});

$('btnArchive').onclick = openArchive;
$('btnCloseArchive').onclick = () => { $('archiveModal').hidden = true; };

// ---------------------------------------------------------------- настройки UI

$('btnSettings').onclick = async () => {
  await loadSettings();
  await listDevices();
  await refreshModels();
  await refreshSysAudioStatus();
  $('settingsModal').hidden = false;
};
$('btnCloseSettings').onclick = () => { $('settingsModal').hidden = true; };

$('btnSaveSettings').onclick = async () => {
  try {
    state.settings = await window.api.settings.update(collectSettingsForm());
    localStorage.setItem('audioInput', $('s_audioInput').value);
    const hint = $('saveHint');
    hint.textContent = 'Сохранено';
    hint.className = 'hint ok';
    setTimeout(() => { hint.textContent = ''; }, 2500);
  } catch (err) {
    toast(err.message, 'err');
  }
};

$('btnTestLlm').onclick = async () => {
  const res = $('llmTestResult');
  res.textContent = 'Проверяю…';
  res.className = 'hint';
  try {
    await window.api.settings.update(collectSettingsForm());
    const answer = await window.api.llm.test();
    res.textContent = `OK: ${answer}`;
    res.className = 'hint ok';
  } catch (err) {
    res.textContent = err.message;
    res.className = 'hint err';
  }
};

$('btnModels').onclick = async () => {
  const sel = $('s_modelList');
  try {
    await window.api.settings.update(collectSettingsForm());
    const models = await window.api.llm.models();
    sel.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
    sel.hidden = false;
    sel.onchange = () => { $('s_model').value = sel.value; };
    toast(`Моделей: ${models.length}`, 'ok');
  } catch (err) {
    toast(`Список моделей: ${err.message}`, 'err');
  }
};

// ---------------------------------------------------------------- плеер

const player = $('player');
const btnPlay = $('btnPlay');

function syncPlayButton() {
  const playing = !player.paused && !player.ended;
  btnPlay.textContent = playing ? '❚❚' : '▶';
  btnPlay.title = playing ? 'Пауза' : 'Музыка (включается сама на загрузке модели)';
}

async function playMusic() {
  if (btnPlay.hidden) return; // файла нет — молча пропускаем
  try {
    await player.play();
  } catch (err) {
    // Chromium может не пустить автозапуск без жеста пользователя.
    toast(`Музыка не запустилась: ${err.message}`, 'err');
  }
}

btnPlay.onclick = () => (player.paused ? playMusic() : player.pause());
player.addEventListener('play', syncPlayButton);
player.addEventListener('pause', syncPlayButton);
player.addEventListener('ended', syncPlayButton);
// Файл может отсутствовать (например, удалили из сборки) — тогда просто прячем кнопку.
player.addEventListener('error', () => { btnPlay.hidden = true; });

// ---------------------------------------------------------------- модели whisper

const modelUi = {
  select: $('s_modelSelect'),
  status: $('modelStatus'),
  download: $('btnModelDownload'),
  cancel: $('btnModelCancel'),
  remove: $('btnModelRemove'),
  progress: $('modelProgress'),
  bar: $('modelBar')
};

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(0)} МБ`;
}

async function refreshModels() {
  const { items, selected } = await window.api.models.list();
  state.models = items;
  modelUi.select.innerHTML = '';
  for (const m of items) {
    const o = document.createElement('option');
    o.value = m.id;
    const marks = [
      `${m.size} МБ`,
      m.quality,
      m.langs === 'en' ? 'только English' : '',
      m.downloaded ? '✓ скачана' : ''
    ].filter(Boolean).join(' · ');
    o.textContent = `${m.id} — ${marks}`;
    modelUi.select.appendChild(o);
  }
  const active = items.find((m) => m.file === selected)
    || items.find((m) => m.downloaded)
    || items.find((m) => m.recommended);
  if (active) modelUi.select.value = active.id;
  renderModelState();
}

function currentModel() {
  return (state.models || []).find((m) => m.id === modelUi.select.value);
}

function renderModelState(busy = false) {
  const m = currentModel();
  if (!m) return;
  modelUi.download.hidden = m.downloaded || busy;
  modelUi.cancel.hidden = !busy;
  modelUi.remove.hidden = !m.downloaded || busy;
  modelUi.progress.hidden = !busy;
  if (busy) return;
  modelUi.status.textContent = m.downloaded
    ? `Скачана (${mb(m.bytes)})${m.note ? ` · ${m.note}` : ''}`
    : `Не скачана · ${m.size} МБ${m.note ? ` · ${m.note}` : ''}`;
  modelUi.status.className = m.downloaded ? 'hint ok' : 'hint';
}

async function downloadModel(id) {
  playMusic(); // скачивание модели — дело небыстрое, пусть будет под музыку
  renderModelState(true);
  modelUi.status.textContent = 'Начинаю загрузку…';
  modelUi.status.className = 'hint';
  modelUi.bar.style.width = '0%';
  try {
    const file = await window.api.models.download(id);
    $('s_modelPath').value = file;
    state.settings = await window.api.settings.get();
    toast(`Модель ${id} готова`, 'ok');
  } catch (err) {
    toast(`Модель ${id}: ${err.message}`, 'err');
  } finally {
    await refreshModels();
  }
}

modelUi.select.onchange = async () => {
  const m = currentModel();
  if (!m) return;
  if (m.downloaded) {
    $('s_modelPath').value = await window.api.models.select(m.file);
    state.settings = await window.api.settings.get();
    renderModelState();
    toast(`Активная модель: ${m.id}`, 'ok');
  } else {
    // Не скачана — тянем сразу, как и просили.
    downloadModel(m.id);
  }
};

modelUi.download.onclick = () => { const m = currentModel(); if (m) downloadModel(m.id); };
modelUi.cancel.onclick = () => { const m = currentModel(); if (m) window.api.models.cancel(m.id); };
modelUi.remove.onclick = async () => {
  const m = currentModel();
  if (!m) return;
  await window.api.models.remove(m.id);
  await refreshModels();
  toast(`Модель ${m.id} удалена`);
};

window.api.onModelProgress((p) => {
  if (!currentModel() || p.id !== currentModel().id) return;
  modelUi.progress.hidden = false;
  modelUi.bar.style.width = `${Math.round(p.percent * 100)}%`;
  modelUi.status.textContent = p.done
    ? 'Проверяю файл…'
    : `${mb(p.got)} из ${mb(p.total)} · ${Math.round(p.percent * 100)}%`;
});

$('btnDetect').onclick = async () => {
  const res = $('detectResult');
  try {
    await window.api.settings.update(collectSettingsForm());
    const { bin, model } = await window.api.settings.detectWhisper();
    if (bin) $('s_binPath').value = bin;
    if (model) $('s_modelPath').value = model;
    res.textContent = bin && model ? 'Найдено' : `Не найдено: ${!bin ? 'бинарь ' : ''}${!model ? 'модель' : ''}`;
    res.className = bin && model ? 'hint ok' : 'hint err';
  } catch (err) {
    res.textContent = err.message;
    res.className = 'hint err';
  }
};

document.querySelectorAll('[data-pick]').forEach((btn) => {
  btn.onclick = async () => {
    const kind = btn.dataset.pick;
    if (kind === 'dir') {
      const dir = await window.api.dialog.pickDir({ title: 'Папка для markdown-файлов' });
      if (dir) $('s_dataDir').value = dir;
      return;
    }
    const isModel = kind === 'model';
    const file = await window.api.dialog.pickFile({
      title: isModel ? 'Модель ggml-*.bin' : 'Бинарь whisper-cli',
      filters: isModel ? [{ name: 'GGML', extensions: ['bin'] }] : []
    });
    if (file) $(isModel ? 's_modelPath' : 's_binPath').value = file;
  };
});

$('btnRefreshDevices').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (_) { /* права не дали — покажем что есть */ }
  await listDevices();
};

async function refreshSysAudioStatus() {
  const perm = await window.api.audio.systemStatus();
  const el = $('sysAudioStatus');
  el.textContent = perm.ok ? perm.hint : `${perm.status}: ${perm.hint}`;
  el.className = perm.ok ? 'hint ok' : 'hint err';
  $('btnScreenSettings').hidden = perm.ok || !perm.canOpenSettings;
  return perm;
}

$('btnScreenSettings').onclick = () => window.api.audio.openScreenSettings();

// Если macOS однажды записала отказ, диалог больше не появляется.
// Сброс возвращает приложение в состояние «ещё не спрашивали».
$('btnResetScreen').onclick = async () => {
  const btn = $('btnResetScreen');
  btn.disabled = true;
  try {
    const res = await window.api.audio.resetScreenAccess();
    if (!res.ok) {
      toast(`Сброс не удался: ${res.error}`, 'err');
      return;
    }
    const asked = await window.api.audio.requestScreenAccess();
    await refreshSysAudioStatus();
    toast(asked.after === 'granted'
      ? 'Разрешение выдано — системный звук доступен'
      : `Разрешение сброшено для ${res.bundleId}. Начни созвон — macOS покажет запрос; после согласия приложение нужно перезапустить.`,
    asked.after === 'granted' ? 'ok' : '');
  } finally {
    btn.disabled = false;
  }
};

$('btnRequestScreen').onclick = async () => {
  const btn = $('btnRequestScreen');
  btn.disabled = true;
  try {
    const res = await window.api.audio.requestScreenAccess();
    await refreshSysAudioStatus();
    if (res.after === 'granted') toast('Разрешение выдано — системный звук доступен', 'ok');
    else toast('macOS должна была показать запрос. Если его не было — приложение уже в списке настроек, включи галку и перезапусти.', 'err',
      { label: 'Открыть настройки', action: () => window.api.audio.openScreenSettings() });
  } finally {
    btn.disabled = false;
  }
};
$('btnRecheckSysAudio').onclick = refreshSysAudioStatus;

$('s_audioInput').onchange = (e) => localStorage.setItem('audioInput', e.target.value);

// ---------------------------------------------------------------- копирование

function copyPanel(el, label) {
  const text = [...el.children]
    .map((c) => c.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  navigator.clipboard.writeText(text).then(
    () => toast(`${label} скопированы`, 'ok'),
    (err) => toast(err.message, 'err')
  );
}

$('btnCopyTranscript').onclick = () => copyPanel(ui.transcript, 'Расшифровка');
$('btnCopyFacts').onclick = () => copyPanel(ui.facts, 'Факты');

// ---------------------------------------------------------------- старт

ui.btnStart.onclick = startSession;
ui.btnStop.onclick = stopSession;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
  }
});

window.addEventListener('beforeunload', () => stopAudio());

(async function init() {
  await loadSettings();
  await listDevices();
  await refreshModels();
  // Разрешение просим на старте: macOS показывает запрос только в ответ на
  // реальное обращение к захвату экрана, само оно в списке настроек не появится.
  const perm = await window.api.audio.systemStatus();
  if (!perm.ok) {
    const res = await window.api.audio.requestScreenAccess();
    if (res.after !== 'granted') {
      toast('Системный звук пока недоступен: macOS должна была показать запрос на запись экрана. Если запроса не было — открой настройки и добавь приложение вручную.',
        'err',
        perm.canOpenSettings ? { label: 'Открыть настройки', action: () => window.api.audio.openScreenSettings() } : null);
    }
    refreshSysAudioStatus();
  }
  if (!state.models.some((m) => m.downloaded)) {
    toast('Модель распознавания ещё не скачана — открой ⚙ и выбери её, приложение загрузит само.');
  }
  if (!state.settings.llm.apiKey && !state.settings.llm.baseUrl.includes('localhost')) {
    toast('Задай URL и токен LLM в настройках (⚙), иначе не будет фактов и итогов.');
  }
})();
