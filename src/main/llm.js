'use strict';

// Клиент к любому OpenAI-совместимому API (/chat/completions).

function joinUrl(base, tail) {
  const b = String(base || '').replace(/\/+$/, '');
  return `${b}${tail}`;
}

async function chat(cfg, messages, opts = {}) {
  if (!cfg.baseUrl) throw new Error('Не задан URL LLM API (Настройки).');
  const url = joinUrl(cfg.baseUrl, '/chat/completions');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || cfg.timeoutMs || 120000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? cfg.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? cfg.maxTokens ?? 2048,
        stream: false
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    return (msg && (msg.content || '')) || '';
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('LLM: таймаут запроса');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(cfg) {
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id).sort();
}

const FACTS_SYSTEM = `Ты — ассистент, который на лету вычленяет фактуру из расшифровки рабочего созвона.
Расшифровка получена ASR: возможны ошибки, обрывы, отсутствие пунктуации и разметки говорящих.

Верни СТРОГО JSON-массив без markdown-обёртки. Каждый элемент:
{"text": "...", "category": "решение|задача|факт|проблема|вопрос|договорённость", "who": "имя или пустая строка"}

Правила:
- Один элемент = один самодостаточный факт, понятный без контекста созвана.
- Формулируй кратко (до 25 слов), в прошедшем/настоящем времени, без воды и вводных.
- Берём: решения, задачи и их исполнителей, сроки, цифры, названия систем, риски, открытые вопросы, договорённости.
- НЕ берём: приветствия, болтовню, повторы, размышления вслух, то, что уже перечислено в блоке «Уже известно».
- Если нового по сути нет — верни [].
- Язык фактов — язык расшифровки.`;

function stripFence(text) {
  const t = String(text || '').trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m ? m[1] : t;
}

function parseFacts(raw) {
  const text = stripFence(raw);
  let arr = null;
  try {
    arr = JSON.parse(text);
  } catch (_) {
    const m = /\[[\s\S]*\]/.exec(text);
    if (m) {
      try { arr = JSON.parse(m[0]); } catch (_) { /* мимо */ }
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((f) => {
      if (typeof f === 'string') return { text: f.trim(), category: 'факт', who: '' };
      if (!f || typeof f !== 'object') return null;
      return {
        text: String(f.text || f.fact || '').trim(),
        category: String(f.category || 'факт').trim().toLowerCase(),
        who: String(f.who || '').trim()
      };
    })
    .filter((f) => f && f.text.length > 2);
}

/**
 * Извлечение фактов из окна расшифровки (с перекрытием с предыдущим окном).
 * known — уже найденные факты, чтобы модель не повторялась.
 */
async function extractFacts(cfg, windowText, known = []) {
  const knownBlock = known.length
    ? `Уже известно (не повторять):\n${known.slice(-40).map((f) => `- ${f.text}`).join('\n')}\n\n`
    : '';
  const raw = await chat(cfg, [
    { role: 'system', content: FACTS_SYSTEM },
    { role: 'user', content: `${knownBlock}Фрагмент расшифровки:\n"""\n${windowText}\n"""` }
  ], { temperature: 0.1, maxTokens: 1200 });
  return parseFacts(raw);
}

const SUMMARY_SYSTEM = `Ты — ассистент, который готовит итоги рабочего созвона на основе расшифровки и вычлененных фактов.
Пиши на языке созвона. Формат — markdown, без вводных фраз вроде «вот итоги».

Структура:
## Краткое резюме
3-6 предложений: о чём был созвон и к чему пришли.

## Ключевые решения
- маркированный список (если решений не было — напиши «Решений не зафиксировано»)

## Задачи
- [ ] задача — ответственный — срок (то, чего нет, опускай)

## Обсуждённые темы
- тема: суть в 1-2 предложениях

## Открытые вопросы и риски
- список

Ничего не выдумывай: если данных нет — так и пиши.`;

const MAP_SYSTEM = `Сожми фрагмент расшифровки созвона в плотный конспект (маркированный список, до 15 пунктов):
решения, задачи, факты, цифры, имена, риски, открытые вопросы. Без воды и без вступлений. Язык — как в тексте.`;

async function summarize(cfg, { transcript, facts, mapChunkChars = 12000, basedOn = 'both' }) {
  const factBlock = facts.length
    ? facts.map((f) => `- [${f.category}] ${f.text}${f.who ? ` (${f.who})` : ''}`).join('\n')
    : '';

  let source = '';
  if (basedOn === 'facts') {
    source = factBlock ? `Факты, собранные по ходу созвона:\n${factBlock}` : transcript;
  } else {
    let body = transcript;
    if (transcript.length > mapChunkChars) {
      const chunks = [];
      for (let i = 0; i < transcript.length; i += mapChunkChars) {
        chunks.push(transcript.slice(i, i + mapChunkChars));
      }
      const partials = [];
      for (const c of chunks) {
        partials.push(await chat(cfg, [
          { role: 'system', content: MAP_SYSTEM },
          { role: 'user', content: c }
        ], { temperature: 0.1, maxTokens: 1200 }));
      }
      body = partials.map((p, i) => `### Часть ${i + 1}\n${p.trim()}`).join('\n\n');
    }
    source = basedOn === 'transcript' || !factBlock
      ? `Расшифровка:\n${body}`
      : `Факты, собранные по ходу созвона:\n${factBlock}\n\nРасшифровка:\n${body}`;
  }

  return chat(cfg, [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: source }
  ], { temperature: 0.3, maxTokens: 2500 });
}

async function testConnection(cfg) {
  const out = await chat(cfg, [{ role: 'user', content: 'Ответь одним словом: ок' }], {
    maxTokens: 20,
    timeoutMs: 30000
  });
  return out.trim().slice(0, 100) || '(пустой ответ)';
}

module.exports = { chat, listModels, extractFacts, summarize, testConnection, parseFacts };
