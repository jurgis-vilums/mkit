import fs from 'node:fs';
import path from 'node:path';
import { makeItem } from '../manifest.js';
import { walk } from '../fsutil.js';

const W = (id) => ['winget', 'install', '--id', id, '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'];
const B = (...a) => ['brew', 'install', ...a];
const A = (pkg) => ['apt-get', 'install', '-y', pkg];
const SH = (url, shell = 'bash') => [shell, '-c', `curl -fsSL ${url} | ${shell}`];

// GitHub's official apt-repo install (https://github.com/cli/cli/blob/trunk/docs/install_linux.md).
// Run as a single `sh -c` script (no embedded `sudo`) — restoreTool wraps the
// whole thing in `sudo` itself when the importer isn't already root, same as
// it does for every other apt-get-based CATALOG entry.
const GH_LINUX_SCRIPT = [
  'mkdir -p -m 755 /etc/apt/keyrings',
  'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg',
  'chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
  'mkdir -p -m 755 /etc/apt/sources.list.d',
  'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
  'apt-get update',
  'apt-get install -y gh',
].join(' && ');

export const CATALOG = {
  git: { win32: W('Git.Git'), darwin: B('git'), linux: A('git') },
  node: { win32: W('OpenJS.NodeJS.LTS'), darwin: B('node'), linux: A('nodejs') },
  claude: { win32: ['powershell', '-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'], darwin: SH('https://claude.ai/install.sh'), linux: SH('https://claude.ai/install.sh') },
  gh: { win32: W('GitHub.cli'), darwin: B('gh'), linux: ['sh', '-c', GH_LINUX_SCRIPT] },
  glab: { win32: W('GLab.GLab'), darwin: B('glab'), linux: null },
  tailscale: { win32: W('Tailscale.Tailscale'), darwin: B('--cask', 'tailscale'), linux: SH('https://tailscale.com/install.sh', 'sh') },
  cloudflared: { win32: W('Cloudflare.cloudflared'), darwin: B('cloudflared'), linux: null },
  python: { win32: W('Python.Python.3.12'), darwin: B('python'), linux: A('python3') },
  docker: { win32: W('Docker.DockerDesktop'), darwin: B('--cask', 'docker'), linux: A('docker.io') },
  pwsh: { win32: W('Microsoft.PowerShell'), darwin: B('--cask', 'powershell'), linux: null },
  psmux: { win32: null, darwin: B('tmux'), linux: A('tmux') },
  uv: { win32: W('astral-sh.uv'), darwin: B('uv'), linux: SH('https://astral.sh/uv/install.sh', 'sh') },
};
const ALWAYS = ['git', 'node', 'claude'];

export function installCommand(name, platform) { return CATALOG[name]?.[platform] ?? null; }

export function binaryName(name, platform) {
  if (name === 'python') return platform === 'win32' ? 'python' : 'python3';
  if (name === 'psmux') return platform === 'win32' ? 'psmux' : 'tmux';
  return name;
}

function corpus(ctx) {
  const c = path.join(ctx.home, '.claude');
  const parts = [];
  for (const d of ['skills', 'hooks', 'agents', 'commands']) {
    const p = path.join(c, d);
    if (fs.existsSync(p)) walk(p, (_r, abs) => { if (/\.(md|json|sh|ps1|js|cjs|mjs|py)$/i.test(abs)) parts.push(fs.readFileSync(abs, 'utf8')); });
  }
  for (const f of ['settings.json', 'settings.local.json', 'mcp.json', 'CLAUDE.md']) {
    const p = path.join(c, f);
    if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf8'));
  }
  const cj = path.join(ctx.home, '.claude.json');
  if (fs.existsSync(cj)) parts.push(fs.readFileSync(cj, 'utf8'));
  return parts.join('\n');
}

export function collect(ctx) {
  const text = corpus(ctx);
  const names = Object.keys(CATALOG).filter((n) => ALWAYS.includes(n) || new RegExp(`(^|[\\s\`'"(/])${n}(\\.exe)?([\\s\`'")]|$)`, 'm').test(text));
  return names.map((name) => makeItem({ id: `tool:${name}`, collector: 'tools', kind: 'tool', title: name, data: { name } }));
}

export function stage() { /* tools carry no payload */ }
