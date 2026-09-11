import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.platform !== 'darwin') throw new Error('The native profile vault requires macOS.')
const identityIndex = process.argv.indexOf('--identity')
const identity = identityIndex >= 0 ? process.argv[identityIndex + 1] : undefined
if (!identity || identity.startsWith('--'))
  throw new Error(
    'Pass --identity with the Developer ID Application signing identity. The Electron app does not need to be re-signed.',
  )
const root = resolve(import.meta.dirname, '..')
const directory = resolve(root, 'native/profile-vault/dist')
mkdirSync(directory, { recursive: true })
for (const [source, filename, identifier] of [
  ['main.swift', 'CopseVault', 'dev.copse.vault'],
  ['probe.swift', 'CopseVaultProbe', 'dev.copse.vault-probe'],
]) {
  if (!source || !filename || !identifier) throw new Error('Invalid native build target')
  const output = resolve(directory, filename)
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-module-cache-path',
      resolve(root, '.tmp/profile-vault/module-cache'),
      '-o',
      output,
      resolve(root, 'native/profile-vault', source),
    ],
    { stdio: 'inherit' },
  )
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      identity,
      '--identifier',
      identifier,
      '--options',
      'runtime',
      '--timestamp',
      output,
    ],
    { stdio: 'inherit' },
  )
  execFileSync(
    '/usr/bin/codesign',
    [
      '--verify',
      '--strict',
      '-R',
      `=identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "VRQQV62MK3"`,
      output,
    ],
    { stdio: 'inherit' },
  )
}
writeFileSync(
  resolve(directory, 'build.json'),
  JSON.stringify({
    version: 1,
    sourceHash: createHash('sha256')
      .update(readFileSync(resolve(root, 'native/profile-vault/main.swift')))
      .digest('hex'),
  }) + '\n',
)
if (process.argv.includes('--authenticate')) {
  execFileSync(resolve(directory, 'CopseVaultProbe'), ['--persistent'], {
    stdio: 'inherit',
    timeout: 120_000,
  })
} else {
  execFileSync(resolve(directory, 'CopseVaultProbe'), ['--probe'], { stdio: 'inherit' })
}
