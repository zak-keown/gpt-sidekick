import { build as viteBuild } from 'vite';
import { build } from 'esbuild';

await viteBuild();
await build({
  entryPoints: ['src/background.ts'],
  outfile: 'dist/background.js',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  sourcemap: true,
});
await build({
  entryPoints: ['src/content.ts'],
  outfile: 'dist/content.js',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  sourcemap: true,
});
