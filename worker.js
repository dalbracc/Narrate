// Voice generation worker: runs Kokoro TTS and streams MP3 chunks back to the page.
import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
import { Mp3Encoder } from 'https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.js';
import { StreamEncoder, normalise, trimSilence } from './audio.js';
import { PAUSES } from './textproc.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

let tts = null;
let loadedWith = null;
let cancelled = false;
let busy = false;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

function isAppleMobile() {
  const ua = self.navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (self.navigator.maxTouchPoints || 0) > 1);
}

async function hasWebGPU() {
  try {
    if (!self.navigator.gpu) return false;
    const adapter = await self.navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

async function load(mode = 'auto') {
  // Phones get the small quantised model on CPU: the full-precision GPU model needs ~330 MB
  // and Safari on iPhone kills tabs that use that much memory.
  let plan;
  if (mode === 'gpu') plan = [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }];
  else if (mode === 'cpu') plan = [{ device: 'wasm', dtype: 'q8' }];
  else if (isAppleMobile() || !(await hasWebGPU())) plan = [{ device: 'wasm', dtype: 'q8' }];
  else plan = [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }];

  const key = JSON.stringify(plan[0]);
  if (tts && loadedWith === key) { post({ type: 'ready', ...JSON.parse(key), cached: true }); return; }

  let lastError;
  for (const opt of plan) {
    try {
      const files = new Map();
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        ...opt,
        progress_callback: (p) => {
          if (p.status === 'progress' && p.file) {
            files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
            let loaded = 0; let total = 0;
            for (const f of files.values()) { loaded += f.loaded; total += f.total; }
            post({ type: 'loading', loaded, total });
          }
        },
      });
      // Warm up with a short sentence. Some GPUs run the model without errors but return noise,
      // so check that the output actually looks like speech before trusting this backend.
      const test = await tts.generate('Testing, one, two, three.', { voice: 'af_heart' });
      const problem = speechProblem(test.audio, test.sampling_rate);
      if (problem) throw new Error(`output was ${problem}, not speech`);
      loadedWith = JSON.stringify(opt);
      post({ type: 'ready', ...opt });
      return;
    } catch (err) {
      lastError = err;
      tts = null;
      post({ type: 'note', message: `${opt.device} didn't work (${err?.message || err}). Trying the next option.` });
    }
  }
  throw lastError || new Error('Could not load the voice model.');
}

/** Returns a short description if the audio doesn't look like speech, or '' if it does. */
function speechProblem(samples, rate) {
  if (!samples || !samples.length) return 'empty';
  let sumSq = 0;
  let peak = 0;
  let crossings = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!Number.isFinite(s)) return 'invalid';
    sumSq += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (i && (s >= 0) !== (samples[i - 1] >= 0)) crossings++;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const zcr = crossings / samples.length; // speech at 24 kHz sits well under 0.25; hiss is near 0.5
  const seconds = samples.length / rate;
  if (peak < 0.01 || rms < 0.003) return 'silence';
  if (zcr > 0.3) return 'noise';
  if (rms > 0.5 || peak > 20) return 'distorted';
  if (seconds < 0.5 || seconds > 8) return `the wrong length (${seconds.toFixed(1)}s)`;
  return '';
}

async function synth(text, voice, speed) {
  const audio = await tts.generate(text, { voice, speed });
  return { samples: audio.audio, rate: audio.sampling_rate };
}

async function generate({ bookId, items, voice, speed = 1, kbps = 48 }) {
  cancelled = false;
  busy = true;
  let encoder = null;
  let lastIndex = -1;
  let audioSec = 0;
  const started = performance.now();
  try {
    for (const item of items) {
      if (cancelled) break;
      let samples;
      let rate = 24000;
      try {
        const out = await synth(item.t, voice, speed);
        rate = out.rate;
        samples = normalise(trimSilence(out.samples, rate));
      } catch (err) {
        post({ type: 'note', message: `Skipped a passage it couldn't read: "${item.t.slice(0, 60)}…" (${err?.message || err})` });
        samples = new Float32Array(0);
      }
      if (!encoder) encoder = new StreamEncoder(Mp3Encoder, rate, kbps);
      const { bytes, samples: count } = encoder.encode(samples, PAUSES[item.p] ?? 0.2);
      audioSec += count / rate;
      lastIndex = item.i;
      const elapsed = (performance.now() - started) / 1000;
      post({ type: 'chunk', bookId, i: item.i, bytes, seconds: count / rate, speed: audioSec / Math.max(elapsed, 0.001) }, [bytes.buffer]);
      // Let a pending "cancel" message through between passages.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    if (encoder && lastIndex >= 0) {
      const tail = encoder.flush();
      post({ type: 'tail', bookId, i: lastIndex, bytes: tail }, [tail.buffer]);
    }
    busy = false;
    post({ type: 'done', bookId, cancelled });
  }
}

async function preview({ voice, text, speed = 1 }) {
  const { samples, rate } = await synth(text, voice, speed);
  const enc = new StreamEncoder(Mp3Encoder, rate, 64);
  const { bytes } = enc.encode(normalise(trimSilence(samples, rate)), 0.2);
  const tail = enc.flush();
  const all = new Uint8Array(bytes.length + tail.length);
  all.set(bytes); all.set(tail, bytes.length);
  post({ type: 'preview', bytes: all }, [all.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') await load(msg.mode);
    else if (msg.type === 'cancel') cancelled = true;
    else if (msg.type === 'generate') {
      if (busy) throw new Error('Already generating.');
      if (!tts) await load(msg.mode);
      await generate(msg);
    } else if (msg.type === 'preview') {
      if (!tts) await load(msg.mode);
      await preview(msg);
    }
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err), during: msg.type });
  }
};
