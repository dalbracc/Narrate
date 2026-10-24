import { buildChunks, estimateSeconds, formatDuration, formatLong } from './textproc.js';
import { importFile, fromText } from './importers.js';
import { buildId3, readId3 } from './audio.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');

// ---------- voices and settings ----------

// Ordered by how natural they sound (the model card's own grades).
const VOICES = [
  ['af_heart', 'Heart', 'US female', 'A'], ['af_bella', 'Bella', 'US female', 'A-'],
  ['af_nicole', 'Nicole', 'US female, soft', 'B-'], ['bf_emma', 'Emma', 'UK female', 'B-'],
  ['am_fenrir', 'Fenrir', 'US male', 'C+'], ['am_michael', 'Michael', 'US male', 'C+'],
  ['am_puck', 'Puck', 'US male', 'C+'], ['af_aoede', 'Aoede', 'US female', 'C+'],
  ['af_kore', 'Kore', 'US female', 'C+'], ['af_sarah', 'Sarah', 'US female', 'C+'],
  ['bm_george', 'George', 'UK male', 'C'], ['bm_fable', 'Fable', 'UK male', 'C'],
  ['bf_isabella', 'Isabella', 'UK female', 'C'], ['af_alloy', 'Alloy', 'US female', 'C'],
  ['af_nova', 'Nova', 'US female', 'C'], ['af_sky', 'Sky', 'US female', 'C-'],
  ['bm_lewis', 'Lewis', 'UK male', 'D+'], ['am_echo', 'Echo', 'US male', 'D'],
  ['am_eric', 'Eric', 'US male', 'D'], ['am_liam', 'Liam', 'US male', 'D'],
  ['am_onyx', 'Onyx', 'US male', 'D'], ['bm_daniel', 'Daniel', 'UK male', 'D'],
  ['bf_alice', 'Alice', 'UK female', 'D'], ['bf_lily', 'Lily', 'UK female', 'D'],
];
const voiceName = (id) => (VOICES.find((v) => v[0] === id) || [id, id])[1];

// Leather bindings: oxblood, forest, tobacco, midnight, plum, saddle, bottle green, burgundy.
const CLOTHS = ['#6b2a26', '#2f4a33', '#6a4528', '#27324a', '#4e2d40', '#7a4a2a', '#23413a', '#5a2131'];
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];
const SKIP_TITLES = /^(contents|table of contents|copyright|index|dedication|title page|also by|other books|about the author|about the publisher|cover|half title|praise for|newsletter)/i;

const DEFAULT_SETTINGS = { voice: 'af_heart', pace: '1', kbps: '48', engine: 'auto' };
const settings = (() => {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('narrate.settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
})();
function saveSettings() { try { localStorage.setItem('narrate.settings', JSON.stringify(settings)); } catch { /* private mode */ } }

// ---------- storage (IndexedDB) ----------

let dbPromise;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('narrate', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('books', { keyPath: 'id' });
      d.createObjectStore('state', { keyPath: 'id' });
      d.createObjectStore('audio', { keyPath: ['bookId', 'i'] });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
async function os(name, mode = 'readonly') { return (await db()).transaction(name, mode).objectStore(name); }
const dbGet = async (s, k) => req((await os(s)).get(k));
const dbPut = async (s, v) => req((await os(s, 'readwrite')).put(v));
const dbAll = async (s) => req((await os(s)).getAll());
const audioRange = (id) => IDBKeyRange.bound([id, 0], [id, Infinity]);
const getAudio = async (id) => req((await os('audio')).getAll(audioRange(id)));

async function removeBook(id) {
  const tx = (await db()).transaction(['books', 'state', 'audio'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('state').delete(id);
  tx.objectStore('audio').delete(audioRange(id));
  await txDone(tx);
}

const books = new Map();
const states = new Map();

function saveState(st) {
  st.updated = Date.now();
  return dbPut('state', st).catch((e) => console.warn('save failed', e));
}

// ---------- small UI helpers ----------

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function show(view) {
  for (const id of ['library', 'add', 'player', 'settings']) $(id).hidden = id !== view;
  window.scrollTo(0, 0);
  if (view === 'library') renderLibrary();
}

function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

// ---------- book helpers ----------

const sum = (arr, n = arr.length) => { let s = 0; for (let i = 0; i < n; i++) s += arr[i] || 0; return s; };
const isComplete = (book, st) => book.imported || st.done >= book.total;
function generatedSeconds(st) { return sum(st.dur, st.done); }
function bookLength(book, st) {
  if (book.imported) return st.knownDuration || generatedSeconds(st);
  return isComplete(book, st) ? generatedSeconds(st) : generatedSeconds(st) + estimateSeconds(book.chunks.slice(st.done)) / book.pace;
}

// ---------- library ----------

async function loadLibrary() {
  const [bs, ss] = await Promise.all([dbAll('books'), dbAll('state')]);
  for (const b of bs) books.set(b.id, b);
  for (const s of ss) states.set(s.id, s);
}

let libraryQueued = false;
function renderLibrarySoon() {
  if (libraryQueued || $('library').hidden) return;
  libraryQueued = true;
  setTimeout(() => { libraryQueued = false; renderLibrary(); }, 1000);
}

function renderLibrary() {
  const list = [...books.values()].sort((a, b) => (states.get(b.id)?.updated || 0) - (states.get(a.id)?.updated || 0));
  const stack = $('stack');
  stack.replaceChildren();
  $('empty').hidden = list.length > 0;
  $('shelf-note').textContent = list.length ? `${list.length} ${list.length === 1 ? 'book' : 'books'}` : '';
  for (const book of list) {
    const st = states.get(book.id);
    const h = hash(book.id);
    const width = 86 + (h % 15);
    const offset = (h >> 4) % 3 === 0 ? 0 : (h >> 6) % (101 - width);
    let meta;
    let bar = 0;
    if (gen?.bookId === book.id) {
      const pct = Math.floor((st.done / book.total) * 100);
      meta = `Generating, ${pct}%`;
      bar = st.done / book.total;
    } else if (!isComplete(book, st)) {
      meta = `Paused at ${Math.floor((st.done / book.total) * 100)}% generated`;
      bar = st.done / book.total;
    } else {
      const len = bookLength(book, st);
      const left = Math.max(0, len - (st.position || 0));
      meta = st.position > 5 && left > 30 ? `${formatLong(left)} left` : st.finished ? 'Finished' : formatLong(len);
      bar = len ? (st.position || 0) / len : 0;
    }
    const by = book.author ? `${book.author}, ` : '';
    stack.append(el('li', {},
      el('button', {
        class: 'spine', type: 'button',
        style: `--cloth:${CLOTHS[h % CLOTHS.length]};--w:${width}%;--x:${offset}%`,
        onclick: () => openBook(book.id),
      },
      el('span', { class: 'spine-title' }, book.title),
      el('span', { class: 'spine-meta' }, by + meta),
      el('span', { class: 'spine-bar', style: `width:${Math.min(100, bar * 100).toFixed(1)}%` })),
    ));
  }
  updateStorageNote();
}

async function updateStorageNote() {
  try {
    const { usage } = await navigator.storage.estimate();
    if (usage > 5e6) $('storage-note').textContent = `Using ${Math.round(usage / 1e6)} MB on this device`;
  } catch { /* not supported */ }
}

// ---------- add a book ----------

let parsed = null;

function resetAdd() {
  parsed = null;
  $('review').hidden = true;
  $('add-error').hidden = true;
  $('file-input').value = '';
  $('paste-text').value = '';
}

function addError(msg) {
  const e = $('add-error');
  e.textContent = msg;
  e.hidden = !msg;
}

function setSource(src) {
  for (const b of document.querySelectorAll('[data-source]')) b.setAttribute('aria-pressed', String(b.dataset.source === src));
  $('source-file').hidden = src !== 'file';
  $('source-paste').hidden = src !== 'paste';
}

async function onFileChosen(file) {
  addError('');
  if (!file) return;
  if (/\.mp3$/i.test(file.name) || file.type === 'audio/mpeg') { await importAudio(file); return; }
  const drop = $('drop').querySelector('strong');
  const label = drop.textContent;
  drop.textContent = `Reading ${file.name}…`;
  try {
    showReview(await importFile(file));
  } catch (err) {
    console.error(err);
    addError(`Couldn't read that file. ${err?.message || ''}`.trim());
  } finally {
    drop.textContent = label;
  }
}

function onPaste() {
  const text = $('paste-text').value;
  if (text.trim().length < 2) { addError('Paste some text first.'); return; }
  addError('');
  const firstLine = text.trim().split('\n')[0].trim();
  const title = firstLine.length <= 60 && !/[.!?,;]$/.test(firstLine) ? firstLine : 'Pasted text';
  showReview(fromText(text, title));
}

function showReview(book) {
  if (!book.chapters.length) { addError('No readable text found.'); return; }
  parsed = book;
  $('book-title').value = book.title || '';
  $('book-author').value = book.author || '';
  const list = $('chapter-list');
  list.replaceChildren();
  book.chapters.forEach((ch, i) => {
    const chars = ch.paragraphs.reduce((a, p) => a + p.length, 0);
    const skip = book.chapters.length > 2 && (SKIP_TITLES.test(ch.title) || chars < 40);
    list.append(el('li', {}, el('label', {},
      el('input', { type: 'checkbox', checked: !skip, 'data-i': i, onchange: updateSummary }),
      el('span', { class: 'ct' }, ch.title || `Section ${i + 1}`),
      el('span', { class: 'cl' }, formatLong(chars / 15)),
    )));
  });
  $('review').hidden = false;
  updateSummary();
  $('book-title').focus({ preventScroll: true });
  $('review').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectedChapters() {
  return [...$('chapter-list').querySelectorAll('input:checked')].map((c) => parsed.chapters[+c.dataset.i]);
}

function updateSummary() {
  const chosen = selectedChapters();
  const { chunks } = buildChunks(chosen, { readTitles: $('read-titles').checked });
  const sec = estimateSeconds(chunks) / Number(settings.pace);
  $('create-btn').disabled = !chunks.length;
  $('add-summary').textContent = chunks.length
    ? `About ${formatLong(sec)} of listening, read by ${voiceName(settings.voice)}.`
    : 'Pick at least one chapter.';
}

async function createBook() {
  const chosen = selectedChapters();
  const { chunks, chapters } = buildChunks(chosen, { readTitles: $('read-titles').checked });
  if (!chunks.length) return;
  const id = crypto.randomUUID();
  const book = {
    id,
    title: $('book-title').value.trim() || 'Untitled',
    author: $('book-author').value.trim(),
    voice: settings.voice,
    pace: Number(settings.pace),
    kbps: Number(settings.kbps),
    chunks,
    chapters,
    total: chunks.length,
    cloth: CLOTHS[hash(id) % CLOTHS.length],
    createdAt: Date.now(),
  };
  const st = { id, done: 0, dur: [], position: 0, rate: 1 };
  await dbPut('books', book);
  await saveState(st);
  books.set(id, book);
  states.set(id, st);
  try { await navigator.storage?.persist?.(); } catch { /* optional */ }
  resetAdd();
  await openBook(id);
  startGeneration(book);
}

async function importAudio(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    let tagSize = 0;
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      tagSize = 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]);
    }
    const tag = tagSize ? readId3(new Uint8Array(await file.slice(0, tagSize).arrayBuffer())) : { data: null, title: '' };
    const data = tag.data;
    const id = crypto.randomUUID();
    const chunks = (data?.chunks || []).map((c) => ({ t: c.t, p: c.p || "s", ch: c.ch }));
    const book = {
      id,
      title: data?.title || tag.title || file.name.replace(/\.mp3$/i, ''),
      author: data?.author || '',
      voice: data?.voice || '',
      pace: 1,
      kbps: 48,
      chunks,
      chapters: data?.chapters || [],
      total: chunks.length,
      imported: true,
      cloth: CLOTHS[hash(id) % CLOTHS.length],
      createdAt: Date.now(),
    };
    const st = { id, done: chunks.length, dur: data?.dur || [], position: 0, rate: 1 };
    await dbPut('audio', { bookId: id, i: 0, data: file });
    await dbPut('books', book);
    await saveState(st);
    books.set(id, book);
    states.set(id, st);
    try { await navigator.storage?.persist?.(); } catch { /* optional */ }
    resetAdd();
    toast(chunks.length ? 'Imported with chapters and text.' : 'Imported.');
    await openBook(id);
  } catch (err) {
    console.error(err);
    addError(`Couldn't import that audio file. ${err?.message || ''}`);
  }
}

// ---------- generation ----------

let worker = null;
let gen = null; // { bookId, loading, loaded, total, speed, stopping, device }
let writes = Promise.resolve();
let wakeLock = null;
let previewPlayer = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    console.error('worker error', e);
    failGeneration(`The voice engine stopped${e.message ? `: ${e.message}` : ''}. Tap Resume to try again.`);
    try { worker.terminate(); } catch { /* already gone */ }
    worker = null;
  };
  return worker;
}

async function requestWakeLock() {
  try {
    if (gen && 'wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not allowed right now */ }
}
function releaseWakeLock() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }

function startGeneration(book) {
  const st = states.get(book.id);
  if (gen) {
    if (gen.bookId !== book.id) toast(`"${books.get(gen.bookId)?.title}" is generating. Pause it first.`);
    return;
  }
  if (st.done >= book.total) return;
  gen = { bookId: book.id, loading: true, loaded: 0, total: 0, speed: 0, note: '' };
  const items = book.chunks.slice(st.done).map((c, k) => ({ i: st.done + k, t: c.t, p: c.p }));
  getWorker().postMessage({
    type: 'generate', bookId: book.id, items, voice: book.voice, speed: book.pace, kbps: book.kbps, mode: settings.engine,
  });
  requestWakeLock();
  renderGen();
  renderLibrarySoon();
}

function pauseGeneration() {
  if (!gen || !worker) return;
  gen.stopping = true;
  worker.postMessage({ type: 'cancel' });
  renderGen();
}

function failGeneration(message) {
  const id = gen?.bookId;
  gen = null;
  releaseWakeLock();
  if (id && cur?.book.id === id) cur.genError = message;
  renderGen();
  renderLibrarySoon();
  toast(message, 6000);
}

function onWorkerMessage(e) {
  const m = e.data;
  switch (m.type) {
    case 'loading':
      if (gen) { gen.loaded = m.loaded; gen.total = m.total; renderGen(); }
      else setSettingsStatus(m.total ? `Downloading the voice, ${Math.floor((m.loaded / m.total) * 100)}%` : 'Downloading the voice…');
      break;
    case 'ready':
      if (gen) { gen.loading = false; gen.device = m.device; renderGen(); }
      engineNote(m);
      break;
    case 'note':
      console.info(m.message);
      if (gen) { gen.note = m.message; renderGen(); } else setSettingsStatus(m.message);
      break;
    case 'chunk': {
      const st = states.get(m.bookId);
      if (!st) break;
      if (gen) gen.speed = m.speed;
      const blob = new Blob([m.bytes], { type: 'audio/mpeg' });
      writes = writes.then(async () => {
        await dbPut('audio', { bookId: m.bookId, i: m.i, data: blob });
        st.dur[m.i] = m.seconds;
        st.done = Math.max(st.done, m.i + 1);
        await saveState(st);
        onChunkSaved(m.bookId);
      }).catch((err) => {
        console.error(err);
        pauseGeneration();
        toast('Ran out of storage space. Delete a book or free up space on the device, then resume.', 7000);
      });
      break;
    }
    case 'tail': {
      if (!m.bytes.length) break;
      writes = writes.then(async () => {
        const rec = await dbGet('audio', [m.bookId, m.i]);
        if (rec) await dbPut('audio', { ...rec, data: new Blob([rec.data, m.bytes], { type: 'audio/mpeg' }) });
      }).catch(console.error);
      break;
    }
    case 'done':
      writes = writes.then(() => {
        const book = books.get(m.bookId);
        const st = states.get(m.bookId);
        gen = null;
        releaseWakeLock();
        if (book && st && st.done >= book.total) toast(`"${book.title}" is ready to play with the screen off.`, 5000);
        renderGen();
        renderLibrarySoon();
        onChunkSaved(m.bookId);
      });
      break;
    case 'preview': {
      setSettingsStatus('');
      if (previewPlayer) { previewPlayer.pause(); URL.revokeObjectURL(previewPlayer.src); }
      previewPlayer = new Audio(URL.createObjectURL(new Blob([m.bytes], { type: 'audio/mpeg' })));
      previewPlayer.play().catch(() => toast('Tap Listen again to hear the sample.'));
      $('preview-btn').disabled = false;
      break;
    }
    case 'error':
      console.error('worker:', m.message);
      if (m.during === 'preview' || m.during === 'load') {
        $('preview-btn').disabled = false;
        setSettingsStatus(`The voice couldn't start: ${m.message}`, true);
      } else if (gen) {
        failGeneration(`Generation stopped: ${m.message}`);
      }
      break;
    default:
  }
}

function renderGen() {
  if (!cur) return;
  const { book } = cur;
  const st = states.get(book.id);
  const box = $('gen');
  if (isComplete(book, st)) { box.hidden = true; return; }
  box.hidden = false;
  const pct = book.total ? st.done / book.total : 0;
  $('gen-fill').style.width = `${(pct * 100).toFixed(1)}%`;
  const btn = $('gen-toggle');
  const note = $('gen-note');
  const status = $('gen-status');

  if (gen && gen.bookId === book.id) {
    btn.textContent = gen.stopping ? 'Pausing…' : 'Pause';
    btn.disabled = !!gen.stopping;
    btn.onclick = pauseGeneration;
    if (gen.loading) {
      status.textContent = gen.total ? `Downloading the voice, ${Math.floor((gen.loaded / gen.total) * 100)}%` : 'Starting the voice…';
      note.textContent = 'This happens once. After that the voice works offline.';
    } else {
      status.textContent = `Generating, ${Math.floor(pct * 100)}%`;
      const remaining = estimateSeconds(book.chunks.slice(st.done)) / book.pace;
      const eta = gen.speed > 0 ? remaining / gen.speed : 0;
      const parts = [];
      if (gen.speed > 0) parts.push(`${gen.speed.toFixed(1)}× real time, about ${formatLong(eta)} to go.`);
      parts.push(isIOS ? 'Keep this page open and the screen on until it finishes.' : 'Keep this tab open until it finishes.');
      note.textContent = parts.join(' ');
    }
  } else if (gen) {
    status.textContent = `Generated ${Math.floor(pct * 100)}%`;
    btn.textContent = 'Resume';
    btn.disabled = true;
    note.textContent = `Waiting for "${books.get(gen.bookId)?.title}" to finish generating.`;
  } else {
    status.textContent = `Generated ${Math.floor(pct * 100)}%`;
    btn.textContent = 'Resume';
    btn.disabled = false;
    btn.onclick = () => { cur.genError = null; startGeneration(book); };
    note.textContent = cur.genError || 'Generation pauses when the screen locks or you leave the page. You can listen to what is done so far.';
  }
}

function setSettingsStatus(msg, isError = false) {
  const e = $('settings-error');
  e.textContent = msg;
  e.hidden = !msg;
  e.style.color = isError ? '' : 'var(--muted)';
}

function engineNote({ device, threads = 1 } = {}) {
  if (!device) return;
  $('engine-note').textContent = device === 'webgpu'
    ? 'Running on the graphics card on this device.'
    : `Running on the processor on this device, using ${threads} ${threads === 1 ? 'thread' : 'threads'}.`;
}

function previewVoice() {
  if (gen) { toast('Pause generation to preview voices.'); return; }
  $('preview-btn').disabled = true;
  setSettingsStatus('Starting the voice…');
  getWorker().postMessage({
    type: 'preview',
    voice: $('voice').value,
    speed: Number($('pace').value),
    mode: settings.engine,
    text: 'The rain had not stopped for three days, and the river behind the mill was climbing the bank one stubborn inch at a time.',
  });
}

// ---------- player ----------

let cur = null; // { book, url, loadedDone, starts, pendingSeek, chunkIdx, stalled, genError }
let lastSave = 0;
let lastPositionState = 0;
let sleep = null; // { until } or { chapter }

function computeTimeline() {
  const st = states.get(cur.book.id);
  const n = st.done;
  const starts = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) starts[i + 1] = starts[i] + (st.dur[i] || 0);
  cur.starts = starts;
  cur.timelineEnd = starts[n];
}

function chunkAt(t) {
  const s = cur?.starts;
  if (!s || s.length < 2) return -1;
  let lo = 0;
  let hi = s.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function chapterOfChunk(i) {
  const { book } = cur;
  if (i < 0 || !book.chunks[i]) return -1;
  return book.chunks[i].ch;
}

function chapterTime(ci) {
  const start = cur.book.chapters[ci]?.start;
  if (start == null || !cur.starts || start >= cur.starts.length - 1) return null;
  return cur.starts[start];
}

function duration() {
  const d = audio.duration;
  if (cur?.timelineEnd > 0) return cur.timelineEnd;
  return Number.isFinite(d) ? d : 0;
}

function currentTime() {
  if (cur?.pendingSeek != null) return cur.pendingSeek;
  return audio.currentTime || 0;
}

async function openBook(id) {
  const book = books.get(id);
  if (!book) return;
  if (cur?.book.id !== id) await loadIntoPlayer(book, states.get(id).position || 0);
  show('player');
  renderPlayer();
  renderGen();
}

async function loadIntoPlayer(book, at, autoplay = false) {
  if (cur) savePosition(true);
  audio.pause();
  if (cur?.url) URL.revokeObjectURL(cur.url);
  const st = states.get(book.id);
  const recs = await getAudio(book.id);
  cur = { ...(cur?.book.id === book.id ? cur : {}), book, url: null, loadedDone: st.done, chunkIdx: -2, stalled: false, loading: false };
  computeTimeline();
  if (!recs.length) {
    audio.removeAttribute('src');
    audio.load();
    cur.pendingSeek = null;
    updateTimes();
    return;
  }
  cur.url = URL.createObjectURL(new Blob(recs.map((r) => r.data), { type: 'audio/mpeg' }));
  audio.src = cur.url;
  audio.defaultPlaybackRate = st.rate || 1;
  audio.playbackRate = st.rate || 1;
  cur.pendingSeek = at > 0 ? at : null;
  audio.load();
  setMediaSession();
  updateTimes();
  if (autoplay) play();
}

// iOS ignores currentTime until media has metadata, and sometimes until playback starts.
function applyPendingSeek() {
  if (cur?.pendingSeek == null) return;
  if (audio.readyState < 1) return;
  const target = cur.pendingSeek;
  try { audio.currentTime = target; } catch { return; }
  if (Math.abs(audio.currentTime - target) < 1.5) cur.pendingSeek = null;
}

function play() {
  if (!cur || !audio.src) { toast('Nothing to play yet. The first passage is still generating.'); return; }
  const st = states.get(cur.book.id);
  if (st.finished && currentTime() >= duration() - 1) { seek(0); st.finished = false; }
  audio.play().catch((err) => {
    console.warn(err);
    if (err.name !== 'AbortError') toast("Playback didn't start. Tap play again.");
  });
}

function togglePlay() { if (audio.paused) play(); else audio.pause(); }

function seek(t) {
  const d = duration();
  t = Math.max(0, Math.min(t, d ? d - 0.25 : t));
  if (audio.readyState >= 1) {
    try { audio.currentTime = t; cur.pendingSeek = null; } catch { cur.pendingSeek = t; }
  } else {
    cur.pendingSeek = t;
  }
  updateTimes();
  updatePassage(true);
  savePosition(true);
}

function savePosition(force = false) {
  if (!cur) return;
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  const st = states.get(cur.book.id);
  st.position = currentTime();
  st.rate = audio.playbackRate || 1;
  saveState(st);
}

function renderPlayer() {
  const { book } = cur;
  const st = states.get(book.id);
  $('p-title').textContent = book.title;
  const bits = [];
  if (book.author) bits.push(book.author);
  if (book.voice) bits.push(`read by ${voiceName(book.voice)}`);
  $('p-sub').textContent = bits.join(', ');
  $('speed-btn').textContent = `${st.rate || 1}×`;
  $('chapters-btn').disabled = !book.chapters.length;
  updateTimes();
  updatePassage(true);
  updatePlayIcon();
}

function updatePlayIcon() {
  const playing = !audio.paused;
  // SVG elements have no .hidden property, so toggle the attribute itself.
  $('icon-play').toggleAttribute('hidden', playing);
  $('icon-pause').toggleAttribute('hidden', !playing);
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

let scrubbing = false;
function updateTimes() {
  if (!cur) return;
  const d = duration();
  const t = Math.min(currentTime(), d || Infinity);
  const scrub = $('scrub');
  scrub.max = String(Math.max(d, 0.1));
  if (!scrubbing) scrub.value = String(t);
  $('t-cur').textContent = formatDuration(t);
  const st = states.get(cur.book.id);
  const rate = audio.playbackRate || 1;
  const left = (d - t) / rate;
  $('t-left').textContent = isComplete(cur.book, st) ? `-${formatDuration(left)}` : `${formatDuration(generatedSeconds(st))} so far`;
}

function updatePassage(force = false) {
  if (!cur) return;
  const { book } = cur;
  const textEl = $('p-text');
  const chEl = $('p-chapter');
  if (!book.chunks.length) {
    chEl.textContent = '';
    textEl.textContent = book.imported ? 'Imported audio' : '';
    textEl.classList.add('placeholder');
    return;
  }
  const st = states.get(book.id);
  if (!st.done) {
    chEl.textContent = book.chapters.length > 1 ? (book.chapters[0]?.title || '') : '';
    textEl.textContent = 'The first passage is being generated. Playback can start in a few seconds.';
    textEl.classList.add('placeholder');
    return;
  }
  if (cur.stalled) {
    textEl.textContent = 'Waiting for the next passage to finish generating…';
    textEl.classList.add('placeholder');
    return;
  }
  const i = Math.min(chunkAt(currentTime()), st.done - 1);
  if (!force && i === cur.chunkIdx) return;
  const prevChapter = chapterOfChunk(cur.chunkIdx);
  cur.chunkIdx = i;
  const chunk = book.chunks[i];
  if (!chunk) return;
  textEl.classList.remove('placeholder');
  // Show the passage being read plus a little of what follows, like a page.
  let text = chunk.t;
  for (let k = i + 1; k < Math.min(st.done, i + 3) && text.length < 360; k++) {
    if (book.chunks[k].ch !== chunk.ch) break;
    text += (book.chunks[k - 1].p === 's' ? ' ' : '\n\n') + book.chunks[k].t;
  }
  textEl.textContent = text;
  chEl.textContent = book.chapters.length > 1 ? (book.chapters[chunk.ch]?.title || '') : '';
  if (prevChapter !== chunk.ch) {
    setMediaSession();
    if (sleep?.chapter != null && prevChapter === sleep.chapter && chunk.ch !== sleep.chapter) {
      audio.pause();
      clearSleep();
      toast('Sleep timer: stopped at the end of the chapter.');
    }
  }
}

function setMediaSession() {
  if (!('mediaSession' in navigator) || !cur) return;
  const { book } = cur;
  const ch = book.chapters.length > 1 ? book.chapters[chapterOfChunk(Math.max(0, cur.chunkIdx))]?.title : '';
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: ch || book.author || 'Narrate',
      album: book.author || book.title,
      artwork: [
        { src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' },
        { src: new URL('icons/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' },
      ],
    });
  } catch { /* older browsers */ }
}

function updatePositionState(force = false) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = Date.now();
  if (!force && now - lastPositionState < 5000) return;
  lastPositionState = now;
  const d = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : duration();
  if (!d) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime || 0, d) });
  } catch { /* ignore */ }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => play(),
    pause: () => audio.pause(),
    stop: () => audio.pause(),
    seekbackward: (d) => seek(currentTime() - (d?.seekOffset || 15)),
    seekforward: (d) => seek(currentTime() + (d?.seekOffset || 30)),
    seekto: (d) => { if (d?.seekTime != null) seek(d.seekTime); },
  };
  for (const [k, fn] of Object.entries(handlers)) { try { ms.setActionHandler(k, fn); } catch { /* unsupported action */ } }
}

// When generation is still running, the loaded file ends where generation was when we loaded it.
// Reload with the newer passages and carry on from the same spot.
async function extendIfPossible(autoplay) {
  if (!cur) return false;
  const st = states.get(cur.book.id);
  if (st.done <= cur.loadedDone) return false;
  const at = cur.starts[cur.loadedDone] ?? currentTime();
  await loadIntoPlayer(cur.book, at, autoplay);
  return true;
}

function onChunkSaved(bookId) {
  if (cur?.book.id === bookId) {
    const st = states.get(bookId);
    if (cur.loading) {
      // A reload is already in flight; it will pick this passage up.
    } else if (cur.loadedDone === 0 && st.done > 0) {
      // First audio for this book: make it playable right away.
      cur.loading = true;
      loadIntoPlayer(cur.book, 0, false).then(() => { if (!$('player').hidden) renderPlayer(); });
    } else if (cur.stalled) {
      cur.stalled = false;
      cur.loading = true;
      extendIfPossible(true);
    }
    updateTimes();
    renderGen();
  }
  renderLibrarySoon();
}

function clearSleep() {
  sleep = null;
  $('sleep-btn').textContent = 'Sleep';
  $('sleep-btn').setAttribute('aria-pressed', 'false');
}

function tickSleep() {
  if (!sleep?.until) return;
  const left = sleep.until - Date.now();
  if (left <= 0) {
    audio.pause();
    clearSleep();
    return;
  }
  $('sleep-btn').textContent = formatDuration(left / 1000);
}

// ---------- menus ----------

function openMenu(title, body) {
  $('menu-title').textContent = title;
  $('menu-body').replaceChildren(body);
  $('menu').hidden = false;
  $('menu').querySelector('button')?.focus();
}
function closeMenu() { $('menu').hidden = true; }

function chaptersMenu() {
  const { book } = cur;
  const current = chapterOfChunk(cur.chunkIdx);
  const ul = el('ul', { class: 'menu-list' });
  book.chapters.forEach((ch, i) => {
    const t = chapterTime(i);
    ul.append(el('li', {}, el('button', {
      type: 'button',
      disabled: t == null,
      'aria-current': i === current ? 'true' : null,
      onclick: () => { closeMenu(); seek(t); if (audio.paused) play(); },
    }, el('span', {}, ch.title || `Section ${i + 1}`), el('span', { class: 'side' }, t == null ? 'Not generated yet' : formatDuration(t)))));
  });
  openMenu('Chapters', ul);
  ul.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'center' });
}

function sleepMenu() {
  const ul = el('ul', { class: 'menu-list' });
  const option = (label, fn) => ul.append(el('li', {}, el('button', { type: 'button', onclick: () => { fn(); closeMenu(); } }, label)));
  option('Off', clearSleep);
  for (const min of [10, 20, 30, 45, 60]) {
    option(`${min} minutes`, () => {
      sleep = { until: Date.now() + min * 60000 };
      $('sleep-btn').setAttribute('aria-pressed', 'true');
      tickSleep();
    });
  }
  if (cur.book.chapters.length) {
    option('End of this chapter', () => {
      sleep = { chapter: chapterOfChunk(cur.chunkIdx) };
      $('sleep-btn').textContent = 'End of ch.';
      $('sleep-btn').setAttribute('aria-pressed', 'true');
    });
  }
  openMenu('Sleep timer', ul);
}

function moreMenu() {
  const { book } = cur;
  const st = states.get(book.id);
  const body = el('div', {});
  const actions = el('div', { class: 'book-actions' });
  const done = isComplete(book, st);

  const exportBtn = el('button', { class: 'btn', type: 'button', disabled: !st.done && !book.imported }, done ? 'Export MP3' : 'Export what\'s done');
  exportBtn.onclick = async () => {
    exportBtn.disabled = true;
    exportBtn.textContent = 'Preparing…';
    try {
      const file = await buildExport(book);
      // Sharing needs a fresh tap, so swap in a second button once the file is ready.
      const canShare = isIOS && navigator.canShare?.({ files: [file] });
      const saveBtn = el('button', { class: 'btn primary', type: 'button' }, canShare ? 'Share or save MP3' : 'Download MP3');
      saveBtn.onclick = async () => {
        if (canShare) {
          try { await navigator.share({ files: [file], title: book.title }); } catch (err) { if (err.name !== 'AbortError') download(file); }
        } else download(file);
      };
      exportBtn.replaceWith(saveBtn);
      body.append(el('p', { class: 'shelf-note', style: 'margin:10px 2px 0' },
        `${Math.round(file.size / 1e6)} MB. Import it in Narrate on another device to keep chapters and text, or play it in any audio app.`));
    } catch (err) {
      console.error(err);
      exportBtn.textContent = 'Export failed';
    }
  };
  actions.append(exportBtn);

  actions.append(el('button', {
    class: 'btn', type: 'button',
    onclick: () => { closeMenu(); seek(0); },
  }, 'Start over'));

  const del = el('button', { class: 'btn danger', type: 'button' }, 'Delete book');
  del.onclick = async () => {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Tap again to delete'; return; }
    if (gen?.bookId === book.id) pauseGeneration();
    await writes;
    audio.pause();
    if (cur?.url) URL.revokeObjectURL(cur.url);
    audio.removeAttribute('src');
    audio.load();
    cur = null;
    await removeBook(book.id);
    books.delete(book.id);
    states.delete(book.id);
    closeMenu();
    show('library');
    toast('Deleted.');
  };
  actions.append(del);
  body.append(actions);

  const info = [];
  if (book.voice) info.push(`Voice: ${voiceName(book.voice)}`);
  if (!book.imported) info.push(`${book.total} passages, ${st.done} generated`);
  body.append(el('p', { class: 'shelf-note', style: 'margin:14px 2px 0' }, info.join('. ')));
  openMenu(book.title, body);
}

async function buildExport(book) {
  const st = states.get(book.id);
  const recs = await getAudio(book.id);
  const parts = recs.map((r) => r.data);
  const name = `${book.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80).trim() || 'audiobook'}.mp3`;
  if (book.imported) return new File(parts, name, { type: 'audio/mpeg' });
  const tag = buildId3({
    title: book.title,
    artist: book.author || `Narrate (${voiceName(book.voice)})`,
    album: book.title,
    data: {
      v: 1,
      title: book.title,
      author: book.author,
      voice: book.voice,
      chapters: book.chapters.filter((c) => c.start < st.done),
      chunks: book.chunks.slice(0, st.done).map((c) => ({ t: c.t, p: c.p, ch: c.ch })),
      dur: st.dur.slice(0, st.done),
    },
  });
  return new File([tag, ...parts], name, { type: 'audio/mpeg' });
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

// ---------- settings view ----------

function renderSettings() {
  const sel = $('voice');
  if (!sel.options.length) {
    for (const [id, name, desc, grade] of VOICES) sel.append(el('option', { value: id }, `${name}, ${desc} (${grade})`));
  }
  sel.value = settings.voice;
  $('pace').value = settings.pace;
  $('kbps').value = settings.kbps;
  $('engine').value = settings.engine;
  setSettingsStatus('');
}

// ---------- wiring ----------

function wire() {
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'home') { if (!$('add').hidden) resetAdd(); show('library'); }
    if (action === 'add') { resetAdd(); show('add'); }
    if (action === 'close-menu') closeMenu();
  });
  $('menu').addEventListener('click', (e) => { if (e.target === $('menu')) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('menu').hidden) closeMenu();
    if (e.key === ' ' && !$('player').hidden && $('menu').hidden && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); togglePlay(); }
  });

  $('add-btn').onclick = () => { resetAdd(); show('add'); };
  $('settings-btn').onclick = () => { renderSettings(); show('settings'); };
  for (const b of document.querySelectorAll('[data-source]')) b.onclick = () => setSource(b.dataset.source);
  $('file-input').onchange = (e) => onFileChosen(e.target.files[0]);
  $('paste-go').onclick = onPaste;
  $('read-titles').onchange = updateSummary;
  $('create-btn').onclick = () => { $('create-btn').disabled = true; createBook().finally(() => { $('create-btn').disabled = false; }); };

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); });
  drop.addEventListener('drop', (e) => { e.preventDefault(); onFileChosen(e.dataTransfer.files[0]); });

  $('voice').onchange = (e) => { settings.voice = e.target.value; saveSettings(); };
  $('pace').onchange = (e) => { settings.pace = e.target.value; saveSettings(); };
  $('kbps').onchange = (e) => { settings.kbps = e.target.value; saveSettings(); };
  $('engine').onchange = (e) => {
    settings.engine = e.target.value;
    saveSettings();
    if (!gen && worker) { worker.terminate(); worker = null; }
  };
  $('preview-btn').onclick = previewVoice;

  $('play').onclick = togglePlay;
  $('back15').onclick = () => seek(currentTime() - 15);
  $('fwd30').onclick = () => seek(currentTime() + 30);
  $('speed-btn').onclick = () => {
    const i = SPEEDS.indexOf(audio.playbackRate);
    const next = SPEEDS[(i + 1) % SPEEDS.length] || 1;
    audio.playbackRate = next;
    audio.defaultPlaybackRate = next;
    $('speed-btn').textContent = `${next}×`;
    if (cur) { states.get(cur.book.id).rate = next; savePosition(true); }
    updatePositionState(true);
    updateTimes();
  };
  $('chapters-btn').onclick = chaptersMenu;
  $('sleep-btn').onclick = sleepMenu;
  $('more-btn').onclick = moreMenu;

  const scrub = $('scrub');
  scrub.addEventListener('input', () => {
    scrubbing = true;
    $('t-cur').textContent = formatDuration(Number(scrub.value));
  });
  scrub.addEventListener('change', () => { scrubbing = false; seek(Number(scrub.value)); });

  audio.addEventListener('loadedmetadata', () => {
    applyPendingSeek();
    if (cur?.book.imported && !cur.timelineEnd && Number.isFinite(audio.duration)) {
      const st = states.get(cur.book.id);
      if (!st.knownDuration) { st.knownDuration = audio.duration; saveState(st); }
    }
    updateTimes();
    updatePositionState(true);
  });
  audio.addEventListener('canplay', applyPendingSeek);
  audio.addEventListener('playing', () => { applyPendingSeek(); updatePositionState(true); });
  audio.addEventListener('play', () => { document.documentElement.classList.add('playing'); updatePlayIcon(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  audio.addEventListener('pause', () => {
    document.documentElement.classList.remove('playing');
    updatePlayIcon();
    savePosition(true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  audio.addEventListener('timeupdate', () => {
    if (!cur) return;
    if (cur.pendingSeek != null) applyPendingSeek();
    updateTimes();
    updatePassage();
    savePosition();
    updatePositionState();
    tickSleep();
  });
  audio.addEventListener('ratechange', () => updatePositionState(true));
  audio.addEventListener('ended', async () => {
    if (!cur) return;
    if (await extendIfPossible(true)) return;
    const st = states.get(cur.book.id);
    if (gen?.bookId === cur.book.id || !isComplete(cur.book, st)) {
      cur.stalled = gen?.bookId === cur.book.id;
      updatePassage(true);
      if (!cur.stalled) toast('That is everything generated so far. Resume generating to hear more.', 5000);
      return;
    }
    st.finished = true;
    st.position = duration();
    saveState(st);
    toast('The end.');
  });
  audio.addEventListener('error', () => {
    if (audio.src) toast("This audio couldn't be played. Try exporting and re-importing it.", 5000);
  });

  setInterval(() => { if (sleep?.until) tickSleep(); }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePosition(true);
    else requestWakeLock();
  });
  window.addEventListener('pagehide', () => savePosition(true));
  window.addEventListener('beforeunload', (e) => {
    if (gen) { e.preventDefault(); e.returnValue = ''; }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  // On computers the service worker adds headers that let the voice use several processor
  // threads. They only take effect on a fresh load, so reload once when a new worker takes over.
  if (isIOS) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (window.crossOriginIsolated || gen || !audio.paused) return;
    let tried = false;
    try { tried = sessionStorage.getItem('narrate.isolate') === '1'; sessionStorage.setItem('narrate.isolate', '1'); } catch { /* ignore */ }
    if (!tried) location.reload();
  });
}

async function init() {
  if (isIOS && isStandalone) $('standalone-warning').hidden = false;
  setupMediaSession();
  wire();
  registerServiceWorker();
  try {
    await loadLibrary();
  } catch (err) {
    console.error(err);
    toast("Couldn't open this device's book storage. Private browsing blocks it.", 8000);
  }
  renderLibrary();
}

init();
