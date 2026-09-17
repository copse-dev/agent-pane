import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { it } from 'node:test'
import {
  authenticateManifest,
  createVaultManifest,
  newVaultIdentity,
} from './profile-vault-crypto.ts'
import { nativeRequest } from './profile-vault-native.ts'

it(
  'native export policy always authenticates and native recovery verifies JS manifests before state changes',
  { skip: process.platform !== 'darwin' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'copse-native-policy-'))
    const key = randomBytes(32)
    try {
      const legacy = createVaultManifest(key, newVaultIdentity(), randomUUID(), 'c3ludGhldGlj')
      const fixtures = [
        legacy,
        authenticateManifest(key, { ...legacy, requireAuth: false }),
        authenticateManifest(key, { ...legacy, requireAuth: true }),
      ].map((manifest) => ({
        key: key.toString('base64'),
        request: nativeRequest('recover', '/synthetic-profile', manifest),
      }))
      writeFileSync(join(directory, 'fixtures.json'), JSON.stringify(fixtures))
      writeFileSync(
        join(directory, 'main.swift'),
        `
import Foundation
import Security
struct Fixture: Decodable { let key: String; let request: Request }
for operation in ["backup", "set-auth", "recover"] {
    guard sensitiveAuthenticationReason(operation) != nil else { fatalError("Missing fresh authentication") }
}
for operation in ["status", "unlock", "create"] {
    guard sensitiveAuthenticationReason(operation) == nil else { fatalError("Unexpected routine prompt") }
}
var requirement: SecRequirement?
guard SecRequirementCreateWithString(trustedReleaseRequirement as CFString, [], &requirement) == errSecSuccess else { fatalError("Invalid caller requirement") }
let fixtures = try JSONDecoder().decode([Fixture].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
for fixture in fixtures {
    let key = Data(base64Encoded: fixture.key)!
    try verifyManifestKey(key, request: fixture.request)
    do {
        try verifyManifestKey(Data(repeating: 0, count: 32), request: fixture.request)
        fatalError("Accepted wrong recovery key")
    } catch Failure.corrupt { }
}
print("Native policy and manifest authentication passed")
`,
      )
      const executable = join(directory, 'policy-test')
      execFileSync(
        '/usr/bin/xcrun',
        [
          'swiftc',
          '-module-cache-path',
          join(directory, 'module-cache'),
          resolve('native/profile-vault/policy.swift'),
          join(directory, 'main.swift'),
          '-o',
          executable,
        ],
        { timeout: 120_000, stdio: 'pipe' },
      )
      assert.match(
        execFileSync(executable, [join(directory, 'fixtures.json')], {
          encoding: 'utf8',
          timeout: 10_000,
        }),
        /Native policy and manifest authentication passed/,
      )
    } finally {
      key.fill(0)
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
