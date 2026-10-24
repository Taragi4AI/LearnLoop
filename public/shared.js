// Shared constants + small DOM/helper utilities used across all tabs.

export const PRESET_VOICES = ['chloe', 'eleanor', 'jake', 'marcus', 'nora', 'oliver'];

// Inline control tags (from the Higgs TTS 3 docs).
export const TAGS = {
  emotion: [
    'elation', 'amusement', 'enthusiasm', 'determination', 'pride', 'contentment',
    'affection', 'relief', 'contemplation', 'confusion', 'surprise', 'awe',
    'longing', 'arousal', 'anger', 'fear', 'disgust', 'bitterness', 'sadness',
    'shame', 'helplessness',
  ],
  style: ['singing', 'shouting', 'whispering'],
  sfx: ['cough', 'laughter', 'crying', 'screaming', 'burping', 'humming', 'sigh', 'sniff', 'sneeze'],
  prosody: [
    'speed_very_slow', 'speed_slow', 'speed_fast', 'speed_very_fast',
    'pitch_low', 'pitch_high', 'pause', 'long_pause',
    'expressive_high', 'expressive_low',
  ],
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) {
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

// Render a result block. `kind` is 'ok' | 'err' | 'info'.
export function showResult(container, title, kind = 'info', detail) {
  const row = el('div', { className: 'row' });
  row.append(el('div', { className: kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '' }, title));
  if (detail != null) {
    const pre = el('pre');
    pre.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
    row.append(pre);
  }
  container.innerHTML = '';
  container.append(row);
  return row;
}

// POST JSON and parse the JSON response, throwing a readable error on failure.
export async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `${res.status} ${res.statusText}`);
  return data;
}

// POST JSON but expect a binary (audio/video) response -> returns a Blob.
export async function postForBlob(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `${res.status} ${res.statusText}`);
  }
  return res.blob();
}

export function populateVoiceSelect(select, extra = []) {
  select.innerHTML = '';
  select.append(el('option', { value: 'default', textContent: 'default' }));
  for (const v of PRESET_VOICES) {
    select.append(el('option', { value: v, textContent: v }));
  }
  for (const v of extra) {
    select.append(el('option', { value: v, textContent: `${v} (custom)` }));
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
