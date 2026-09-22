import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'src/web/index.ts' }, outDir: 'dist/web', format: ['esm'],
  platform: 'browser', target: 'es2022', bundle: true, splitting: false,
  clean: true, minify: true, sourcemap: false,
});
