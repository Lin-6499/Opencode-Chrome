import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: [fileURLToPath(new URL('ui/entry.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('extension/ui-runtime.js', import.meta.url)),
  bundle: true, format: 'esm', platform: 'browser', target: ['chrome116'],
  minify: true, legalComments: 'eof',
});
console.log('Built local Markdown, sanitizer, syntax highlighter and stream-state modules.');
