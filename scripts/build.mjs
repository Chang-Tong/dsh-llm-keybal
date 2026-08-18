#!/usr/bin/env node
/**
 * Build the dsh client bundle: esbuild bundles src/client → lib/client.js.
 *
 * The artifact follows the dsh client bundle protocol:
 *   window.__ModuleLoader__.load({ id, factory: (require) => {...} })
 * External deps (react, @deepseek-ai/*) are injected through the factory's
 * require parameter by the dsh web module table — never bundled in.
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_ID = 'dsh-llm-keybal'
const OUT_DIR = join(ROOT, '.build')
const LIB_DIR = join(ROOT, 'lib')

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(LIB_DIR, { recursive: true })

await build({
  entryPoints: [join(ROOT, 'src/client/index.ts')],
  bundle: true,
  format: 'iife',
  globalName: '__dshKeybalClientFactory',
  platform: 'browser',
  target: ['es2020'],
  // Platform modules (provided by dsh's __ModuleLoader__ module table).
  external: ['react', 'react/jsx-runtime'],
  jsx: 'automatic',
  outfile: join(OUT_DIR, 'factory.js'),
  sourcemap: true,
  logLevel: 'info',
})

const inner = readFileSync(join(OUT_DIR, 'factory.js'), 'utf8')
writeFileSync(join(LIB_DIR, 'client.js'), `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_ID)},
  factory: (require) => {
${inner}
    return __dshKeybalClientFactory;
  },
});
//# sourceMappingURL=client.js.map
`)
writeFileSync(join(LIB_DIR, 'client.js.map'), readFileSync(join(OUT_DIR, 'factory.js.map'), 'utf8'))
console.log(`built ${join(LIB_DIR, 'client.js')}`)
