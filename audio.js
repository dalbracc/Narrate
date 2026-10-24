// MP3 encoding and ID3 tagging. No DOM; used by the worker and the main thread.

/** Streaming MP3 encoder that keeps state across chunks so there are no gaps between them. */
export class StreamEncoder {
  constructor(Mp3Encoder, sampleRate, kbps = 48) {
    this.enc = new Mp3Encoder(1, sampleRate, kbps);
    this.sampleRate = sampleRate;
  }

  /** Encode float samples (-1..1) plus trailing silence. Returns Uint8Array of complete MP3 frames. */
  encode(float32, silenceSec = 0) {
    const silence = Math.round(silenceSec * this.sampleRate);
    const pcm = new Int16Array(float32.length + silence);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const parts = [];
    const block = 1152 * 8;
    for (let i = 0; i < pcm.length; i += block) {
      const out = this.enc.encodeBuffer(pcm.subarray(i, i + block));
      if (out.length) parts.push(new Uint8Array(out));
    }
    return { bytes: concatBytes(parts), samples: pcm.length };
  }

  flush() {
    return new Uint8Array(this.enc.flush());
  }
}

export function concatBytes(parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Simple loudness normalisation so every chunk sits at a similar level. */
export function normalise(float32, targetPeak = 0.89) {
  let peak = 0;
  for (let i = 0; i < float32.length; i++) { const a = Math.abs(float32[i]); if (a > peak) peak = a; }
  if (peak < 1e-4) return float32;
  const gain = Math.min(3, targetPeak / peak);
  if (Math.abs(gain - 1) < 0.02) return float32;
  const out = new Float32Array(float32.length);
  for (let i = 0; i < float32.length; i++) out[i] = float32[i] * gain;
  return out;
}

/** Trim near-silent edges so the pauses we add are the pauses you hear. */
export function trimSilence(float32, sampleRate, threshold = 0.004) {
  const pad = Math.round(sampleRate * 0.03);
  let a = 0;
  let b = float32.length - 1;
  while (a < b && Math.abs(float32[a]) < threshold) a++;
  while (b > a && Math.abs(float32[b]) < threshold) b--;
  a = Math.max(0, a - pad);
  b = Math.min(float32.length - 1, b + pad);
  return float32.subarray(a, b + 1);
}

// ---------- ID3v2.3 ----------
// Exports carry a private TXXX frame with the book's text and chapter timings,
// so importing the MP3 on another device restores chapters and the "now reading" text.

const enc = new TextEncoder();
const dec = new TextDecoder();

function syncsafe(n) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}
function unsyncsafe(b, o) {
  return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
}

function frame(id, body) {
  const out = new Uint8Array(10 + body.length);
  out.set(enc.encode(id), 0);
  const n = body.length;
  out.set([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff], 4);
  out.set(body, 10);
  return out;
}

// v2.3 has no UTF-8; UTF-16 with BOM is the portable choice for text frames players display.
function utf16(str) {
  const out = new Uint8Array(2 + str.length * 2);
  out[0] = 0xff; out[1] = 0xfe;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out[2 + i * 2] = c & 0xff; out[3 + i * 2] = c >> 8;
  }
  return out;
}

function textFrame(id, str) {
  return frame(id, concatBytes([new Uint8Array([1]), utf16(str), new Uint8Array([0, 0])]));
}

export function buildId3({ title = '', artist = '', album = '', data = null }) {
  const frames = [];
  if (title) frames.push(textFrame('TIT2', title));
  if (artist) frames.push(textFrame('TPE1', artist));
  if (album) frames.push(textFrame('TALB', album));
  frames.push(textFrame('TCON', 'Audiobook'));
  if (data) {
    // Encoding 0 (Latin-1) with base64 payload keeps it ASCII-safe for any reader.
    const json = JSON.stringify(data);
    const b64 = toBase64(enc.encode(json));
    frames.push(frame('TXXX', concatBytes([new Uint8Array([0]), enc.encode('NARRATE'), new Uint8Array([0]), enc.encode(b64)])));
  }
  const body = concatBytes(frames);
  const header = new Uint8Array(10);
  header.set(enc.encode('ID3'), 0);
  header[3] = 3; header[4] = 0; header[5] = 0;
  header.set(syncsafe(body.length), 6);
  return concatBytes([header, body]);
}

/** Read our NARRATE payload (if any) and the tag size from the start of an MP3. */
export function readId3(bytes) {
  if (bytes.length < 10 || dec.decode(bytes.subarray(0, 3)) !== 'ID3') return { size: 0, data: null, title: '' };
  const size = 10 + unsyncsafe(bytes, 6);
  const version = bytes[3];
  let o = 10;
  let data = null;
  let title = '';
  while (o + 10 <= size && o + 10 <= bytes.length) {
    const id = dec.decode(bytes.subarray(o, o + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const n = version === 4 ? unsyncsafe(bytes, o + 4)
      : ((bytes[o + 4] << 24) | (bytes[o + 5] << 16) | (bytes[o + 6] << 8) | bytes[o + 7]) >>> 0;
    const body = bytes.subarray(o + 10, o + 10 + n);
    if (id === 'TXXX' && body[0] === 0) {
      const z = body.indexOf(0, 1);
      if (dec.decode(body.subarray(1, z)) === 'NARRATE') {
        try { data = JSON.parse(dec.decode(fromBase64(dec.decode(body.subarray(z + 1))))); } catch { data = null; }
      }
    } else if (id === 'TIT2') {
      title = decodeTextFrame(body);
    }
    o += 10 + n;
  }
  return { size, data, title };
}

function decodeTextFrame(body) {
  const encoding = body[0];
  const rest = body.subarray(1);
  if (encoding === 1 || encoding === 2) {
    let s = '';
    let i = 0;
    let le = true;
    if (rest[0] === 0xff && rest[1] === 0xfe) i = 2;
    else if (rest[0] === 0xfe && rest[1] === 0xff) { i = 2; le = false; }
    for (; i + 1 < rest.length; i += 2) {
      const c = le ? rest[i] | (rest[i + 1] << 8) : (rest[i] << 8) | rest[i + 1];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  return dec.decode(rest).replace(/\0.*$/, '');
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
