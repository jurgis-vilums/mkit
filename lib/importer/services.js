import fs from 'node:fs';
import path from 'node:path';
import { rewritePath, rewriteText } from '../rewrite.js';
import { mustExec } from '../ctx.js';
import { stopAppProcesses } from '../local-services.js';

const owned = (item) => item.data.owner === 'new' || item.data.owner === 'both';
const agent = (reason) => ({ status: 'needs-agent', reason });
// For kinds with no deterministic install on this target, an item whose
// owner is explicitly 'old' is intentionally left on the old PC — that's not
// an agent task, it's the expected outcome, so it shouldn't show up as
// needs-agent noise on every import.
const staysOnOldPC = () => ({ status: 'ok', reason: 'stays on the old PC (owner=old); not installed here' });
const disabledDir = (tctx) => path.join(tctx.home, '.mkit', 'disabled');
const winStartup = (tctx) => path.join(tctx.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const name = (item) => item.id.split(':').pop();

export function unitFor(item, tctx, dir, nodePath) {
  const n = name(item);
  const log = path.join(dir, 'server.log');
  if (tctx.platform === 'win32') {
    return { path: path.join(winStartup(tctx), `mkit-${n}.vbs`),
      content: `CreateObject("WScript.Shell").Run "cmd /c cd /d ""${dir}"" && node ${item.data.script} >> server.log 2>&1", 0, False\r\n` };
  }
  if (tctx.platform === 'linux') {
    return { path: path.join(tctx.home, '.config', 'systemd', 'user', `mkit-${n}.service`),
      content: `[Unit]\nDescription=mkit ${n}\n\n[Service]\nWorkingDirectory=${dir}\nExecStart=${nodePath} ${item.data.script}\nRestart=on-failure\nStandardOutput=append:${log}\nStandardError=append:${log}\n\n[Install]\nWantedBy=default.target\n` };
  }
  return { path: path.join(tctx.home, 'Library', 'LaunchAgents', `eu.jurgis.mkit.${n}.plist`),
    content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>eu.jurgis.mkit.${n}</string>
<key>ProgramArguments</key><array><string>${nodePath}</string><string>${item.data.script}</string></array>
<key>WorkingDirectory</key><string>${dir}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
` };
}

function parkedPath(tctx, unitPath) { return path.join(disabledDir(tctx), path.basename(unitPath)); }

export function enableService(tctx, item, unitPath) {
  const n = name(item);
  if (tctx.platform === 'win32') {
    const parked = parkedPath(tctx, unitPath);
    if (fs.existsSync(parked)) fs.renameSync(parked, unitPath);
    mustExec(tctx, 'wscript', [unitPath]);
  } else if (tctx.platform === 'linux') {
    mustExec(tctx, 'systemctl', ['--user', 'daemon-reload']);
    mustExec(tctx, 'systemctl', ['--user', 'enable', '--now', `mkit-${n}.service`]);
  } else {
    const parked = parkedPath(tctx, unitPath);
    if (fs.existsSync(parked)) { fs.mkdirSync(path.dirname(unitPath), { recursive: true }); fs.renameSync(parked, unitPath); }
    const uid = mustExec(tctx, 'id', ['-u']).trim();
    // bootout fails (non-zero) when the agent isn't currently loaded, which is
    // the expected case on first install — its exit code is intentionally
    // ignored (not mustExec'd).
    tctx.exec('launchctl', ['bootout', `gui/${uid}`, unitPath]);
    mustExec(tctx, 'launchctl', ['bootstrap', `gui/${uid}`, unitPath]);
  }
  if (item.data.httpsPort) mustExec(tctx, 'tailscale', ['serve', '--bg', `--https=${item.data.httpsPort}`, `http://127.0.0.1:${item.data.port}`]);
}

export function disableService(tctx, item, unitPath, dir) {
  const n = name(item);
  if (item.data.httpsPort) mustExec(tctx, 'tailscale', ['serve', `--https=${item.data.httpsPort}`, 'off']);
  fs.mkdirSync(disabledDir(tctx), { recursive: true });
  if (tctx.platform === 'win32') {
    if (fs.existsSync(unitPath)) fs.renameSync(unitPath, parkedPath(tctx, unitPath));
    // Targeted stop: only the cmd.exe wrapper + node process whose command lines contain this app's dir and script.
    stopAppProcesses(tctx, dir, item.data.script);
  } else if (tctx.platform === 'linux') {
    mustExec(tctx, 'systemctl', ['--user', 'disable', '--now', `mkit-${n}.service`]);
  } else {
    const uid = mustExec(tctx, 'id', ['-u']).trim();
    if (fs.existsSync(unitPath)) {
      mustExec(tctx, 'launchctl', ['bootout', `gui/${uid}`, unitPath]);
      fs.renameSync(unitPath, parkedPath(tctx, unitPath));
    }
  }
}

function nodePath(tctx) {
  const r = mustExec(tctx, tctx.platform === 'win32' ? 'where' : 'which', ['node']);
  return r.split(/\r?\n/)[0].trim();
}

async function restoreNodeApp(tctx, item, source) {
  const dir = rewritePath(item.data.dir, source, { home: tctx.home, platform: tctx.platform });
  if (!fs.existsSync(path.join(dir, item.data.script))) return { status: 'failed', reason: `project for ${item.title} not migrated: ${dir}` };
  if (fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    mustExec(tctx, 'npm', ['install', '--omit=dev'], { cwd: dir }); // realExec routes npm/npx through cmd.exe on win32
  }
  const unit = unitFor(item, tctx, dir, nodePath(tctx));
  const writeTo = owned(item) ? unit.path : parkedPath(tctx, unit.path);
  fs.mkdirSync(path.dirname(writeTo), { recursive: true });
  fs.writeFileSync(writeTo, unit.content);
  if (owned(item)) enableService(tctx, item, unit.path);
  return { status: 'ok' };
}

// Sets <Enabled>true|false</Enabled> inside the XML's <Settings> block,
// replacing an existing one or inserting one if Settings has none.
function setSettingsEnabled(xml, enabled) {
  const value = enabled ? 'true' : 'false';
  return xml.replace(/<Settings>([\s\S]*?)<\/Settings>/, (_m, inner) => {
    const withEnabled = /<Enabled>[^<]*<\/Enabled>/.test(inner)
      ? inner.replace(/<Enabled>[^<]*<\/Enabled>/, `<Enabled>${value}</Enabled>`)
      : `${inner}<Enabled>${value}</Enabled>`;
    return `<Settings>${withEnabled}</Settings>`;
  });
}

function restoreTaskWin(tctx, item, payloadRoot, source) {
  const xmlSrc = path.join(payloadRoot, 'services', item.id.replace(/[:]/g, '_'), 'task.xml');
  const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
  let xml = rewriteText(fs.readFileSync(xmlSrc, 'utf8'), source, { home: tctx.home, platform: 'win32' })
    .replace(/<UserId>[^<]*<\/UserId>/g, `<UserId>${user}</UserId>`).replace(/<Author>[^<]*<\/Author>/g, '');
  if (!owned(item)) xml = setSettingsEnabled(xml, false);
  const file = path.join(tctx.home, '.mkit', 'tasks', `${item.data.name}.xml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, xml);
  const n = item.data.name.replace(/'/g, "''");
  mustExec(tctx, 'pwsh', ['-NoProfile', '-Command', `Register-ScheduledTask -TaskName '${n}' -Xml (Get-Content -Raw '${file}') -Force | Out-Null`]);
  return { status: 'ok' };
}

export async function restoreService(tctx, item, payloadRoot, source) {
  if (item.kind === 'node-app') return restoreNodeApp(tctx, item, source);
  if (item.kind === 'scheduled-task') {
    if (tctx.platform === 'win32') return restoreTaskWin(tctx, item, payloadRoot, source);
    if (item.data.owner === 'old') return staysOnOldPC();
    return agent(`translate scheduled task "${item.data.name}" (${item.data.execute} ${item.data.arguments ?? ''}) to ${tctx.platform === 'linux' ? 'a systemd --user timer' : 'a launchd agent'}; owner=${item.data.owner}`);
  }
  if (item.kind === 'startup') {
    if (tctx.platform !== 'win32') {
      if (item.data.owner === 'old') return staysOnOldPC();
      return agent(`Windows autostart "${item.data.file}" has no direct equivalent; decide with Jurgis; owner=${item.data.owner}`);
    }
    const src = path.join(payloadRoot, 'services', item.id.replace(/[:]/g, '_'), item.data.file);
    const dst = owned(item) ? path.join(winStartup(tctx), item.data.file) : path.join(disabledDir(tctx), item.data.file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, rewriteText(fs.readFileSync(src, 'latin1'), source, { home: tctx.home, platform: 'win32' }), 'latin1');
    return { status: 'ok' };
  }
  if (item.kind === 'serve') {
    if (item.data.owner === 'old') return staysOnOldPC();
    return agent(`Tailscale serve :${item.data.httpsPort} → ${item.data.port} has no matching app; set up manually if needed; owner=${item.data.owner}`);
  }
  if (item.kind === 'cloudflared') {
    if (item.data.owner === 'old') return staysOnOldPC();
    return agent(`cloudflared tunnel is a singleton; owner=${item.data.owner}. Only if owner is new/both: install cloudflared service with the copied ~/.cloudflared config`);
  }
  return { status: 'failed', reason: `unknown service kind ${item.kind}` };
}
