import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/**
 * Run a git command and return its trimmed stdout, or a fallback if git
 * isn't available (e.g. in an untracked source drop).
 */
function git(cmd: string, fallback = ''): string {
  try {
    return execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

const GIT_SHA    = git('rev-parse --short HEAD', 'dev');
const GIT_AUTHOR = git('log -1 --format=%an',    'local');
const GIT_DATE   = git('log -1 --format=%cs',    '');

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    fs: {
      // occt-import-js ships .wasm next to its js entry; allow serving it
      allow: ['..']
    }
  },
  optimizeDeps: {
    exclude: ['occt-import-js']
  },
  worker: {
    format: 'es'
  },
  define: {
    __GIT_SHA__:    JSON.stringify(GIT_SHA),
    __GIT_AUTHOR__: JSON.stringify(GIT_AUTHOR),
    __GIT_DATE__:   JSON.stringify(GIT_DATE),
  },
});
