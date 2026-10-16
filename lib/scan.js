import * as claude from './collectors/claude.js';
import * as secrets from './collectors/secrets.js';
import * as tools from './collectors/tools.js';
import * as projects from './collectors/projects.js';
import * as services from './collectors/services.js';
import * as shell from './collectors/shell.js';

export const COLLECTOR_MODULES = { tools, secrets, claude, projects, shell, services };

export function scan(ctx) {
  const items = Object.values(COLLECTOR_MODULES).flatMap((m) => m.collect(ctx));
  return { version: 1, scannedAt: new Date().toISOString(),
    source: { platform: ctx.platform, home: ctx.home, devRoot: ctx.devRoot, hostname: ctx.hostname }, items };
}
