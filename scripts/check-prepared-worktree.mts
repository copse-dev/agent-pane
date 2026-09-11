/** This repository's opt-in readiness check; the application has no Copse-specific checks. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { GORTEX_VERSION } from './lib/native-artifacts.mts'
import { expectRecord, expectString, parseJsonUnknown } from '../src/shared/unknown-value.mts'
import { resolveDepRoot } from './resolve-dep.mts'

function version(root: string): string {
  return expectString(
    expectRecord(parseJsonUnknown(readFileSync(join(root, 'package.json'), 'utf8')), 'package')[
      'version'
    ],
    'version',
  )
}
function probe(command: string, args: string[], env = process.env): string {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
  return result.stdout.trim()
}
const electronRoot = resolveDepRoot('electron')
const electronVersion = version(electronRoot)
assert.equal(
  readFileSync(join(electronRoot, 'dist/version'), 'utf8').trim().replace(/^v/, ''),
  electronVersion,
)
const target = readFileSync(join(electronRoot, 'path.txt'), 'utf8').trim()
const electron = resolve(electronRoot, 'dist', target)
const rel = relative(join(electronRoot, 'dist'), electron)
assert.ok(
  !isAbsolute(target) && rel !== '..' && !rel.startsWith(`..${sep}`),
  'Invalid Electron executable path',
)
accessSync(electron, constants.X_OK)
const chromium = probe(electron, ['-p', 'process.versions.chrome'], {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
})
assert.equal(
  probe(electron, ['-e', 'require("node-pty");process.stdout.write("native module ready")'], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  }),
  'native module ready',
)
const driverRoot = resolveDepRoot('electron-chromedriver')
assert.equal(version(driverRoot), electronVersion)
const driver = probe(
  join(driverRoot, 'bin', process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver'),
  ['--version'],
)
assert.match(chromium, /^\d+\./)
assert.equal(
  driver.match(/^ChromeDriver (\d+)\./)?.[1],
  chromium.split('.')[0],
  'ChromeDriver must match Electron Chromium',
)
const gortex = probe(
  join(process.cwd(), 'vendor/gortex', process.platform === 'win32' ? 'gortex.exe' : 'gortex'),
  ['version'],
)
assert.ok(gortex.includes(GORTEX_VERSION.replace(/^v/, '')), 'Unexpected gortex version')
console.log(`Native runtimes ready: Electron ${electronVersion}, Chromium ${chromium}, ${gortex}`)
