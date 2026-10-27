import { join } from 'node:path';
import { homedir } from 'node:os';

/** User-private runtime state is separate from downloaded projects and host working directories. */
export function defaultDataDirectory(): string {
  return process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'AI Workflow Studio') : join(homedir(), '.local', 'share', 'ai-workflow-studio');
}
