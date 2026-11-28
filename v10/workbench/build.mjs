import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildWorkbench() {
  const defaultPackage = new URL('../../docs/v10/phase-1/p1-0/spike/package.json', import.meta.url);
  const require = createRequire(process.env.V10_SPIKE_PACKAGE ?? defaultPackage);
  const { build } = require('esbuild');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./app.ts', import.meta.url))],
    bundle: true, write: false, format: 'iife', target: 'es2022' });
  const template = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  if (!template.includes('<!-- WORKBENCH_SCRIPT -->')) throw new Error('Missing workbench script marker');
  return template.replace('<!-- WORKBENCH_SCRIPT -->', () => '<script>' + script + '</script>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('Provide the output HTML path');
  await writeFile(output, await buildWorkbench(), 'utf8');
  console.log(resolve(output));
}
