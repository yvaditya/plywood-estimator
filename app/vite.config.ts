import { defineConfig, type Plugin } from 'vite';
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Inject "sha · author · date" of the repo's CURRENT HEAD into the
 * #versionLine placeholder in index.html. transformIndexHtml runs on every
 * page load in dev — pulling a new commit shows up on the next reload, no
 * server restart needed — and once at build time for production bundles.
 */
function gitVersionLine(): Plugin {
  return {
    name: 'git-version-line',
    transformIndexHtml(html) {
      const parts = [
        git('rev-parse --short HEAD', 'dev'),
        git('log -1 --format=%an', 'local'),
        git('log -1 --format=%cs', ''),
      ].filter(Boolean);
      return html.replace(
        /(<p class="version" id="versionLine">)[^<]*(<\/p>)/,
        `$1${escapeHtml(parts.join(' · '))}$2`,
      );
    },
  };
}

export default defineConfig({
  plugins: [gitVersionLine()],
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
});
