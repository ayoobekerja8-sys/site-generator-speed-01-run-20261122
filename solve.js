// site-generator-speed-01 entry: a dependency-free reimplementation of makefun-site 1.0.0's build().
// run(input) returns the same output tree (path -> text) the reference build() returns, byte for byte.
//
// Differences from the reference are speed only: the HTML escape runs once per string (never per character), the word
// count is a manual scan (no match array), slugs are cached by their text, and templates are compiled to JS functions
// rather than walked as node trees.

const SLUG_MAX = 64;

const ESC_TABLE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const ESC_RE = /[&<>"']/g;

function escChar(c) {
  return ESC_TABLE[c];
}

/** `text` with & < > " and ' escaped, and nothing else (one pass; a clean string is returned as it stands). */
export function escapeHtml(text) {
  return text.replace(ESC_RE, escChar);
}

/** The slug cache: the same titles and tag names recur across a site, so each slug is computed once. */
const slugCache = new Map();

const MARKS = /\p{M}/gu;

/** The slug of `text`: NFKD, marks dropped, A-Z lowered, non [a-z0-9] runs one "-", cut to 64, "untitled" if empty. */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize("NFKD").replace(MARKS, "");
  let out = "";
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += "-";
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  while (out.length > 0 && out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  if (out === "") out = "untitled";
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const a = date.indexOf("-");
  const b = date.indexOf("-", a + 1);
  return `${Number(date.slice(b + 1))} ${MONTHS[Number(date.slice(a + 1, b)) - 1]} ${date.slice(0, a)}`;
}

/** Whether `c` is whitespace exactly as `\s` reads it (the word count's only rule). */
function isSpace(c) {
  if (c <= 32) return c === 32 || (c >= 9 && c <= 13);
  if (c < 0xa0) return false;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of `lines` joined by "\n": their runs of characters other than whitespace, without a match array. */
export function wordsOfLines(lines) {
  let n = 0;
  for (let k = 0; k < lines.length; k++) {
    const text = lines[k];
    let inWord = false;
    for (let i = 0; i < text.length; i++) {
      if (isSpace(text.charCodeAt(i))) inWord = false;
      else if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
export function resolvePath(dir, rel) {
  const parts = dir === "" ? [] : dir.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** The directory of `path`, "" at the root. */
export function dirOf(path) {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** Code-unit order (never the locale's). */
export function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- front matter

const KEYS = ["title", "date", "tags", "draft", "layout", "slug", "summary"];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;
const TRAIL_RE = /[ \t]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: "a quoted string is not closed" };
    let out = "";
    let at = 1;
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === "\\") {
        const n = raw[i + 1];
        if ((n !== '"' && n !== "\\") || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(at, i) + n;
        i++;
        at = i + 1;
      } else if (c === '"') return { error: "a quoted string holds a stray quote" };
    }
    return { value: out + raw.slice(at, raw.length - 1) };
  }
  if (raw.charCodeAt(0) === 91) return { error: "a bare string opens on [" };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case "title":
    case "summary": {
      const s = stringOf(raw);
      return "error" in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case "date": {
      const m = DATE_RE.exec(raw);
      if (m === null) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case "tags": {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === "") return { value: [] };
      const tags = inner.split(",");
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === "" || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case "draft":
      return raw === "true" ? { value: true } : raw === "false" ? { value: false } : { error: 'key "draft": true or false' };
    case "layout":
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case "slug":
      return SLUG_RE.test(raw) && raw.length <= SLUG_MAX ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body lines: { data, bodyLines }, or { error } with the first reason it is refused. */
export function parseFrontMatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") return { error: "no front matter" };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: "the front matter is not closed" };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (BLANK_RE.test(line) || line.charCodeAt(0) === 35) continue;
    const m = LINE.exec(line);
    if (m === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = m[2] === undefined ? "" : m[2].replace(TRAIL_RE, "");
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === "") return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ("error" in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, "title")) return { error: "no title" };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- the build, part 1

const RESERVED = ["posts", "tags", "page"];

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = b.input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.length >= 3 && f.path.slice(-3) === ".md") {
      const text = f.content;
      b.sources.push({ path: f.path, text: text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n") });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter, the generator's own directories, a post's date, its layout, and drafts. */
function frontMatter(b) {
  const kept = [];
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith("posts/");
    let own;
    for (let i = 1; i < RESERVED.length; i++) {
      if (s.path.startsWith(`${RESERVED[i]}/`)) {
        own = RESERVED[i];
        break;
      }
    }
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, "date")) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout === undefined ? (s.post ? "post" : "page") : s.data.layout;
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const dir = s.post ? "posts" : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === "" ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug === undefined ? slugify(s.data.title) : s.data.slug, set);
    s.slug = slug;
    s.outDir = dir === "" ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes, as a lookup by code unit. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of "\\`*_[]()#+-.!>") ESCAPABLE[ch.charCodeAt(0)] = 1;

/** A line of spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language ("" when it has none), or -1 when the line does not open a fence. */
function fenceLangOf(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return -1;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  const lang = line.slice(3, i);
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return -1;
  }
  return lang;
}

/** Whether the line is three backticks and then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether the line is `---` or `***` and then spaces or tabs only. */
function isHr(line) {
  const a = line.charCodeAt(0);
  if (a !== 45 && a !== 42) return false;
  if (line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let depth = 0;
  while (depth < 6 && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let t = depth;
  while (t < line.length) {
    const d = line.charCodeAt(t);
    if (d !== 32 && d !== 9) break;
    t++;
  }
  let end = line.length;
  while (end > t) {
    const d = line.charCodeAt(end - 1);
    if (d !== 32 && d !== 9) break;
    end--;
  }
  return end === t ? null : { depth, text: line.slice(t, end) };
}

/** A line of two or more spaces and then a non-whitespace character. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let k = 2;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  return k < line.length && !isSpace(line.charCodeAt(k));
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLangOf(line) !== -1 || headingOf(line) !== null || isHr(line);
}

/** The first index from `from` where `s` holds `**` outside a backslash escape, or -1. */
function findDoubleStar(s, from) {
  const len = s.length;
  for (let j = from; j + 1 < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The first `]` from `from` outside a backslash escape, or -1. */
function findClose(s, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < len && ESCAPABLE[s.charCodeAt(j + 1)]) {
      j++;
      continue;
    }
    if (c === 93) return j;
  }
  return -1;
}

/** Whether `s` holds a whitespace character. */
function hasSpace(s) {
  for (let i = 0; i < s.length; i++) if (isSpace(s.charCodeAt(i))) return true;
  return false;
}

const INLINE_TEST = /[\\`*[]/;

/** `s` rendered inline; `env.link(target)` is a link's href. */
export function inline(s, env) {
  if (!INLINE_TEST.test(s)) return escapeHtml(s);
  let out = "";
  let runStart = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c !== 92 && c !== 96 && c !== 42 && c !== 91) {
      i++;
      continue;
    }
    if (c === 92) {
      if (i + 1 < n && ESCAPABLE[s.charCodeAt(i + 1)]) {
        out += escapeHtml(s.slice(runStart, i)) + escapeHtml(s[i + 1]);
        i += 2;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf("`", i + 1);
      if (j > i + 1) {
        out += `${escapeHtml(s.slice(runStart, i))}<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          out += `${escapeHtml(s.slice(runStart, i))}<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          runStart = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `${escapeHtml(s.slice(runStart, i))}<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
          runStart = i;
        } else i++;
      }
      continue;
    }
    const k = findClose(s, i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(")", k + 2) : -1;
    if (m !== -1) {
      const target = s.slice(k + 2, m);
      if (target !== "" && !hasSpace(target)) {
        out += `${escapeHtml(s.slice(runStart, i))}<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        runStart = i;
        continue;
      }
    }
    i++;
  }
  if (runStart < n) out += escapeHtml(s.slice(runStart));
  return out;
}

/** A body's lines rendered: its HTML (a "\n" after each block), its toc (levels 2 and 3) and its first paragraph. */
export function renderMarkdown(lines, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLangOf(line);
    if (lang !== -1) {
      const from = i + 1;
      let j = from;
      while (j < n && !isFenceClose(lines[j])) j++;
      const body = j === from ? "" : `${escapeHtml(lines.slice(from, j).join("\n"))}\n`;
      i = j + 1;
      blocks.push(lang === "" ? `<pre><code>${body}</code></pre>` : `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push("<hr>");
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const quoted = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== "") quoted.push(t);
        i++;
      }
      blocks.push(quoted.length === 0 ? "<blockquote>\n</blockquote>" : `<blockquote>\n<p>${inline(quoted.join("\n"), env)}</p>\n</blockquote>`);
      continue;
    }
    const c0 = line.charCodeAt(0);
    let ordered = false;
    let start = 1;
    let first = null;
    if (c0 === 45 || c0 === 42) {
      if (line.charCodeAt(1) === 32) first = line.slice(2);
    } else if (c0 >= 48 && c0 <= 57) {
      let d = 0;
      while (d < line.length) {
        const c = line.charCodeAt(d);
        if (c < 48 || c > 57) break;
        d++;
      }
      if (d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        start = Number(line.slice(0, d));
        first = line.slice(d + 2);
      }
    }
    if (first !== null) {
      const items = [];
      let item = trimLine(first);
      i++;
      while (i < n) {
        const l = lines[i];
        const c = l.charCodeAt(0);
        let text = null;
        if (ordered) {
          let d = 0;
          while (d < l.length) {
            const x = l.charCodeAt(d);
            if (x < 48 || x > 57) break;
            d++;
          }
          if (d <= 9 && d > 0 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) text = l.slice(d + 2);
        } else if ((c === 45 || c === 42) && l.charCodeAt(1) === 32) text = l.slice(2);
        if (text !== null) {
          items.push(item);
          item = trimLine(text);
          i++;
        } else if (isContinued(l)) {
          item += `\n${trimLine(l)}`;
          i++;
        } else break;
      }
      items.push(item);
      const tag = ordered ? "ol" : "ul";
      let html = ordered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`;
      for (let k = 0; k < items.length; k++) html += `<li>${inline(items[k], env)}</li>\n`;
      blocks.push(`${html}</${tag}>`);
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      text += `\n${trimLine(lines[i])}`;
      i++;
    }
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? "" : `${blocks.join("\n")}\n`, toc, excerpt: excerpt === null ? "" : excerpt };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const STANDALONE_RE = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split(".");
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  const n = src.length;
  let text = "";
  let i = 0;
  while (i < n) {
    const open = src.indexOf("{", i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== "{" && next !== "%") {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === "{") {
      const raw = src[open + 2] === "{";
      const close = src.indexOf(raw ? "}}}" : "}}", open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? "{{{" : "{{"} is not closed`);
      if (text !== "") tokens.push({ t: "text", text });
      text = "";
      tokens.push({ t: raw ? "raw" : "var", path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf("%}", open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf("\n", open - 1) + 1;
    const nl = src.indexOf("\n", end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = STANDALONE_RE.test(src.slice(lineStart, open)) && STANDALONE_RE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== "") tokens.push({ t: "text", text });
    text = "";
    tokens.push({ t: "tag", tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== "") tokens.push({ t: "text", text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: "root", body: [] };
  const stack = [root];
  let body = root.body;
  const tokens = tokenize(name, src);
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.t === "text") {
      body.push({ kind: "text", text: tok.text });
      continue;
    }
    if (tok.t === "var" || tok.t === "raw") {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: "for", name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: "if", not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === "else") {
      if (top.kind !== "if" || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
    } else if (tag === "endfor" || tag === "endif") {
      if (top.kind !== (tag === "endfor" ? "for" : "if")) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === "root" ? parent.body : parent.kind === "for" ? parent.body : parent.else ?? parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: "include", name: m[1] });
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    let out = "";
    for (let i = 0; i < v.length; i++) {
      if (i !== 0) out += ", ";
      out += textOf(v[i]);
    }
    return out;
  }
  return "";
}

/** The helpers a compiled template calls. */
const H = { escape: escapeHtml, text: textOf };

/** A lookup's code: `target` gets the value at `path` in the scope chain (undefined when any step is missing). */
function genLookup(path, scopeVar, out, target) {
  const key0 = JSON.stringify(path[0]);
  out.push(`${target} = undefined;`);
  out.push(`s = ${scopeVar};`);
  out.push(`while (s !== null && !Object.hasOwn(s.vars, ${key0})) s = s.parent;`);
  if (path.length === 1) {
    out.push(`if (s !== null) ${target} = s.vars[${key0}];`);
    return;
  }
  out.push(`if (s !== null) { v = s.vars[${key0}];`);
  for (let k = 1; k < path.length; k++) {
    const key = JSON.stringify(path[k]);
    if (k === path.length - 1) out.push(`if (v !== null && typeof v === "object" && Object.hasOwn(v, ${key})) ${target} = v[${key}];`);
    else out.push(`if (v !== null && typeof v === "object" && Object.hasOwn(v, ${key})) { v = v[${key}];`);
  }
  for (let k = 1; k < path.length - 1; k++) out.push("}");
  out.push("}");
}

/** `nodes`' code, appending to the `o` array in the generated function's `scopeVar` scope. */
function genNodes(nodes, scopeVar, out, counters) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.kind) {
      case "text":
        out.push(`o.push(${JSON.stringify(nd.text)});`);
        break;
      case "var":
        genLookup(nd.path, scopeVar, out, "v");
        out.push(`if (typeof v === "string") o.push(esc(v));`);
        out.push(`else if (v !== undefined) o.push(esc(txt(v)));`);
        break;
      case "raw":
        genLookup(nd.path, scopeVar, out, "v");
        out.push(`if (typeof v === "string") o.push(v);`);
        out.push(`else if (v !== undefined) o.push(txt(v));`);
        break;
      case "include": {
        const t = `t${counters.include++}`;
        out.push(`var ${t} = ctx.templates.get(${JSON.stringify(nd.name)});`);
        out.push(`if (${t} !== undefined && depth < ${INCLUDE_DEPTH}) o.push(${t}(ctx, ${scopeVar}, depth + 1, h));`);
        break;
      }
      case "if": {
        genLookup(nd.path, scopeVar, out, "v");
        const cond = `(Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== false && v !== "" && v !== 0))`;
        const thenNodes = nd.then;
        const elseNodes = nd.else;
        if (!nd.not) {
          out.push(`if ${cond} {`);
          genNodes(thenNodes, scopeVar, out, counters);
          if (elseNodes === null) out.push("}");
          else {
            out.push("} else {");
            genNodes(elseNodes, scopeVar, out, counters);
            out.push("}");
          }
        } else if (elseNodes === null) {
          out.push(`if (!${cond}) {`);
          genNodes(thenNodes, scopeVar, out, counters);
          out.push("}");
        } else {
          out.push(`if (!${cond}) {`);
          genNodes(elseNodes, scopeVar, out, counters);
          out.push("} else {");
          genNodes(thenNodes, scopeVar, out, counters);
          out.push("}");
        }
        break;
      }
      case "for": {
        const id = counters.for++;
        genLookup(nd.path, scopeVar, out, "v");
        out.push(`if (Array.isArray(v)) {`);
        out.push(`var x${id} = v;`);
        out.push(`var n${id} = x${id}.length;`);
        out.push(`for (var k${id} = 0; k${id} < n${id}; k${id}++) {`);
        out.push(
          `var c${id} = { vars: { ${JSON.stringify(nd.name)}: x${id}[k${id}], loop: { index: k${id} + 1, first: k${id} === 0, last: k${id} === n${id} - 1, length: n${id} } }, parent: ${scopeVar} };`,
        );
        genNodes(nd.body, `c${id}`, out, counters);
        out.push("}");
        out.push("}");
        break;
      }
    }
  }
}

/** Compiled templates, by source (a template's source alone decides its code; only errors name the template). */
const compiledCache = new Map();

/** `src` compiled to a function (ctx, scope, depth, h) -> string; a TemplateError when it does not parse. */
function compileTemplate(name, src) {
  const hit = compiledCache.get(src);
  if (hit !== undefined) return hit;
  const nodes = parseTemplate(name, src);
  const out = [];
  genNodes(nodes, "scope", out, { for: 0, include: 0 });
  const fn = new Function(
    "ctx",
    "scope",
    "depth",
    "h",
    `var o = [];\nvar s, v;\nvar esc = h.escape, txt = h.text;\n${out.join("\n")}\nreturn o.join("");`,
  );
  compiledCache.set(src, fn);
  return fn;
}

// ---------------------------------------------------------------- the build, part 2

const REPORT_FILE = "build-report.txt";

/** Whether `target` opens on a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) continue;
    return c === 58;
  }
  return false;
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set();
  for (let i = 0; i < b.statics.length; i++) staticPaths.add(b.statics[i].path);
  for (let k = 0; k < b.sources.length; k++) {
    const s = b.sources[k];
    const dir = dirOf(s.path);
    const env = {
      link(target) {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf("#");
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? "" : target.slice(hash);
        const path = rel === "" ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = b.bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        }
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOfLines(s.bodyLines);
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = [];
  for (let i = 0; i < b.sources.length; i++) if (b.sources[i].post) posts.push(b.sources[i]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
}

/** A source's tags, each slug once, in its own order. */
function ownTags(s) {
  const names = s.data.tags;
  if (names === undefined) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const slug = slugify(names[i]);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(names[i]);
  }
  return out;
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  for (let i = 0; i < b.posts.length; i++) {
    const p = b.posts[i];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let k = 0; k < names.length; k++) {
      const slug = slugify(names[k]);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name: names[k], slug, url: `${b.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    if (s.post) continue;
    const names = ownTags(s);
    const refs = [];
    for (let k = 0; k < names.length; k++) {
      const slug = slugify(names[k]);
      const tag = bySlug.get(slug);
      refs.push(tag === undefined ? { name: names[k], slug, url: "", posts: [] } : tag);
    }
    s.tagRefs = refs;
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
function linkOf(s) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? "" : s.data.date,
    date_long: s.data.date === undefined ? "" : longDate(s.data.date),
  };
}

/** A page's card, as lists show it. */
function cardOf(s) {
  const refs = s.tagRefs;
  const tags = new Array(refs.length);
  for (let i = 0; i < refs.length; i++) tags[i] = { name: refs[i].name, slug: refs[i].slug, url: refs[i].url };
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? "" : s.data.date,
    date_long: s.data.date === undefined ? "" : longDate(s.data.date),
    summary: s.data.summary === undefined ? "" : s.data.summary,
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags,
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  const card = cardOf(s);
  card.slug = s.slug;
  card.content = s.html;
  card.toc = s.toc;
  card.newer = linkOf(s.newer === undefined ? null : s.newer);
  card.older = linkOf(s.older === undefined ? null : s.older);
  card.is_post = s.post;
  return card;
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  const cards = new Map();
  for (let i = 0; i < b.posts.length; i++) cards.set(b.posts[i], cardOf(b.posts[i]));
  b.cards = cards;
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = new Array(b.tags.length);
  for (let i = 0; i < b.tags.length; i++) {
    const t = b.tags[i];
    allTags[i] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  const recentCount = b.input.site.recent;
  const recent = [];
  for (let i = 0; i < b.posts.length && i < recentCount; i++) recent.push(cards.get(b.posts[i]));
  const ctx = { templates: b.templates };
  const render = (name, vars) => {
    const fn = b.templates.get(name);
    if (fn === undefined) return null;
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    return fn(ctx, scope, 0, H);
  };
  for (let i = 0; i < b.sources.length; i++) {
    const s = b.sources[i];
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const slice = [];
    for (let i = (k - 1) * per; i < k * per && i < b.posts.length; i++) slice.push(cards.get(b.posts[i]));
    const html = render("index", {
      posts: slice,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? "" : indexUrl(k - 1), older_url: k === pages ? "" : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? "index.html" : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < b.tags.length; i++) {
    const t = b.tags[i];
    const tagCards = new Array(t.posts.length);
    for (let k = 0; k < t.posts.length; k++) tagCards[k] = cards.get(t.posts[k]);
    const html = render("tag", { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tagCards } });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render("tags", {});
  if (tagsHtml !== null) b.output["tags/index.html"] = tagsHtml;
  for (let i = 0; i < b.statics.length; i++) {
    const f = b.statics[i];
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = b.report.concat([...b.broken]).sort(byCodeUnits);
  let pages = 0;
  for (let i = 0; i < b.sources.length; i++) if (!b.sources[i].post) pages++;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join("\n")}\n`;
}

/** One site's output tree: path -> text, exactly makefun-site 1.0.0's build() output. */
export function run(input) {
  const templates = new Map();
  const reportLines = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ""),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: null,
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}
