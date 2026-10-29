// Text cleanup, chapter detection and chunking for narration.
// Pure functions: no DOM, works in browser, worker and Node.

const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'St', 'Mt', 'Ft', 'Gen', 'Col', 'Capt', 'Lt',
  'Sgt', 'Rev', 'Gov', 'Sen', 'Rep', 'Hon', 'vs', 'etc', 'e.g', 'i.e', 'cf', 'approx', 'No',
  'Vol', 'Ch', 'Fig', 'Inc', 'Ltd', 'Co', 'Corp', 'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul',
  'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec', 'a.m', 'p.m', 'U.S', 'U.K',
];
const ABBR_SET = new Set(ABBREVIATIONS.map((a) => a.toLowerCase()));

const CHAPTER_RE = /^(?:(?:chapter|book|part)\s+(?:[0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty[\w-]*|thirty[\w-]*|forty[\w-]*|fifty[\w-]*)\b.*|prologue|epilogue|introduction|preface|foreword|afterword|acknowledg(?:e)?ments|interlude)$/i;

// Scene breaks ("* * *", "#", "⁂", "~~~") become this marker so they turn into a long pause.
export const SCENE_BREAK = '⁂';
const SCENE_BREAK_RE = /^\s*(?:[*•·~#⁂✱✦✧◆◇❖§=_\-–—]\s*){1,9}$/;
export function isSceneBreak(line) { return SCENE_BREAK_RE.test(line) && !/^\s*[-–—]\s*$/.test(line); }

/** Normalise raw text: line endings, hyphenated line breaks, soft wraps, stray page numbers. */
export function cleanText(raw) {
  let t = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '') // soft hyphens
    .replace(/[​﻿]/g, '')
    .replace(/\t/g, ' ')
    .replace(/ /g, ' ');

  // Drop lines that are only a page number ("12", "- 12 -", "Page 12").
  t = t.replace(/^[ \t]*(?:page\s+)?[-–—]?\s*\d{1,4}\s*[-–—]?[ \t]*$/gim, '');

  // Re-join words hyphenated across a line break: "narra-\ntion" -> "narration".
  t = t.replace(/([a-z])-\n[ \t]*([a-z])/g, '$1$2');

  // Paragraphs are separated by blank lines. Inside a paragraph, single newlines are soft wraps
  // unless the text looks like it was written one-paragraph-per-line (no blank lines at all).
  const hasBlankLines = /\n[ \t]*\n/.test(t);
  let paragraphs;
  if (hasBlankLines) {
    paragraphs = t.split(/\n[ \t]*\n+/).map((p) => {
      const lines = p.split('\n').map((l) => l.trim()).filter(Boolean);
      // A heading line on its own stays separate from the paragraph under it.
      const out = [];
      let buf = [];
      for (const line of lines) {
        const own = isHeading(line) || isSceneBreak(line);
        if (own && buf.length === 0) out.push(line);
        else if (own) { out.push(buf.join(' ')); buf = []; out.push(line); }
        else buf.push(line);
      }
      if (buf.length) out.push(buf.join(' '));
      return out;
    }).flat();
  } else {
    paragraphs = t.split('\n');
  }

  const out = [];
  for (const raw of paragraphs) {
    if (isSceneBreak(raw)) {
      // Keep one marker between real paragraphs; drop leading or doubled ones.
      if (out.length && out[out.length - 1] !== SCENE_BREAK) out.push(SCENE_BREAK);
      continue;
    }
    const p = normaliseSpacing(raw);
    if (p && /[\p{L}\p{N}]/u.test(p)) out.push(p);
  }
  if (out[out.length - 1] === SCENE_BREAK) out.pop();
  return out.join('\n\n');
}

function normaliseSpacing(p) {
  return p
    .replace(/\s+/g, ' ')
    .replace(/\s*—\s*/g, ' — ')
    .replace(/\s*--\s*/g, ' — ')
    .replace(/\.{3,}/g, '…')
    .replace(/\[\d{1,3}\]/g, '') // footnote markers like [12]
    .trim();
}

export function isHeading(line) {
  const l = line.trim();
  if (!l || l.length > 70) return false;
  if (CHAPTER_RE.test(l.replace(/[.:]+$/, ''))) return true;
  return false;
}

/**
 * Split cleaned plain text into chapters by heading lines.
 * Returns [{ title, paragraphs: string[] }].
 */
export function splitChapters(cleaned, fallbackTitle = 'Opening') {
  const paras = cleaned.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const chapters = [];
  let current = { title: fallbackTitle, paragraphs: [], implicit: true };
  for (const p of paras) {
    if (isHeading(p)) {
      if (current.paragraphs.length || !current.implicit) chapters.push(current);
      current = { title: titleCase(p.replace(/[.:]+$/, '')), paragraphs: [] };
    } else {
      current.paragraphs.push(p);
    }
  }
  if (current.paragraphs.length || !current.implicit) chapters.push(current);
  return chapters.filter((c) => c.paragraphs.length || c.title);
}

function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Split a paragraph into sentences, respecting common abbreviations, initials and decimals. */
export function splitSentences(paragraph) {
  const text = paragraph.trim();
  const out = [];
  let start = 0;
  const re = /([.!?…]+)(["'”’)\]]*)(\s+)(?=["'“‘(\[]?[\p{Lu}\p{N}])/gu;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[1].length + m[2].length;
    const before = text.slice(start, m.index);
    const lastWord = (before.match(/([\p{L}.]+)$/u) || [])[1] || '';
    if (m[1] === '.') {
      const w = lastWord.replace(/\.$/, '').toLowerCase();
      if (ABBR_SET.has(w)) continue;
      if (/^\p{Lu}$/u.test(lastWord)) continue; // initials like "J. R. R."
    }
    out.push(text.slice(start, end).trim());
    start = end + m[3].length;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/** Break an over-long sentence at clause punctuation, then at word boundaries. */
function splitLong(sentence, maxChars) {
  if (sentence.length <= maxChars) return [sentence];
  const parts = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = Math.max(
      window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '),
      window.lastIndexOf(', '),
    );
    if (cut < maxChars * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxChars;
    const piece = rest.slice(0, cut + 1).trim();
    parts.push(piece);
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// Silence appended after each chunk, in seconds. This is most of what makes the reading feel paced
// like a narrator: short breath between sentence groups, longer beat at paragraphs and chapters.
export const PAUSES = { s: 0.18, p: 0.55, h: 0.9, b: 1.5, c: 1.6 };

/**
 * Turn chapters into narration chunks.
 * Each chunk: { t: text, p: pause key, ch: chapter index }.
 * Chapter titles are read aloud as their own chunk.
 */
export function buildChunks(chapters, { maxChars = 280, readTitles = true } = {}) {
  const chunks = [];
  const chapterStarts = [];
  chapters.forEach((chapter, ci) => {
    chapterStarts.push(chunks.length);
    if (readTitles && chapter.title && !chapter.implicit) {
      chunks.push({ t: chapter.title.endsWith('.') ? chapter.title : chapter.title + '.', p: 'h', ch: ci });
    }
    let lastText = chapter.paragraphs.length - 1;
    while (lastText >= 0 && chapter.paragraphs[lastText] === SCENE_BREAK) lastText--;
    chapter.paragraphs.forEach((para, pi) => {
      if (para === SCENE_BREAK) {
        // Lengthen the pause after the passage before the break.
        const prev = chunks[chunks.length - 1];
        if (prev && prev.ch === ci && prev.p !== 'c' && prev.p !== 'h') prev.p = 'b';
        return;
      }
      const sentences = splitSentences(para).flatMap((s) => splitLong(s, maxChars));
      let group = '';
      const flush = (pause) => {
        if (group) chunks.push({ t: group, p: pause, ch: ci });
        group = '';
      };
      for (const s of sentences) {
        if (group && group.length + 1 + s.length > maxChars) flush('s');
        group = group ? group + ' ' + s : s;
      }
      const lastInChapter = pi >= lastText;
      flush(lastInChapter ? 'c' : 'p');
    });
  });
  // The chapter start might point past the end if a chapter was empty; clamp.
  return {
    chunks,
    chapters: chapters.map((c, i) => ({ title: c.title, start: Math.min(chapterStarts[i], Math.max(0, chunks.length - 1)) })),
  };
}

/** Rough listening time for planning: Kokoro narrates around 15 characters per second at 1x. */
export function estimateSeconds(chunks) {
  let chars = 0;
  let pause = 0;
  for (const c of chunks) { chars += c.t.length; pause += PAUSES[c.p] || 0; }
  return chars / 15 + pause;
}

export function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatLong(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${Math.max(1, m)} min`;
}
