// Bundles the CLI and the shared board code into one file, so `punch` starts fast (FR-20). The OS
// keychain binding is native, so it stays a real dependency.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: [new URL('./main.ts', import.meta.url).pathname],
  outfile: new URL('./dist/punch.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@napi-rs/keyring'],
  banner: { js: '#!/usr/bin/env node' },
  define: { __PUNCH_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
});
console.log(`Built punch ${pkg.version} → cli/dist/punch.mjs`);
