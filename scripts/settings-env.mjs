// Loads wowmin's settings files into process.env for the command-line tools,
// as the web service does at startup (src/load-env.ts), so a tool can take
// the client data folder (WOWMIN_CLIENT_DATA) from them. In order of
// precedence: variables already set in the environment, the system file
// (/etc/wowmin.env, or %ProgramData%\wowmin\wowmin.env on Windows), then
// .env in the project root. A file never overrides a value already set.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The settings files to load, the system one first.
export function settingsFiles(platform = process.platform, env = process.env, projectRoot = PROJECT_ROOT) {
  const system = platform === 'win32'
    ? env.ProgramData ? path.win32.join(env.ProgramData, 'wowmin', 'wowmin.env') : null
    : '/etc/wowmin.env';
  return [...(system ? [system] : []), path.join(projectRoot, '.env')];
}

// Loads each file that exists; one that cannot be read is skipped with a
// warning (or quietly, if it is only unreadable to this user).
export function loadSettingsEnv(files = settingsFiles(), load = (file) => process.loadEnvFile(file), warn = console.warn) {
  for (const file of files) {
    try {
      load(file);
    } catch (error) {
      const code = error?.code;
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') continue;
      warn(`Could not read ${file}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
