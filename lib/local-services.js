import fs from 'node:fs';
import path from 'node:path';
import { mustExec } from './ctx.js';
import { startupDir } from './collectors/services.js';

const q = (s) => s.replace(/'/g, "''");

export function stopAppProcesses(ctx, dir, script) {
  const d = q(dir);
  const ps = [`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${q(script)}*' -and $_.CommandLine -like '*${d}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
    `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${d}*' -and $_.CommandLine -like '*${q(script)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`].join('; ');
  mustExec(ctx, 'pwsh', ['-NoProfile', '-Command', ps]);
}

// Returns null when fully applied, or a note describing what Jurgis must still do by hand on this PC.
export function localToggle(ctx, item, enabled) {
  if (item.kind === 'scheduled-task') {
    mustExec(ctx, 'pwsh', ['-NoProfile', '-Command', `${enabled ? 'Enable' : 'Disable'}-ScheduledTask -TaskName '${q(item.data.name)}' | Out-Null`]);
    return null;
  }
  if (item.kind === 'node-app' || item.kind === 'startup') {
    const live = path.join(startupDir(ctx), item.data.file);
    const parked = path.join(ctx.home, '.mkit', 'disabled', item.data.file);
    if (enabled) {
      if (!fs.existsSync(parked)) throw new Error(`no parked startup file ${parked}`);
      fs.renameSync(parked, live);
      mustExec(ctx, 'wscript', [live]);
    } else {
      if (!fs.existsSync(live)) throw new Error(`no startup file ${live}`);
      fs.mkdirSync(path.dirname(parked), { recursive: true });
      fs.renameSync(live, parked);
      if (item.kind === 'node-app') stopAppProcesses(ctx, item.data.dir, item.data.script);
    }
    // Tailscale exposure on this PC only changes via scripts\add-tailscale-app.ps1 (workspace rule), never from here.
    return item.kind === 'node-app' && item.data.httpsPort
      ? `Tailscale :${item.data.httpsPort} on this PC was left as-is — change it with scripts\\add-tailscale-app.ps1 if needed`
      : null;
  }
  if (item.kind === 'cloudflared') return `cloudflared is not toggled automatically — ${enabled ? 'start' : 'stop and disable'} the cloudflared service on this PC by hand`;
  if (item.kind === 'serve') return `Tailscale :${item.data.httpsPort} is not toggled automatically — use scripts\\add-tailscale-app.ps1 on this PC`;
  throw new Error(`unknown service kind ${item.kind}`);
}
