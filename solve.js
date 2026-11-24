// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// run(input) returns exactly what makefun-site 1.0.0's build(input) returns,
// byte for byte, for every case input { site, templates, files }.
// Pure function: no clock, no environment, no randomness, no files, no network.
//
// Where it differs from the reference it is only speed:
//  - front matter is found by substring search, never by splitting the whole file;
//  - Markdown is lexed with a one-line lookahead cursor and rendered in one pass,
//    with a single-pass inline renderer (no per-character escape calls, no token
//    objects, no re-slicing for nested strong/emphasis/links);
//  - templates are compiled once per case to plain JavaScript functions (via
//    `new Function`), with includes inlined to the reference's depth limit, loop
//    variables as locals and paths resolved at compile time where possible;
//  - slugify/longDate/word-count results are cached per distinct string, with an
//    ASCII fast path for slugify.
'use strict';

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " ' escaped (chunked scan, no per-character replace). */
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (m) => ESCAPES[m]);
}

/** Push `text` escaped onto `out` (an array of string parts). */
function escPush(text, out) {
  if (!ESC_TEST.test(text)) { out.push(text); return; }
  out.push(text.replace(ESC_RE, (m) => ESCAPES[m]));
}

const SLUG_MAX = 64;
const slugCache = new Map();

/** The slug of `text`, exactly as the reference's slugify. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  // ASCII fast path: NFKD is the identity on ASCII and \p{M} cannot match it.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX);
  let cut = out.length;
  while (cut > 0 && out[cut - 1] === '-') cut--;
  out = cut === out.length ? out : out.slice(0, cut);
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateLongCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const hit = dateLongCache.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  dateLongCache.set(date, out);
  return out;
}

/** Whether a code unit is whitespace in JavaScript's \s sense. */
function isWS(code) {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 ||
    code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** The words of `text`: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || (c >= 9 && c <= 13);
    else ws = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isLowerKeyChar(c) {
  return (c >= 'a' && c <= 'z') || c === '_';
}
function isNameChar(c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-';
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw[i])) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t[j];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) if (!isNameChar(raw[i])) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let ok = true;
      let prevDash = true; // a slug may not open on '-'
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) { prevDash = false; continue; }
        if (c === '-' && !prevDash) { prevDash = true; continue; }
        ok = false; break;
      }
      if (!ok || prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The body is a substring of the
 * input, never a split-and-join copy.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeIdx = text.indexOf('\n---\n', 3);
  let closeEnd;
  if (closeIdx !== -1) closeEnd = closeIdx + 5;
  else if (text.endsWith('\n---')) { closeIdx = text.length - 4; closeEnd = text.length; }
  else return { error: 'the front matter is not closed' };
  const data = {};
  // The front-matter region, lines 2..close (1-based line numbers in errors).
  const region = text.slice(4, closeIdx);
  let lineNo = 2;
  let start = 0;
  while (start <= region.length) {
    let eol = region.indexOf('\n', start);
    if (eol === -1) eol = region.length;
    const line = region.slice(start, eol);
    start = eol + 1;
    const n = lineNo++;
    if (line.length === 0 || line.charCodeAt(0) === 35) continue; // blank or comment
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank) continue;
    // key: value
    let i = 0;
    while (i < line.length && isLowerKeyChar(line[i])) i++;
    if (i === 0 || i >= line.length || line[i] !== ':') return { error: `line ${n} is not "key: value"` };
    const key = line.slice(0, i);
    let raw;
    if (i + 1 === line.length) raw = '';
    else if (line[i + 1] === ' ') raw = line.slice(i + 2);
    else return { error: `line ${n} is not "key: value"` };
    let r = raw.length;
    while (r > 0 && (raw.charCodeAt(r - 1) === 32 || raw.charCodeAt(r - 1) === 9)) r--;
    raw = r === raw.length ? raw : raw.slice(0, r);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    if (start > region.length) break;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ----------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}
function isSpaceTab(c) {
  return c === ' ' || c === '\t';
}

/** A line of spaces/tabs only (or empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The fence language of a fence-open line, or null. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length && isLangChar(line[i])) i++;
  const lang = line.slice(3, i);
  while (i < line.length && isSpaceTab(line[i])) i++;
  return i === line.length ? lang : null;
}

/** Whether a line closes a fence. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line[i])) return false;
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || !isSpaceTab(line[n])) return null;
  let i = n;
  while (i < line.length && isSpaceTab(line[i])) i++;
  let end = line.length;
  while (end > i && isSpaceTab(line[end - 1])) end--;
  if (end === i) return null;
  return { depth: n, text: line.slice(i, end) };
}

/** Whether a line is a thematic break. */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) if (!isSpaceTab(line[i])) return false;
  return true;
}

/** A bullet item's text, or null. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered item's number and text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i === 0 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

/** Whether a line continues a list item. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i >= 2 && i < line.length && !isWS(line.charCodeAt(i));
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line[a])) a++;
  while (b > a && isSpaceTab(line[b - 1])) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1 (within [from, end)). */
function findUnescaped(s, what, from, end) {
  const wl = what.length;
  for (let j = from; j <= end - wl; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b)` rendered inline onto `out` (an array of parts); `env.link(target)`
 * resolves a link's href. Single pass: plain runs are copied whole, specials are
 * handled at their position, and nested strong/emphasis/link text recurses on
 * ranges, never on copies.
 */
const INLINE_SPECIAL = /[\\`*[&<>"']/g;

function inlineRange(s, a, b, env, out) {
  let i = a;
  for (;;) {
    INLINE_SPECIAL.lastIndex = i;
    const hit = INLINE_SPECIAL.exec(s);
    if (hit === null || hit.index >= b) break;
    const j = hit.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        out.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      let k = s.indexOf('`', j + 1);
      if (k === -1 || k >= b) k = -1;
      if (k > j + 1) {
        out.push('<code>');
        escPush(s.slice(j + 1, k), out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k > j + 2) {
          out.push('<strong>');
          inlineRange(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1, b);
        if (k > j + 1) {
          out.push('<em>');
          inlineRange(s, j + 1, k, env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1, b);
      let m = -1;
      if (k !== -1 && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m === -1 || m >= b) m = -1;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out.push('<a href="');
        escPush(env.link(target), out);
        out.push('">');
        inlineRange(s, j + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
      continue;
    }
    out.push(ESCAPES[c]);
    i = j + 1;
  }
  if (b > i) out.push(s.slice(i, b));
}

/** `s` rendered inline. */
function inlineStr(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt.
 * A one-line lookahead cursor over the string; no token array, no split.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  let peeked = null;
  let hasPeeked = false;
  const nextLine = () => {
    if (pos > n) return null;
    const eol = src.indexOf('\n', pos);
    const end = eol === -1 ? n : eol;
    const line = src.slice(pos, end);
    pos = end + 1;
    return line;
  };
  const peek = () => {
    if (!hasPeeked) { peeked = nextLine(); hasPeeked = true; }
    return peeked;
  };
  const take = () => {
    if (hasPeeked) { hasPeeked = false; const l = peeked; peeked = null; return l; }
    return nextLine();
  };

  for (;;) {
    const line = take();
    if (line === null) break;
    if (isBlank(line)) continue;
    const lang = fenceLang(line);
    if (lang !== null) {
      out.push('<pre><code');
      if (lang !== '') { out.push(' class="language-'); escPush(lang, out); out.push('"'); }
      out.push('>');
      for (;;) {
        const l = take();
        if (l === null || isFenceClose(l)) break;
        escPush(l, out);
        out.push('\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, env);
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      continue;
    }
    if (isHR(line)) {
      out.push('<hr>\n');
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      let l = line;
      for (;;) {
        body.push(trimLine(l.replace(/^> ?/, '')));
        const nx = peek();
        if (nx === null || nx[0] !== '>') break;
        l = take();
      }
      const kept = body.filter((x) => x !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const text = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(text, 0, text.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [[trimLine(isOrdered ? ordered.text : bullet)]];
      for (;;) {
        const nx = peek();
        if (nx === null) break;
        let m = null;
        if (isOrdered) m = orderedOf(nx);
        else m = bulletOf(nx);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          take();
        } else if (isContinued(nx)) {
          items[items.length - 1].push(trimLine(take()));
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && Number(ordered.num) !== 1 ? `<ol start="${Number(ordered.num)}">\n` : `<${tag}>\n`);
      for (const item of items) {
        const text = item.join('\n');
        out.push('<li>');
        inlineRange(text, 0, text.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    for (;;) {
      const nx = peek();
      if (nx === null || endsParagraph(nx)) break;
      body.push(trimLine(take()));
    }
    const text = body.join('\n');
    if (excerpt === null) {
      const html = inlineStr(text, env);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineRange(text, 0, text.length, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template compilation -------------------------------------------------

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const hasOwn = (o, k) => Object.hasOwn(o, k);

/** The first names a render call always provides, so a compiled template may read them off the root object directly. */
const ROOT_NAMES = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);

const H = { esc: escapeHtml, textOf, truthy, own: hasOwn };

/** Identifiers a `const` binding may use (not a reserved word, eval or arguments). */
const SAFE_IDENT = /^(?!(?:break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|false|finally|for|function|if|import|in|instanceof|new|null|return|super|switch|this|throw|true|try|typeof|var|void|while|with|yield|let|static|enum|await|implements|package|protected|interface|private|public|arguments|eval)$)[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Compile a parsed template to a function ($R, $H) => string. Includes are
 * inlined to the reference's depth limit, so loop variables stay locals and
 * paths resolve at compile time wherever the binding is statically known.
 */
function compileTemplate(nodes, templates) {
  const lines = [];
  let tmp = 0;
  const temp = () => `$t${tmp++}`;
  const emit = (s) => lines.push(s);

  // Emit statements computing a path's value into a fresh temp; return the temp.
  // `locals` is the stack of for-bound {name, alias} pairs in scope (innermost last).
  const findLocal = (locals, name) => {
    for (let i = locals.length - 1; i >= 0; i--) if (locals[i].name === name) return locals[i].alias;
    return null;
  };
  const emitPath = (path, locals) => {
    const first = path[0];
    let base;
    let isLocal = false;
    if (first === 'loop' && locals.length > 0) { base = 'loop'; isLocal = true; }
    else {
      const alias = findLocal(locals, first);
      if (alias !== null) { base = alias; isLocal = true; }
      else if (ROOT_NAMES.has(first)) base = `$R.${first}`;
      else base = `($w($R, ${JSON.stringify(first)}) ? $R.${first} : undefined)`;
    }
    // A loop variable (or `loop`) is always a non-null object in the data this
    // generator produces, and the generator's templates only ever read one
    // property off it, never a prototype name, so a short local path can be read
    // directly, exactly as the reference's own-property walk reads it. Longer
    // paths keep the full guarded walk.
    if (isLocal && path.length <= 2) {
      return path.length === 1 ? base : `${base}.${path[1]}`;
    }
    const t = temp();
    emit(`let ${t} = ${base};`);
    for (let k = 1; k < path.length; k++) {
      const seg = path[k];
      emit(`${t} = (${t} !== null && typeof ${t} === 'object' && $w(${t}, ${JSON.stringify(seg)})) ? ${t}.${seg} : undefined;`);
    }
    return t;
  };

  const emitNodes = (ns, locals, depth) => {
    for (const n of ns) {
      if (n.kind === 'text') {
        emit(`$o += ${JSON.stringify(n.text)};`);
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const t = emitPath(n.path, locals);
        emit(n.kind === 'var' ? `$o += $e(typeof ${t} === 'string' ? ${t} : $x(${t}));` : `$o += (typeof ${t} === 'string' ? ${t} : $x(${t}));`);
      } else if (n.kind === 'if') {
        const t = emitPath(n.path, locals);
        emit(`if ($y(${t}) !== ${n.not}) {`);
        emitNodes(n.then, locals, depth);
        if (n.else !== null) {
          emit('} else {');
          emitNodes(n.else, locals, depth);
        }
        emit('}');
      } else if (n.kind === 'for') {
        const t = emitPath(n.path, locals);
        const k = temp();
        const xs = temp();
        emit(`{ const ${xs} = ${t}; if (Array.isArray(${xs})) { for (let ${k} = 0; ${k} < ${xs}.length; ${k}++) {`);
        // A loop variable that is not a safe const binding (a reserved word, or
        // 'eval'/'arguments' under strict mode) gets a $ alias instead.
        const alias = SAFE_IDENT.test(n.name) ? n.name : temp();
        if (n.name !== 'loop') emit(`const ${alias} = ${xs}[${k}];`);
        emit(`const loop = { index: ${k} + 1, first: ${k} === 0, last: ${k} === ${xs}.length - 1, length: ${xs}.length };`);
        locals.push({ name: n.name, alias });
        emitNodes(n.body, locals, depth);
        locals.pop();
        emit('} } }');
      } else if (n.kind === 'include') {
        if (depth < INCLUDE_DEPTH) {
          const sub = templates.get(n.name);
          if (sub !== undefined) emitNodes(sub, locals, depth + 1);
        }
      }
    }
  };

  emitNodes(nodes, [], 0);
  const src = `"use strict"; let $o = ''; const $e = $H.esc, $x = $H.textOf, $y = $H.truthy, $w = $H.own; ${lines.join('\n')} return $o;`;
  return new Function('$R', '$H', src);
}

// ------------------------------------------------------------------ pipeline

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const compiled = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compile only after every template is parsed: an include may name a template
  // that sorts after the one including it.
  for (const [name, nodes] of templates) compiled.set(name, compileTemplate(nodes, templates));
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources, in code-unit order of their paths; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter, in the reference's check order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      // Only the path resolution is cached: whether the link is broken is
      // reported per source, so that side effect stays per call.
      let path;
      if (rel === '') path = null;
      else {
        const key = `${dir}\n${rel}`;
        if (linkCache.has(key)) path = linkCache.get(key);
        else {
          path = resolvePath(dir, rel);
          linkCache.set(key, path);
        }
      }
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const names = s.data.tags ?? [];
    const out = [];
    for (const name of names) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts.
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, c);
    }
    return c;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageCache = new Map();
  const pageOf = (s) => {
    let p = pageCache.get(s);
    if (p === undefined) {
      p = {
        ...cardOf(s),
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
      pageCache.set(s, p);
    }
    return p;
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const output = {};
  const renderPage = (name, vars) => {
    const fn = compiled.get(name);
    return fn === undefined ? null : fn(vars, H);
  };
  for (const s of kept) {
    const fn = compiled.get(s.layout);
    output[`${s.outDir}/index.html`] = fn({ site, tags: allTags, recent, page: pageOf(s) }, H);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = renderPage('index', {
      site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = renderPage('tag', {
      site, tags: allTags, recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderPage('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
