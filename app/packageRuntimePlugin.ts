import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Bundle once into a string: saved HTML never needs imports or a running server. */
export function packageRuntimePlugin(): Plugin {
  const id = 'virtual:package-runtime';
  const resolved = '\0' + id;
  const root = fileURLToPath(new URL('.', import.meta.url));
  return {
    name: 'standalone-job-package',
    resolveId(source) { if (source === id) return resolved; },
    async load(source) {
      if (source !== resolved) return;
      const result = await build({ absWorkingDir: root, entryPoints: ['src/packageRuntime.ts'], bundle: true,
        write: false, format: 'iife', platform: 'browser', target: 'es2020', minify: true,
        legalComments: 'inline', metafile: true });
      for (const path of Object.keys(result.metafile!.inputs)) this.addWatchFile(resolve(root, path));
      return `export default ${JSON.stringify(result.outputFiles[0].text)};`;
    },
  };
}
