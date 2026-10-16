import fs from 'node:fs';
import path from 'node:path';

const CHOICES = ['migrate', 'archive', 'skip'];
const OWNERS = ['old', 'new', 'both'];

export function loadSelections(file) {
  if (!fs.existsSync(file)) return { projects: {}, services: {}, excluded: [] };
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { projects: s.projects ?? {}, services: s.services ?? {}, excluded: s.excluded ?? [] };
}

export function saveSelections(file, sel) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sel, null, 2));
}

// Normalizes a filesystem path to forward slashes, no trailing slash, and
// (on a win32 source, where paths are case-insensitive) lowercase — so a
// node-app's absolute `data.dir` can be compared against a project's
// posix-joined `data.rel` regardless of separator/case differences.
function normPath(p, caseInsensitive) {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? n.toLowerCase() : n;
}

// Returns the items that go into the bundle, with data.choice (projects) / data.owner (services) resolved.
export function resolve(inventory, sel) {
  const caseInsensitive = inventory.source.platform === 'win32';
  const devRoot = normPath(inventory.source.devRoot, caseInsensitive);

  // Project choices, resolved up front (same rule as the main loop below) so
  // node-app items can be checked against them regardless of item order.
  const projectChoices = []; // [{ rel (normalized, relative to devRoot), choice }]
  for (const it of inventory.items) {
    if (it.collector !== 'projects') continue;
    const choice = sel.excluded.includes(it.id) ? 'skip' : (sel.projects[it.data.rel] ?? it.data.defaultChoice);
    if (!CHOICES.includes(choice)) throw new Error(`invalid choice ${choice} for ${it.data.rel}`);
    projectChoices.push({ rel: normPath(it.data.rel, caseInsensitive), choice });
  }

  // True when `dir` sits inside (or is) a project folder whose resolved
  // choice is `skip` — including a project dropped via sel.excluded.
  function inSkippedProject(dir) {
    const d = normPath(dir, caseInsensitive);
    if (d !== devRoot && !d.startsWith(`${devRoot}/`)) return false;
    const rel = d === devRoot ? '' : d.slice(devRoot.length + 1);
    return projectChoices.some(({ rel: projRel, choice }) =>
      choice === 'skip' && (rel === projRel || rel.startsWith(`${projRel}/`)));
  }

  const out = [];
  for (const it of inventory.items) {
    if (sel.excluded.includes(it.id)) continue;
    if (it.collector === 'projects') {
      const choice = sel.projects[it.data.rel] ?? it.data.defaultChoice;
      if (!CHOICES.includes(choice)) throw new Error(`invalid choice ${choice} for ${it.data.rel}`);
      if (choice === 'skip') continue;
      out.push({ ...it, data: { ...it.data, choice } });
    } else if (it.collector === 'services') {
      if (it.kind === 'node-app' && inSkippedProject(it.data.dir)) continue;
      const owner = sel.services[it.id] ?? it.data.defaultOwner;
      if (!OWNERS.includes(owner)) throw new Error(`invalid owner ${owner} for ${it.id}`);
      out.push({ ...it, data: { ...it.data, owner } });
    } else out.push(it);
  }
  return out;
}
