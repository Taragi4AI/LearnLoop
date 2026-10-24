// Main UI controller: tabs, key status, and the TTS / Voices / Avatar tabs.
// Realtime lives in its own module.

import {
  $, $$, el, TAGS, showResult, postJSON, postForBlob,
  populateVoiceSelect, sleep,
} from './shared.js';
import { initRealtime } from './realtime.js';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabs = $$('.tab');

function selectTab(tab, moveFocus = false) {
  tabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle('active', selected);
    item.setAttribute('aria-selected', selected ? 'true' : 'false');
    item.tabIndex = selected ? 0 : -1;
  });
  $$('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${tab.dataset.tab}`));
  if (moveFocus) tab.focus();
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next == null) return;
    event.preventDefault();
    selectTab(tabs[next], true);
  });
});

// ---------------------------------------------------------------------------
// Key status banner
// ---------------------------------------------------------------------------
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    const dot = $('#keyDot');
    const label = $('#keyLabel');
    if (data.keyConfigured) {
      dot.className = 'dot good';
      label.textContent = 'API key configured';
    } else {
      dot.className = 'dot bad';
      label.textContent = 'No API key — see .env';
    }
  } catch {
    $('#keyDot').className = 'dot bad';
    $('#keyLabel').textContent = 'server unreachable';
  }
}

// ---------------------------------------------------------------------------
// Voice selects (shared preset list + any custom voices we've fetched)
// ---------------------------------------------------------------------------
let customVoiceIds = [];
function refreshVoiceSelects() {
  populateVoiceSelect($('#ttsVoice'), customVoiceIds);
  populateVoiceSelect($('#avVoice'), customVoiceIds);
  populateVoiceSelect($('#rtVoice'));
}

// ---------------------------------------------------------------------------
// TTS tab
// ---------------------------------------------------------------------------
function initTTS() {
  const input = $('#ttsInput');
  const count = $('#ttsCount');
  const updateCount = () => (count.textContent = input.value.length);
  input.addEventListener('input', updateCount);
  updateCount();

  // Build tag chips; clicking inserts the token at the cursor.
  const groups = { emotion: '#emotionChips', style: '#styleChips', sfx: '#sfxChips', prosody: '#prosodyChips' };
  for (const [cat, sel] of Object.entries(groups)) {
    const box = $(sel);
    for (const name of TAGS[cat]) {
      const token = `<|${cat}:${name}|>`;
      box.append(el('button', {
        className: 'chip', type: 'button', textContent: name,
        onclick: () => insertAtCursor(input, token),
      }));
    }
  }

  $('#ttsGenerate').addEventListener('click', generateSpeech);
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.dispatchEvent(new Event('input'));
}

async function generateSpeech() {
  const btn = $('#ttsGenerate');
  const result = $('#ttsResult');
  const text = $('#ttsInput').value.trim();
  if (!text) return showResult(result, 'Enter some text first.', 'err');

  const timestamps = $('#ttsTimestamps').checked;
  const format = $('#ttsFormat').value;

  const body = {
    model: 'higgs-tts-3',
    input: text,
    response_format: format,
    enable_tn: $('#ttsEnableTn').checked,
    timestamps,
  };
  const tnLang = $('#ttsTnLang').value.trim();
  if (tnLang) body.tn_language = tnLang;

  const refAudio = $('#ttsRefAudio').value.trim();
  const refText = $('#ttsRefText').value.trim();
  if (refAudio) {
    body.ref_audio = refAudio;
    if (refText) body.ref_text = refText;
  } else {
    body.voice = $('#ttsVoice').value;
  }

  btn.disabled = true;
  showResult(result, 'Generating…', 'info');
  try {
    if (timestamps) {
      // JSON envelope: base64 audio + word timings.
      const data = await postJSON('/api/tts/speech', body);
      const row = showResult(result, 'Done — with word timestamps', 'ok');
      const mime = mimeFor(data.response_format || format);
      const blob = base64ToBlob(data.audio, mime);
      row.append(audioPlayer(blob));
      const pre = el('pre');
      pre.textContent = JSON.stringify(data.timestamps ?? null, null, 2);
      row.append(el('div', { className: 'muted', textContent: 'timestamps:' }), pre);
    } else {
      const blob = await postForBlob('/api/tts/speech', body);
      const row = showResult(result, `Done — ${format}, ${(blob.size / 1024).toFixed(1)} KB`, 'ok');
      row.append(audioPlayer(blob));
    }
  } catch (err) {
    showResult(result, 'Request failed', 'err', err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Voices tab
// ---------------------------------------------------------------------------
function initVoices() {
  $('#voiceCreate').addEventListener('click', createVoice);
  $('#voiceList').addEventListener('click', listVoices);
}

async function createVoice() {
  const result = $('#voicesResult');
  const refAudio = $('#voiceRefAudio').value.trim();
  const refText = $('#voiceRefText').value.trim();
  if (!refAudio || !refText) return showResult(result, 'ref_audio and ref_text are both required.', 'err');

  const body = { ref_audio: refAudio, ref_text: refText };
  const desc = $('#voiceDesc').value.trim();
  if (desc) body.description = desc;

  showResult(result, 'Creating voice…', 'info');
  try {
    const data = await postJSON('/api/voices', body);
    const id = data.voice || data.voice_id;
    showResult(result, `Voice created: ${id}`, 'ok', data);
    await listVoices();
  } catch (err) {
    showResult(result, 'Create failed', 'err', err.message);
  }
}

async function listVoices() {
  const container = $('#voicesList');
  container.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const res = await fetch('/api/voices');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || res.statusText);
    const list = Array.isArray(data) ? data : data.data || data.voices || [];
    customVoiceIds = list.map((v) => v.voice || v.voice_id).filter(Boolean);
    refreshVoiceSelects();

    container.innerHTML = '';
    if (!list.length) {
      container.append(el('div', { className: 'muted', textContent: 'No custom voices yet.' }));
      return;
    }
    for (const v of list) {
      const id = v.voice || v.voice_id;
      const item = el('div', { className: 'voice-item' });
      const info = el('div', {});
      info.append(el('code', { textContent: id }));
      if (v.description) info.append(el('div', { className: 'muted', textContent: v.description }));
      const acts = el('div', { className: 'acts' });
      acts.append(el('button', {
        className: 'ghost', textContent: 'Use in TTS',
        onclick: () => { $('#ttsVoice').value = id; $$('.tab')[0].click(); },
      }));
      acts.append(el('button', {
        className: 'danger', textContent: 'Delete',
        onclick: () => deleteVoice(id),
      }));
      item.append(info, acts);
      container.append(item);
    }
  } catch (err) {
    container.innerHTML = '';
    container.append(el('div', { className: 'err', textContent: err.message }));
  }
}

async function deleteVoice(id) {
  const result = $('#voicesResult');
  showResult(result, `Deleting ${id}…`, 'info');
  try {
    const res = await fetch(`/api/voices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || res.statusText);
    showResult(result, `Deleted ${id}`, 'ok', data);
    await listVoices();
  } catch (err) {
    showResult(result, 'Delete failed', 'err', err.message);
  }
}

// ---------------------------------------------------------------------------
// Avatar tab
// ---------------------------------------------------------------------------
let avImageDataUri = null; // holds the uploaded image as a data URI

function initAvatar() {
  const mode = $('#avMode');
  mode.addEventListener('change', () => {
    const isText = mode.value === 'input_tts';
    $('#avTextWrap').classList.toggle('hidden', !isText);
    $('#avVoice').closest('label').classList.toggle('hidden', !isText);
    $('#avAudioWrap').classList.toggle('hidden', isText);
  });

  // URL vs Upload source toggle.
  const urlBtn = $('#avSrcUrl');
  const upBtn = $('#avSrcUpload');
  const pickSource = (src) => {
    const isUrl = src === 'url';
    urlBtn.classList.toggle('active', isUrl);
    upBtn.classList.toggle('active', !isUrl);
    $('#avImageUrlWrap').classList.toggle('hidden', !isUrl);
    $('#avImageUploadWrap').classList.toggle('hidden', isUrl);
  };
  urlBtn.addEventListener('click', () => pickSource('url'));
  upBtn.addEventListener('click', () => pickSource('upload'));

  // Read the chosen file into a data URI + show a preview.
  $('#avImageFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    avImageDataUri = null;
    const preview = $('#avImagePreview');
    if (!file) return preview.classList.add('hidden');

    if (file.size > 10 * 1024 * 1024) {
      preview.classList.add('hidden');
      return showResult($('#avResult'), 'Image exceeds the 10 MB limit.', 'err');
    }
    avImageDataUri = await fileToDataUri(file);
    $('#avImagePreviewImg').src = avImageDataUri;
    $('#avImageMeta').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    preview.classList.remove('hidden');
  });

  $('#avGenerate').addEventListener('click', createVideo);
}

function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function createVideo() {
  const btn = $('#avGenerate');
  const result = $('#avResult');
  // Image comes from either the URL field or an uploaded file (data URI).
  const usingUpload = $('#avSrcUpload').classList.contains('active');
  const image = usingUpload ? avImageDataUri : $('#avImage').value.trim();
  if (!image) {
    return showResult(result, usingUpload ? 'Choose an image file to upload.' : 'ref_image URL is required.', 'err');
  }

  const body = { model: 'higgs-avatar', ref_image: image, size: $('#avSize').value };
  if ($('#avMode').value === 'input_tts') {
    const text = $('#avText').value.trim();
    if (!text) return showResult(result, 'Enter text for the avatar to speak.', 'err');
    body.input_tts = { model: 'higgs-tts-3', input: text, voice: $('#avVoice').value };
  } else {
    const audio = $('#avAudio').value.trim();
    if (!audio) return showResult(result, 'Provide a driving audio URL.', 'err');
    body.input = audio;
  }

  btn.disabled = true;
  const progressWrap = $('#avProgressWrap');
  const bar = $('#avBar');
  const statusLbl = $('#avStatus');
  progressWrap.classList.remove('hidden');
  bar.style.width = '0%';
  statusLbl.textContent = 'submitting…';
  showResult(result, 'Creating video job…', 'info');

  try {
    const job = await postJSON('/api/videos', body);
    const id = job.id;
    showResult(result, `Job created: ${id}`, 'info', job);

    // Poll until completed or failed.
    let status = job.status;
    while (status === 'queued' || status === 'in_progress') {
      await sleep(2500);
      const res = await fetch(`/api/videos/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || res.statusText);
      status = data.status;
      const pct = data.progress ?? (status === 'in_progress' ? 50 : 0);
      bar.style.width = `${pct}%`;
      statusLbl.textContent = `${status} · ${pct}%`;
      if (status === 'failed') throw new Error(data.error || 'Video generation failed.');
    }

    bar.style.width = '100%';
    statusLbl.textContent = 'completed · downloading';
    // Fetch the rendered MP4 bytes through our proxy.
    const vres = await fetch(`/api/videos/${encodeURIComponent(id)}/content`);
    if (!vres.ok) {
      const d = await vres.json().catch(() => ({}));
      throw new Error(d?.error?.message || 'Could not download video.');
    }
    const blob = await vres.blob();
    const row = showResult(result, `Video ready — ${(blob.size / 1024).toFixed(1)} KB`, 'ok');
    const video = el('video', { controls: true, src: URL.createObjectURL(blob) });
    row.append(video);
    const dl = el('a', { href: URL.createObjectURL(blob), download: `${id}.mp4`, textContent: 'Download MP4' });
    row.append(el('div', {}, dl));
    statusLbl.textContent = 'done';
  } catch (err) {
    showResult(result, 'Video failed', 'err', err.message);
    statusLbl.textContent = 'error';
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------
function mimeFor(fmt) {
  return { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', pcm: 'audio/L16' }[fmt] || 'audio/mpeg';
}
function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
function audioPlayer(blob) {
  const url = URL.createObjectURL(blob);
  const audio = el('audio', { controls: true, src: url });
  return audio;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
refreshVoiceSelects();
initTTS();
initVoices();
initAvatar();
initRealtime();
checkHealth();
listVoices().catch(() => {}); // best-effort: populate custom voices if a key is set
