// File importers. Each returns { title, author, chapters: [{ title, paragraphs, implicit? }] }.
import { cleanText, splitChapters } from './textproc.js';

const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

export async function importFile(file) {
  const name = file.name || 'Untitled';
  const ext = name.split('.').pop().toLowerCase();
  const baseTitle = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  if (ext === 'epub') {
    const JSZip = (await import(JSZIP_URL)).default;
    return parseEpub(await file.arrayBuffer(), { JSZip, DOMParser, fallbackTitle: baseTitle });
  }
  if (ext === 'pdf') {
    const pdfjs = await import(PDFJS_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    return parsePdf(await file.arrayBuffer(), { pdfjs, fallbackTitle: baseTitle });
  }
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') {
    const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
    const paragraphs = extractBlocks(doc.body);
    return fromParagraphs(paragraphs, doc.title || baseTitle);
  }
  // .txt, .md and anything else readable as text
  let text = await file.text();
  if (ext === 'md' || ext === 'markdown') text = stripMarkdown(text);
  return fromText(text, baseTitle);
}

export function fromText(text, title = 'Pasted text') {
  const cleaned = cleanText(text);
  return { title, author: '', chapters: splitChapters(cleaned) };
}

function fromParagraphs(paragraphs, title) {
  return fromText(paragraphs.join('\n\n'), title);
}

export function stripMarkdown(md) {
  return md
    .replace(/^```[\s\S]*?^```/gm, '')
    .replace(/^#{1,6}\s+(.*)$/gm, '\n$1\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '');
}

// ---------- EPUB ----------

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'dd', 'dt', 'figcaption', 'td', 'th', 'div', 'section', 'article', 'aside']);
const SKIP_TAGS = new Set(['script', 'style', 'sup', 'nav', 'head', 'title', 'svg', 'math', 'img', 'table']);

function tagOf(el) { return (el.localName || el.nodeName || '').toLowerCase(); }

/** Collect readable text blocks in document order. Leaf block elements become paragraphs. */
export function extractBlocks(root) {
  const out = [];
  const walk = (el) => {
    for (const child of Array.from(el.childNodes || [])) {
      if (child.nodeType !== 1) continue;
      const tag = tagOf(child);
      if (SKIP_TAGS.has(tag)) continue;
      if (BLOCK_TAGS.has(tag)) {
        const hasBlockChild = Array.from(child.children || []).some((c) => BLOCK_TAGS.has(tagOf(c)));
        if (hasBlockChild) {
          // Mixed content: grab loose text directly under this element, then recurse.
          const loose = Array.from(child.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim();
          if (loose) out.push({ tag, text: loose });
          walk(child);
        } else {
          const text = textWithoutSkipped(child).replace(/\s+/g, ' ').trim();
          if (text) out.push({ tag, text });
        }
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

function textWithoutSkipped(el) {
  let s = '';
  for (const n of Array.from(el.childNodes || [])) {
    if (n.nodeType === 3) s += n.textContent;
    else if (n.nodeType === 1) {
      const tag = tagOf(n);
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === 'br') { s += ' '; continue; }
      s += textWithoutSkipped(n);
    }
  }
  return s;
}

function resolvePath(base, rel) {
  rel = decodeURIComponent(rel.split('#')[0]);
  const parts = base.split('/');
  parts.pop();
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

function firstByLocalName(doc, name) {
  const all = doc.querySelectorAll('*');
  for (const el of Array.from(all)) if (tagOf(el).replace(/^.*:/, '') === name) return el;
  return null;
}
function allByLocalName(doc, name) {
  return Array.from(doc.querySelectorAll('*')).filter((el) => tagOf(el).replace(/^.*:/, '') === name);
}

export async function parseEpub(buffer, { JSZip, DOMParser, fallbackTitle = 'Untitled' }) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async (path) => {
    const f = zip.file(path) || zip.file(decodeURIComponent(path));
    if (!f) throw new Error(`Missing file in EPUB: ${path}`);
    return f.async('string');
  };
  const parser = new DOMParser();
  const container = parser.parseFromString(await read('META-INF/container.xml'), 'application/xml');
  const rootfile = firstByLocalName(container, 'rootfile');
  if (!rootfile) throw new Error('This EPUB has no package file.');
  const opfPath = rootfile.getAttribute('full-path');
  const opf = parser.parseFromString(await read(opfPath), 'application/xml');

  const title = (firstByLocalName(opf, 'title')?.textContent || fallbackTitle).trim();
  const author = (firstByLocalName(opf, 'creator')?.textContent || '').trim();

  const manifest = new Map();
  for (const item of allByLocalName(opf, 'item')) {
    manifest.set(item.getAttribute('id'), {
      href: resolvePath(opfPath, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    });
  }

  // Table of contents titles, keyed by file path (EPUB 3 nav, falling back to EPUB 2 NCX).
  const tocTitles = new Map();
  try {
    const navItem = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'));
    if (navItem) {
      const nav = parser.parseFromString(await read(navItem.href), 'application/xhtml+xml');
      for (const a of allByLocalName(nav, 'a')) {
        const href = a.getAttribute('href');
        if (!href) continue;
        const path = resolvePath(navItem.href, href);
        if (!tocTitles.has(path)) tocTitles.set(path, a.textContent.replace(/\s+/g, ' ').trim());
      }
    } else {
      const spineEl = firstByLocalName(opf, 'spine');
      const ncxItem = manifest.get(spineEl?.getAttribute('toc'));
      if (ncxItem) {
        const ncx = parser.parseFromString(await read(ncxItem.href), 'application/xml');
        for (const np of allByLocalName(ncx, 'navPoint')) {
          const label = firstByLocalName(np, 'text')?.textContent?.trim();
          const src = firstByLocalName(np, 'content')?.getAttribute('src');
          if (label && src) {
            const path = resolvePath(ncxItem.href, src);
            if (!tocTitles.has(path)) tocTitles.set(path, label);
          }
        }
      }
    }
  } catch { /* a broken TOC shouldn't block the import */ }

  const chapters = [];
  const spine = allByLocalName(opf, 'itemref');
  for (const ref of spine) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !/html|xml/.test(item.type)) continue;
    let doc;
    const src = await read(item.href);
    doc = parser.parseFromString(src, 'application/xhtml+xml');
    if (firstByLocalName(doc, 'parsererror')) doc = parser.parseFromString(src, 'text/html');
    const body = firstByLocalName(doc, 'body');
    if (!body) continue;
    const blocks = extractBlocks(body);
    if (!blocks.length) continue;

    let chapterTitle = tocTitles.get(item.href) || '';
    // If the section opens with a heading, use it as the title and don't read it twice.
    const first = blocks[0];
    if (/^h[1-4]$/.test(first.tag)) {
      if (!chapterTitle) chapterTitle = first.text;
      blocks.shift();
      // Two stacked headings ("Chapter 1" / "The Boy Who Lived") read as one title.
      if (blocks[0] && /^h[1-4]$/.test(blocks[0].tag) && blocks[0].text.length < 80) {
        if (!chapterTitle.includes(blocks[0].text)) chapterTitle = `${chapterTitle}: ${blocks[0].text}`;
        blocks.shift();
      }
    }
    const cleaned = cleanText(blocks.map((b) => b.text).join('\n\n'));
    const paragraphs = cleaned ? cleaned.split(/\n\n+/) : [];
    if (!paragraphs.length && !chapterTitle) continue;
    chapters.push({ title: chapterTitle || `Section ${chapters.length + 1}`, paragraphs });
  }
  if (!chapters.length) throw new Error('No readable text found in this EPUB.');
  return { title, author, chapters: chapters.filter((c) => c.paragraphs.length) };
}

// ---------- PDF ----------

export async function parsePdf(buffer, { pdfjs, fallbackTitle = 'Untitled' }) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  let title = fallbackTitle;
  let author = '';
  try {
    const meta = await pdf.getMetadata();
    if (meta?.info?.Title && meta.info.Title.trim().length > 2) title = meta.info.Title.trim();
    if (meta?.info?.Author) author = meta.info.Author.trim();
  } catch { /* ignore */ }

  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(pageToLines(content.items));
    page.cleanup();
  }

  // Running headers and footers repeat on many pages; drop them.
  const counts = new Map();
  for (const lines of pages) {
    const seen = new Set();
    for (const l of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      const key = l.text.replace(/\d+/g, '#').trim().toLowerCase();
      if (key && key.length <= 60 && !seen.has(key)) { seen.add(key); counts.set(key, (counts.get(key) || 0) + 1); }
    }
  }
  const threshold = Math.max(3, pages.length * 0.3);
  const repeated = new Set([...counts].filter(([, c]) => c >= threshold).map(([k]) => k));

  const text = pages.map((lines) => linesToText(
    lines.filter((l) => !repeated.has(l.text.replace(/\d+/g, '#').trim().toLowerCase())),
  )).join('\n\n');
  const cleaned = cleanText(text);
  if (cleaned.length < 20) throw new Error('This PDF has no selectable text. Scanned PDFs need OCR first.');
  return { title, author, chapters: splitChapters(cleaned) };
}

function pageToLines(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!('str' in it)) continue;
    const y = it.transform ? it.transform[5] : 0;
    const h = it.height || Math.abs(it.transform?.[3] || 10);
    if (!cur || Math.abs(cur.y - y) > h * 0.5) {
      if (cur && cur.text.trim()) lines.push(cur);
      cur = { y, h, text: it.str };
    } else {
      cur.text += (cur.text.endsWith(' ') || it.str.startsWith(' ') ? '' : ' ') + it.str;
    }
    if (it.hasEOL) { if (cur.text.trim()) lines.push(cur); cur = null; }
  }
  if (cur && cur.text.trim()) lines.push(cur);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }));
}

/** Rebuild paragraphs: a vertical gap larger than normal line spacing starts a new paragraph. */
function linesToText(lines) {
  if (!lines.length) return '';
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
  const sorted = [...gaps].sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] || 12;
  let out = lines[0].text;
  for (let i = 1; i < lines.length; i++) {
    const gap = Math.abs(lines[i - 1].y - lines[i].y);
    const prev = lines[i - 1].text;
    const newPara = gap > typical * 1.45 || (/[.!?"”]$/.test(prev) && prev.length < 45);
    out += newPara ? '\n\n' + lines[i].text : '\n' + lines[i].text;
  }
  return out;
}
