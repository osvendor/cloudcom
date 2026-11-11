// Astro/esbuild transpilation does not diagnose missing identifiers. Check the
// generated browser viewer graph after adapting the native upstream sources.
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = resolve(root, 'apps/web');
const require = createRequire(resolve(web, 'package.json'));
const ts = require('typescript');
const configFile = resolve(web, 'tsconfig.json');
const config = ts.readConfigFile(configFile, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, web);
if (parsed.errors.length) throw new Error('Could not parse browser TypeScript configuration');
const browserRoot = resolve(web, 'src/components/cloudcom/browserDesktop');
const viewerFile = resolve(browserRoot, 'upstream/components/DesktopViewer.tsx');
const program = ts.createProgram({
  rootNames: [viewerFile, resolve(web, 'env.d.ts')],
  options: { ...parsed.options, noEmit: true, skipLibCheck: true },
});
if (!program.getSourceFile(viewerFile)) throw new Error('Generated browser viewer source is missing');
// Check diagnostics in the browser viewer's imported graph, not the full app.
// Runtime clipboard/transport tests remain necessary.
const diagnostics = ts.getPreEmitDiagnostics(program).filter(d =>
  d.file && resolve(d.file.fileName).startsWith(browserRoot + sep),
);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else {
  console.log('Browser viewer bindings and initialization order verified.');
}
