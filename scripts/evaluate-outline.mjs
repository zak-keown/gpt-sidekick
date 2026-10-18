import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['evaluation/run.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
