import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_EXCLUDE_DIRS = new Set(['node_modules', 'bin', 'obj', '.venv', 'venv', '__pycache__', 'dist', '.next', '.nuxt',
  '.cache', 'target', '.gradle', '.pytest_cache', 'coverage', '.devfix', '__devfix_uploads']);

export function isExcludedPath(rel) {
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => PROJECT_EXCLUDE_DIRS.has(s))) return true;
  return /\.log$/i.test(segs.at(-1) ?? '');
}

// Walks root (must be a directory), calling onFile(rel, abs) for each file.
// Follows symlinks/junctions (via statSync) unless followLinks is false, in
// which case a symlink/junction entry is NOT descended into and is instead
// handed to the required onLink(rel, abs) callback.
//
// Cycle guard is scoped to the current recursion path (an "ancestors" set of
// realpath'd directories currently being visited, added on entry and removed
// on exit) rather than a global "already visited" set — two siblings that
// both resolve to the same real directory (e.g. a real dir plus a junction
// to it) are NOT a cycle and must both be walked in full. A genuine cycle
// (an entry whose realpath is already an ancestor) throws rather than being
// silently skipped.
export function walk(root, onFile, { exclude = () => false, followLinks = true, onLink, onDir } = {}) {
  if (!followLinks && typeof onLink !== 'function') {
    throw new Error('walk: onLink is required when followLinks is false');
  }
  const ancestors = new Set();

  const visit = (rel) => {
    const abs = path.join(root, rel);
    // rel === '' is the root itself: followLinks:false means "don't descend
    // into a link encountered while walking", not "refuse a linked root" —
    // a caller may legitimately hand walk() a root that is itself a
    // symlink/junction (e.g. already resolved via realpathSync) and expects
    // its contents walked normally.
    if (rel !== '' && !followLinks && fs.lstatSync(abs).isSymbolicLink()) {
      onLink(rel, abs);
      return;
    }
    const real = fs.realpathSync(abs); // throws ENOENT on a broken symlink — intentional
    const st = fs.statSync(abs); // follows symlinks/junctions to the real target
    if (st.isDirectory()) {
      if (ancestors.has(real)) throw new Error(`symlink cycle at ${rel}`);
      ancestors.add(real);
      if (onDir) onDir(rel, abs);
      try {
        for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
          const r = rel ? `${rel}/${d.name}` : d.name;
          if (exclude(r)) continue;
          visit(r);
        }
      } finally {
        ancestors.delete(real);
      }
    } else if (st.isFile()) {
      onFile(rel, abs);
    }
  };

  visit('');
}

export function dirSize(root, { exclude } = {}) {
  if (!fs.existsSync(root)) return 0;
  if (fs.statSync(root).isFile()) return fs.statSync(root).size;
  let n = 0;
  walk(root, (_r, abs) => { n += fs.statSync(abs).size; }, { exclude });
  return n;
}

export function copyTree(src, dst, { exclude } = {}) {
  if (fs.statSync(src).isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return;
  }
  // onDir fires for every directory visited (including an empty src root and
  // empty subdirectories), so the destination tree's shape matches the
  // source's even where there are no files to copy — without it, an empty
  // dir never triggers onFile and the destination directory is never created.
  walk(src, (r, abs) => {
    const to = path.join(dst, r);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(abs, to);
  }, { exclude, onDir: (r) => fs.mkdirSync(path.join(dst, r), { recursive: true }) });
}
