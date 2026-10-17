import {
  PROFILE_VAULT_ARCHITECTURES,
  PROFILE_VAULT_BUILD_VERSION,
  profileVaultSourceHash,
} from './lib/profile-vault-source.mts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
const slicesDirectory = resolve(root, '.tmp/profile-vault/slices')
const deploymentTarget = '26.0'
mkdirSync(directory, { recursive: true })
rmSync(slicesDirectory, { recursive: true, force: true })
mkdirSync(slicesDirectory, { recursive: true })
for (const [source, filename, identifier] of [
  ['main.swift', 'CopseVault', 'dev.copse.vault'],
  ['probe.swift', 'CopseVaultProbe', 'dev.copse.vault-probe'],
]) {
  if (!source || !filename || !identifier) throw new Error('Invalid native build target')
  const output = resolve(directory, filename)
  const slices = PROFILE_VAULT_ARCHITECTURES.map((architecture) => {
    const slice = resolve(slicesDirectory, `${filename}-${architecture}`)
    execFileSync(
      '/usr/bin/xcrun',
      [
        'swiftc',
        '-O',
        '-target',
        `${architecture}-apple-macos${deploymentTarget}`,
        '-module-cache-path',
        resolve(root, `.tmp/profile-vault/module-cache-${architecture}`),
        '-o',
        slice,
        resolve(root, 'native/profile-vault', source),
        ...(source === 'main.swift' ? [resolve(root, 'native/profile-vault/policy.swift')] : []),
      ],
      { stdio: 'inherit' },
    )
    return slice
  })
  // One prepared tree feeds either architecture in local packaging and in the
  // release matrix. Sign the combined binary so neither package can inherit the
  // runner architecture by accident.
  execFileSync('/usr/bin/lipo', ['-create', ...slices, '-output', output], {
    stdio: 'inherit',
  })
  for (const architecture of PROFILE_VAULT_ARCHITECTURES) {
    execFileSync('/usr/bin/lipo', [output, '-verify_arch', architecture], {
      stdio: 'inherit',
    })
  }
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
    version: PROFILE_VAULT_BUILD_VERSION,
    architectures: PROFILE_VAULT_ARCHITECTURES,
    sourceHash: profileVaultSourceHash(root),
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
