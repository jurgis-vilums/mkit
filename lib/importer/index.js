import { restoreTool, restoreSecret, restoreClaude, restoreShell } from './basic.js';
import { restoreProject } from './projects.js';
import { restoreService } from './services.js';

export const RESTORERS = { tools: restoreTool, secrets: restoreSecret, claude: restoreClaude, shell: restoreShell, projects: restoreProject, services: restoreService };
