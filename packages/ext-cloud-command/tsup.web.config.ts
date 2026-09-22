import { defineConfig } from 'tsup';

/**
 * Runtime extensions load this graph directly from the authenticated Breeze
 * asset route. Bundle every dependency: the host intentionally supplies no
 * browser import map for extension packages.
 */
export default defineConfig({
  entry: { index: 'src/web/index.ts' },
  outDir: 'dist/web',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  splitting: false,
  minify: true,
  clean: true,
  noExternal: [/.*/],
});
