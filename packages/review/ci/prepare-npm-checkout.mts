// Mounted read-only into each validation cell. The shared dependency cache is
// immutable; npm gets a private writable copy in this disposable checkout.
import { spawnSync } from 'node:child_process'
import { appendFile, cp, mkdtemp } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const source = process.env['npm_config_store_dir']
if (!source) throw new Error('The Copse npm preparation policy requires a dependency cache')
const cache = await mkdtemp(join(process.cwd(), '.copse-review-npm-cache-'))
await cp(join(resolve(source), '_cacache'), join(cache, '_cacache'), { recursive: true })
// Retain the cache for later model-requested npm commands in the same checkout.
await appendFile('.npmrc', `\ncache=${relative(process.cwd(), cache)}\n`)
const result = spawnSync(
  'npm',
  ['ci', '--offline', '--ignore-scripts', '--cache', cache, '--no-audit', '--no-fund'],
  {
    stdio: 'inherit',
  },
)
if (result.error) throw result.error
if (result.status !== 0)
  throw new Error(`Offline npm preparation failed (${String(result.status)})`)
