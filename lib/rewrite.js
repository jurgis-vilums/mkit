import fs from 'node:fs';
import path from 'node:path';
import { walk } from './fsutil.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const TEXT_EXT = new Set(['.md', '.json', '.jsonl', '.js', '.cjs', '.mjs', '.ts', '.ps1', '.psm1', '.sh', '.py',
  '.toml', '.yaml', '.yml', '.txt', '.vbs', '.ahk', '.xml', '.html', '.css', '.env', '.cmd', '.bat']);

// Characters (besides the path separator itself) that end a path segment:
// quotes, backtick, angle brackets, pipe, wildcard chars, comma, semicolon,
// close-paren, whitespace.
const STOP = String.raw`\s"'\x60<>|*?,;)`;

// Form-specific tails: each form's separator must not itself be swallowed as
// segment content, so a form only continues past its own separator style.
// - json: the source home text has every backslash doubled (JSON-escaped), so
//   a real separator is an *escaped* backslash (two literal backslash chars).
//   A segment may not contain a lone backslash — that would be eating the
//   backslash of an unrelated `\"`, `\n`, `\t` escape immediately following
//   the path, corrupting the JSON.
// - native: a real Windows path separator is a single literal backslash.
// - forward/posix: a real separator is a single literal forward slash. A
//   segment may not contain a lone backslash either — a forward-slash path
//   that is itself a JSON string value is commonly immediately followed by
//   a JSON-escaped closing quote (`\"`, e.g. a quoted path inside a logged
//   shell command: `..."C:/Users/vilum/x.py\" <<'EOF'...`); without this
//   exclusion the escaping backslash gets swallowed into the tail and is
//   then rewritten from `\` to `/` by the posix-target backslash-to-slash
//   conversion, turning `\"` into `/"` and corrupting the JSON.
// Each tail also allows one optional trailing bare separator (e.g. a path
// ending in "\" or "/" with nothing — or only a stop char — after it), so a
// trailing separator is converted along with the rest instead of being left
// behind as a dangling literal backslash/doubled-backslash.
const TAIL_SRC = {
  json: String.raw`(?:\\\\[^\\` + STOP + String.raw`]+)*(?:\\\\)?`,
  native: String.raw`(?:\\[^\\` + STOP + String.raw`]+)*\\?`,
  forward: String.raw`(?:/[^/\\` + STOP + String.raw`]+)*/?`,
  posix: String.raw`(?:/[^/\\` + STOP + String.raw`]+)*/?`,
};

// A Windows path embedded in a file:// URI (file:///C:/Users/...) carries an
// extra leading slash before the drive letter that isn't part of esc(f.text)
// (the forward-slash home text starts at "C:"). When converting to a posix
// target — whose home already starts with "/" — re-adding that leading
// slash would double it up (file:////home/...). Consumed together with the
// literal "file:///" prefix and only re-added for a win32 target, where
// to.home has no leading slash of its own and the original prefix is
// already correct as-is.
const FILE_URI_PREFIX = String.raw`(?:file:///)?`;

// The \\?\ extended-length path prefix has no posix equivalent; for a posix
// target it's stripped entirely rather than carried over literally.
const UNC_EXT_PREFIX = String.raw`(?:\\\\\?\\)?`;

function forms(home, platform) {
  if (platform !== 'win32') return [{ kind: 'posix', text: home }];
  const fwd = home.replace(/\\/g, '/');
  return [
    { kind: 'json', text: home.replace(/\\/g, '\\\\') },
    { kind: 'native', text: home },
    { kind: 'forward', text: fwd },
  ];
}

function target(kind, tail, to) {
  if (to.platform !== 'win32') {
    const t = tail.replace(/\\\\/g, '/').replace(/\\/g, '/');
    return to.home + t;
  }
  if (kind === 'json') return to.home.replace(/\\/g, '\\\\') + tail;
  if (kind === 'forward') return to.home.replace(/\\/g, '/') + tail;
  return to.home + tail;
}

const SPECIAL_PREFIX = { forward: FILE_URI_PREFIX, native: UNC_EXT_PREFIX };

export function rewriteText(text, from, to) {
  let out = text;
  for (const f of forms(from.home, from.platform)) {
    const prefixSrc = SPECIAL_PREFIX[f.kind] ?? '';
    const re = new RegExp(`(${prefixSrc})${esc(f.text)}(?![A-Za-z0-9_.-])(${TAIL_SRC[f.kind]})`, from.platform === 'win32' ? 'gi' : 'g');
    out = out.replace(re, (_m, prefix, tail) => {
      if (prefix && f.kind === 'forward') { // file:// URI
        return to.platform !== 'win32' ? 'file://' + target(f.kind, tail, to) : prefix + target(f.kind, tail, to);
      }
      if (prefix && f.kind === 'native') { // \\?\ extended-length prefix
        return to.platform !== 'win32' ? target(f.kind, tail, to) : prefix + target(f.kind, tail, to);
      }
      return target(f.kind, tail, to);
    });
  }
  return out;
}

export function rewritePath(p, from, to) { return rewriteText(p, from, to); }

export const encodeProjectDir = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

export function rewriteProjectDirName(name, from, to) {
  const a = encodeProjectDir(from.home);
  const lowerMatch = from.platform === 'win32' ? name.toLowerCase().startsWith(a.toLowerCase()) : name.startsWith(a);
  const boundary = name.length === a.length || name[a.length] === '-';
  return lowerMatch && boundary ? encodeProjectDir(to.home) + name.slice(a.length) : name;
}

// Rewrite every text file under dir in place; returns { changed, links }.
// Reuses fsutil's walk with followLinks:false — a symlink/junction is NOT
// followed (it may point outside the tree, or form a cycle) and is instead
// reported in `links` so the caller can flag it for manual attention rather
// than silently writing through it.
export function rewriteTree(dir, from, to) {
  let changed = 0;
  const links = [];
  if (!fs.existsSync(dir)) return { changed, links };
  if (fs.statSync(dir).isFile()) {
    changed += rewriteFileInPlace(dir, from, to) ? 1 : 0;
    return { changed, links };
  }
  walk(dir, (_rel, abs) => {
    if (rewriteFileInPlace(abs, from, to)) changed += 1;
  }, { followLinks: false, onLink: (rel) => links.push(rel) });
  return { changed, links };
}

function rewriteFileInPlace(p, from, to) {
  if (!TEXT_EXT.has(path.extname(p).toLowerCase()) && path.basename(p) !== '.env') return false;
  const before = fs.readFileSync(p, 'utf8');
  const after = rewriteText(before, from, to);
  if (after === before) return false;
  fs.writeFileSync(p, after);
  return true;
}
