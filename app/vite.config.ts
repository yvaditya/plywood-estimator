import { defineConfig, type Plugin, type Connect } from 'vite';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

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

// Shared across dev + preview servers so at most one uvicorn is ever spawned;
// reset when the child exits so a later click can respawn a killed sidecar.
let sidecarSpawned = false;

/** True if something already answers on the sidecar port. Short timeout — a
 *  closed port must not stall the endpoint. */
async function sidecarHealthy(): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 800);
  try {
    const res = await fetch('http://localhost:8642/health', { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Spawn uvicorn detached from the dev server. ENOENT (no python on PATH)
 *  arrives as an async 'error' event, not a throw — it must be consumed here
 *  or it would crash the dev server unhandled. */
async function spawnSidecar(repoRoot: string): Promise<boolean> {
  // macOS installs commonly ship only `python3`; Windows ships `python`.
  for (const exe of ['python', 'python3']) {
    const child = spawn(exe, ['-m', 'uvicorn', 'server.main:app', '--port', '8642'], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: 'ignore',
      detached: true,
    });
    const ok = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (ok) {
      child.once('exit', () => { sidecarSpawned = false; });
      child.unref();
      return true;
    }
  }
  return false;
}

/**
 * POST /__sidecar/start — launch the PyNite sidecar (server/main.py, uvicorn
 * on :8642) on demand; the launcher scripts no longer start it at app launch.
 * Always answers 200 with {status:'already'|'started'|'unavailable'} — a
 * machine without python must read as "no sidecar", never as a dev-server
 * error, so the client can fall back to the WASM/PCG chain.
 */
function sidecarStarter(): Plugin {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const handleStart = async (res: ServerResponse): Promise<void> => {
    const reply = (status: 'already' | 'started' | 'unavailable') => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status }));
    };
    if (await sidecarHealthy()) return reply('already');
    if (sidecarSpawned) return reply('started');
    // Claim the flag before the (async) spawn so concurrent requests can't
    // both pass the guard.
    sidecarSpawned = true;
    try {
      if (await spawnSidecar(repoRoot)) return reply('started');
      sidecarSpawned = false;
      reply('unavailable');
    } catch {
      sidecarSpawned = false;
      reply('unavailable');
    }
  };
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || req.url !== '/__sidecar/start') return next();
    void handleStart(res);
  };
  return {
    name: 'sidecar-starter',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

export default defineConfig({
  plugins: [gitVersionLine(), sidecarStarter()],
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
