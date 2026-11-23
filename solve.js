// A faster drop-in for makefun-site 1.0.0: the same answers, built with
// index-based scans instead of one character or one regex at a time.
//
// The semantics are makefun-site's own, kept exactly:
//   - sources sorted by path in code-unit order; `\r\n` and lone `\r` made `\n`;
//   - front matter: `---` ... `---`, blank lines and `#` comments skipped,
//     `key: value` lines with one space after the colon, seven known keys, the
//     first failure refused with its reason; then, in order, a source under
//     `tags/` or `page/`, a post with no date, a layout no template has, a
//     draft are refused or dropped;
//   - a page's slug is its `slug` key or the slug of its title, made unique in
//     its directory in source order (`s`, `s-2`, `s-3`, ...); at the root
//     `posts`, `tags` and `page` are taken from the start;
//   - Markdown: its own subset (fences, ATX headings with unique ids,
//     thematic breaks, blockquotes, flat lists, paragraphs; inline code spans,
//     strong, emphasis, links, backslash escapes; raw HTML is text); links
//     resolve to built pages or static files, else are reported broken;
//   - collections: posts newest date first, equal dates by slug; tags grouped
//     by slug, ordered by count then slug; the index paginates `per_page`
//     posts a page (at least one page, even with no posts);
//   - templates: `{{ }}` escaped, `{{{ }}}` raw, `{% for %}`, `{% if %}` with
//     optional `{% else %}` and `not`, `{% include %}` at most 8 deep, a tag
//     alone on its line takes the whole line with it;
//   - the report: every refusal, draft, broken link and unparsable template,
//     sorted in code-unit order, then the `built ...` counts line.
//
// The speed comes from never looking at a character twice where it matters:
// slugify takes an ASCII fast path and caches every result (titles, tag names
// and headings repeat across a site); the Markdown lexer reads each line with
// char-code tests instead of eight regexes, and renders inline text in whole
// runs between the few characters that mean something (`\`, backtick, `*`,
// `[`), escaping each run in one replace; templates render into one shared
// array that is joined once, with no intermediate strings for nested blocks.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/**
 * `text` with & < > " and ' escaped. Most strings hold none of the five, so
 * the test first returns them untouched, with no replace and no callback.
 */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** A slug's cache: titles, tag names and headings repeat across a site. */
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const slug = slugifySlow(text);
  slugCache.set(text, slug);
  return slug;
}

function slugifySlow(text) {
  // ASCII text is unchanged by NFKD and holds no combining marks, so the
  // normalisation and the mark pass can be skipped for it outright.
  const plain = /^[\x00-\x7F]*$/.test(text) ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
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
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    const end = raw.length - 1;
    for (let i = 1; i < end; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === end) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
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
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Lines are walked
 * with indexOf, so the body is one slice, never split and re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  const data = {};
  let start = 4; // the line after the opening ---
  let li = 1; // 0-based line index of the line starting at `start`
  for (;;) {
    const nl = text.indexOf('\n', start);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(start, lineEnd);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: nl === -1 ? '' : text.slice(nl + 1) };
    }
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      // A "key: value" line: [a-z_]+, ':', then ' ' and the value, or nothing.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${li + 1} is not "key: value"` };
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${li + 1} is not "key: value"` };
      // Trailing spaces and tabs dropped.
      let e = raw.length;
      while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
      if (e !== raw.length) raw = raw.slice(0, e);
      const key = line.slice(0, k);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    start = nl + 1;
    li++;
  }
}

// ---------------------------------------------------------------- Markdown

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

/** Whether `line` closes a fence: three backticks, spaces or tabs after them. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  let i = 3;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length || (line.charCodeAt(d) !== 32 && line.charCodeAt(d) !== 9)) return null;
  let s = d;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: d, text: line.slice(s, e) };
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start and text, or null when `line` does not open one. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !isSpaceCode(line.charCodeAt(i));
}

/** A line's block kind, by its first character alone where that decides it. */
const K_BLANK = 0;
const K_FENCE = 1;
const K_HEADING = 2;
const K_HR = 3;
const K_QUOTE = 4;
const K_BULLET = 5;
const K_ORDERED = 6;
const K_OTHER = 7;

function lineKind(line) {
  if (line === '') return K_BLANK;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let i = 1; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) return K_OTHER;
    }
    return K_BLANK;
  }
  if (c0 === 96) {
    if (line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return K_OTHER;
    let i = 3;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
      else break;
    }
    while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
    return i === line.length ? K_FENCE : K_OTHER;
  }
  if (c0 === 35) {
    let d = 1;
    while (d < line.length && line.charCodeAt(d) === 35) d++;
    if (d > 6) return K_OTHER;
    if (d >= line.length || (line.charCodeAt(d) !== 32 && line.charCodeAt(d) !== 9)) return K_OTHER;
    let s = d;
    while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
    let e = line.length;
    while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
    return e === s ? K_OTHER : K_HEADING;
  }
  if (c0 === 45 || c0 === 42) {
    if (line.charCodeAt(1) === c0 && line.charCodeAt(2) === c0) {
      let i = 3;
      while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
      if (i === line.length) return K_HR;
    }
    return line.charCodeAt(1) === 32 ? K_BULLET : K_OTHER;
  }
  if (c0 === 62) return K_QUOTE;
  if (c0 >= 48 && c0 <= 57) {
    let i = 1;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c >= 48 && c <= 57) i++;
      else break;
    }
    if (i > 9) return K_OTHER;
    return line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32 ? K_ORDERED : K_OTHER;
  }
  return K_OTHER;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(line) {
  const k = lineKind(line);
  return k === K_BLANK || k === K_FENCE || k === K_HEADING || k === K_HR;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index from `from` where `s` holds `what` outside a backslash
 * escape, or -1. A `what` is escaped exactly when an odd run of backslashes
 * stands before it, so indexOf plus a parity count is the same scan.
 */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf(what, j);
    if (k === -1) return -1;
    let b = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) b++;
    if (b % 2 === 0) return k;
    j = k + 1;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let b = 0;
    for (let p = k - 1; p >= from && s.charCodeAt(p) === 92; p--) b++;
    if (b % 2 === 1) {
      j = k + 1;
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      j = k + 2;
      continue;
    }
    return k;
  }
}

/**
 * The next inline character that means something at or after `i`: a `\`,
 * backtick, `*` or `[`, or one of the five HTML escapes. One character class
 * finds the nearest of all nine, so a run between two matches holds neither
 * a special nor an escapable and is copied as it stands: the whole inline
 * render is a single pass, with no separate escape scan over the text.
 */
const INLINE_NEXT = /[\\`*\[]|[&<>"']/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_NEXT.lastIndex = i;
    const m = INLINE_NEXT.exec(s);
    if (m === null) {
      // Nothing special anywhere in the rest: if that is the whole string
      // it needs no escaping and no building, so it is the answer itself.
      if (i === 0) return s;
      out += s.slice(i);
      break;
    }
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      out += ESCAPES[c];
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        out += escapeHtml(s[j + 1]);
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      i = mm + 1;
    } else {
      out += '[';
      i = j + 1;
    }
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Lexed and rendered in one pass, with no token objects.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const n = lines.length;
  let i = 0;
  // Each block is pushed with its trailing "\n" beside it, so the HTML is
  // one join at the end, with no extra strings made for it.
  const push = (block) => {
    parts.push(block, '\n');
  };
  while (i < n) {
    const line = lines[i];
    const kind = lineKind(line);
    if (kind === K_BLANK) {
      i++;
      continue;
    }
    if (kind === K_FENCE) {
      const lang = fenceOpen(line);
      i++;
      let code = '';
      while (i < n && !fenceClose(lines[i])) {
        code += escapeHtml(lines[i]);
        code += '\n';
        i++;
      }
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    if (kind === K_HEADING) {
      const heading = headingOf(line);
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (kind === K_HR) {
      push('<hr>');
      i++;
      continue;
    }
    if (kind === K_QUOTE) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    if (kind === K_BULLET || kind === K_ORDERED) {
      const bullet = kind === K_BULLET ? bulletOf(line) : null;
      const ordered = kind === K_ORDERED ? orderedOf(line) : null;
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.start : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const o = orderedOf(l);
          if (o !== null) {
            items.push([trimLine(o.text)]);
            i++;
            continue;
          }
        } else {
          const b = bulletOf(l);
          if (b !== null) {
            items.push([trimLine(b)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    push(`<p>${html}</p>`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

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
const K_TEXT = 0, K_VAR = 1, K_RAW = 2, K_IF = 3, K_FOR = 4, K_INCLUDE = 5, K_ROOT = 6;

function parseTemplate(name, src) {
  const root = { kind: K_ROOT, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: K_TEXT, text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t === 'var' ? K_VAR : K_RAW, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: K_FOR, name: m[1], path: pathOf(name, m[2]), body: [], inUse: false, vars: {}, loop: { index: 0, first: false, last: false, length: 0 }, scope: null };
        node.scope = { vars: node.vars, parent: null };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: K_IF, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== K_IF || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? K_FOR : K_IF)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === K_ROOT ? parent.body : parent.kind === K_FOR ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: K_INCLUDE, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind === K_FOR ? 'for' : 'if'} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`.
 * `ctx` holds the parsed templates and the HTML escape.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let i = 0, end = nodes.length; i < end; i++) {
    const n = nodes[i];
    switch (n.kind) {
      case K_TEXT:
        out.push(n.text);
        break;
      case K_VAR:
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case K_RAW:
        out.push(textOf(lookup(scope, n.path)));
        break;
      case K_IF: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case K_FOR: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // Each iteration binds the element and `loop` in a scope of its own.
        // The node keeps one scope for that, its vars and its `loop` object,
        // and reuses them from iteration to iteration: a render reads them
        // only while it runs, so nothing keeps a stale one. A template that
        // includes itself would re-enter this node while it runs, so then the
        // scope is fresh per iteration instead, as it was before.
        if (n.inUse) {
          for (let k = 0; k < len; k++) {
            const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
            renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
          }
          break;
        }
        n.inUse = true;
        const vars = n.vars;
        const loop = n.loop;
        const w = n.scope;
        w.parent = scope;
        for (let k = 0; k < len; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          loop.length = len;
          renderNodes(n.body, w, ctx, depth, out);
        }
        n.inUse = false;
        break;
      }
      case K_INCLUDE: {
        includeRender(n.name, scope, ctx, out, depth);
        break;
      }
    }
  }
}

/**
 * An include: the template `name` rendered in the same scope, at most
 * INCLUDE_DEPTH deep; a missing one, or one nested more than 8 deep,
 * renders nothing. A template the analysis found constant (it reads only
 * `site`, `tags` and `recent`, the same in every render of the build) is
 * rendered once and its text reused from then on.
 */
function includeRender(name, scope, ctx, out, depth) {
  if (depth >= INCLUDE_DEPTH) return;
  const nodes = ctx.templates.get(name);
  if (nodes === undefined) return;
  if (ctx.constant.has(name)) {
    let s = ctx.constCache.get(name);
    if (s === undefined) {
      const tmp = [];
      renderNodes(nodes, scope, ctx, depth + 1, tmp);
      s = tmp.join('');
      ctx.constCache.set(name, s);
    }
    out.push(s);
    return;
  }
  renderNodes(nodes, scope, ctx, depth + 1, out);
}

/** The root names whose values never change within a build. */
const CONST_ROOTS = new Set(['site', 'tags', 'recent']);
/** The root names that change from render to render. */
const VARY_ROOTS = new Set(['page', 'posts', 'pager', 'tag']);
/** A loop variable of one of these names would shadow a root name, so no
 * template may be taken as constant while one is bound anywhere. */
const SHADOW_ROOTS = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag', 'loop']);

/** What a path's first name reads as, in `env` (loop var to its source): a root name, or 'external' where it comes from a caller. */
function resolveSource(first, env) {
  if (Object.hasOwn(env, first)) return env[first];
  if (CONST_ROOTS.has(first) || VARY_ROOTS.has(first)) return first;
  return 'external';
}

/** The sources a template reads, its includes followed in the caller's scope; an include cycle reads as 'external'. */
function templateReads(name, env, visiting) {
  const nodes = ctxTemplates.get(name);
  if (nodes === undefined) return new Set();
  if (visiting.has(name)) return new Set(['external']);
  visiting.add(name);
  const out = new Set();
  walkReads(nodes, env, out, visiting);
  visiting.delete(name);
  return out;
}

// The templates of the build being analysed (set per run, before the walk).
let ctxTemplates = null;

function walkReads(nodes, env, out, visiting) {
  for (const n of nodes) {
    if (n.kind === K_VAR || n.kind === K_RAW || n.kind === K_IF) {
      out.add(resolveSource(n.path[0], env));
    } else if (n.kind === K_FOR) {
      const src = resolveSource(n.path[0], env);
      out.add(src);
      walkReads(n.body, { ...env, [n.name]: src, loop: src }, out, visiting);
    } else if (n.kind === K_INCLUDE) {
      for (const s of templateReads(n.name, env, visiting)) out.add(s);
    }
  }
}

/** The names of the templates that read only `site`, `tags` and `recent`. */
function constantTemplates(templates) {
  ctxTemplates = templates;
  const loopNames = new Set();
  const collect = (nodes) => {
    for (const n of nodes) {
      if (n.kind === K_FOR) {
        loopNames.add(n.name);
        collect(n.body);
      } else if (n.kind === K_IF) {
        collect(n.then);
        if (n.else !== null) collect(n.else);
      }
    }
  };
  for (const nodes of templates.values()) collect(nodes);
  for (const name of loopNames) if (SHADOW_ROOTS.has(name)) return new Set();
  const constant = new Set();
  for (const name of templates.keys()) {
    const reads = templateReads(name, {}, new Set());
    let ok = true;
    for (const s of reads) if (!CONST_ROOTS.has(s)) { ok = false; break; }
    if (ok) constant.add(name);
  }
  return constant;
}


// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Whether a code unit is whitespace, as /\s/ reads it. */
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** The ASCII whitespace code units, for wordsOf's fast path. */
const ASCII_WS = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) ASCII_WS[c] = 1;

/**
 * The words of a body: its runs of characters other than whitespace. Counted
 * by walking the code units, with no match array to allocate; ASCII code
 * units read their whitespace from a table, and only the rare higher ones
 * take the full test.
 */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128 ? ASCII_WS[c] === 1 : isSpaceCode(c);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  // Each template is parsed once, in code-unit order of its name; one that
  // does not parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static. Line ends are made "\n" only where a \r stands.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // 2. Each source's front matter, in order: refused, a source under the
  // generator's own directories, a post with no date, a layout no template
  // has, a draft.
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
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
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
  sources.length = 0;
  sources.push(...kept);

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files
  // they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  // Relative paths resolve the same from one directory, however often a link
  // names them, so each (directory, relative path) is resolved once.
  const resolvedPaths = new Map();
  const resolveCached = (dir, rel) => {
    const key = `${dir}\0${rel}`;
    let path = resolvedPaths.get(key);
    if (path === undefined) {
      path = resolvePath(dir, rel);
      resolvedPaths.set(key, path);
    }
    return path;
  };
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveCached(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older
  // neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
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
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs. Every template also sees `site`, `tags` and `recent`.
  // The four root scopes are built once: each render only sets the one
  // value that changes (its page, its posts and pager, or its tag), since a
  // render reads them synchronously and keeps none of them.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates, escape: escapeHtml, constant: constantTemplates(templates), constCache: new Map() };
  const pageScope = { vars: { site, tags: allTags, recent, page: null }, parent: null };
  const indexScope = { vars: { site, tags: allTags, recent, posts: null, pager: null }, parent: null };
  const tagScope = { vars: { site, tags: allTags, recent, tag: null }, parent: null };
  const tagsScope = { vars: { site, tags: allTags, recent }, parent: null };
  // One output array for the whole build, emptied per render: a render reads
  // it only while it runs, and renders never overlap.
  const out = [];
  const render = (name, scope) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    out.length = 0;
    renderNodes(nodes, scope, ctx, 0, out);
    return out.join('');
  };
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  for (const s of sources) {
    pageScope.vars.page = pageOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout, pageScope);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    indexScope.vars.posts = posts.slice((k - 1) * per, k * per).map((p) => cards.get(p));
    indexScope.vars.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
    const html = render('index', indexScope);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    tagScope.vars.tag = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) };
    const html = render('tag', tagScope);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', tagsScope);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
