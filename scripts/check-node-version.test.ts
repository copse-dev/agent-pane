import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { expectRecord, parseJsonUnknown } from '../src/shared/unknown-value.mts'
import {
  codesignRefusal,
  diagnoseNativeAddonLoading,
  isSupportedVersion,
  libraryValidationRefusal,
  nativeAddonRefusalMessage,
  pathEntryProviding,
  type NativeAddonProbe,
} from './check-node-version.cjs'

const CHATGPT_NODE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node'
const NVM_NODE = '/Users/dev/.nvm/versions/node/v24.22.1/bin/node'
const ADDON =
  '/Users/dev/agent-pane/packages/extract-zip/node_modules/@electron-internal/extract-zip/index.darwin-universal.node'

const TEAM_ID_REFUSAL =
  `dlopen(${ADDON}, 0x0001): tried: '${ADDON}' (code signature in <6E1B2C3D-4F5A-3B6C-8D7E-9F0A1B2C3D4E> ` +
  `'${ADDON}' not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs), ` +
  `'/System/Volumes/Preboot/Cryptexes/OS${ADDON}' (no such file)`
const WRONG_ARCHITECTURE =
  `dlopen(${ADDON}, 0x0001): tried: '${ADDON}' (mach-o file, but is an incompatible architecture ` +
  `(have 'x86_64', need 'arm64e' or 'arm64'))`

function dlopenError(message: string, code = 'ERR_DLOPEN_FAILED'): Error {
  return Object.assign(new Error(message), { code })
}

function codesignOutput(fields: { flags: string; team: string; entitlements?: string[] }): string {
  const entitlements = (fields.entitlements ?? []).flatMap((key) => [
    `\t[Key] ${key}`,
    '\t[Value]',
    '\t\t[Bool] true',
  ])
  return [
    `Executable=${CHATGPT_NODE}`,
    'Identifier=node',
    'Format=Mach-O thin (arm64)',
    `CodeDirectory v=20500 size=561404 flags=${fields.flags} hashes=17532+7 location=embedded`,
    'Info.plist=not bound',
    `TeamIdentifier=${fields.team}`,
    'Sealed Resources=none',
    '[Dict]',
    ...entitlements,
  ].join('\n')
}

const JIT = 'com.apple.security.cs.allow-jit'
const DISABLE_LV = 'com.apple.security.cs.disable-library-validation'

describe('install hooks', () => {
  it('run the check before pnpm builds dependencies', () => {
    // pnpm builds allowed dependencies before the root `preinstall`, and
    // electron-chromedriver's install loads a native addon; only
    // `pnpm:devPreinstall` runs ahead of those builds.
    const manifest = expectRecord(parseJsonUnknown(readFileSync('package.json', 'utf8')), 'package')
    const scripts = expectRecord(manifest['scripts'], 'package scripts')
    assert.equal(scripts['pnpm:devPreinstall'], 'node scripts/check-node-version.cjs')
    assert.equal(scripts['preinstall'], 'node scripts/check-node-version.cjs')
  })
})

describe('isSupportedVersion', () => {
  it('keeps the CVE-2026-111497 minimums', () => {
    assert.equal(isSupportedVersion('24.22.1'), true)
    assert.equal(isSupportedVersion('24.22.0'), false)
    assert.equal(isSupportedVersion('25.9.0'), false)
    assert.equal(isSupportedVersion('26.12.1'), true)
    assert.equal(isSupportedVersion('27.0.0'), true)
  })
})

describe('libraryValidationRefusal', () => {
  it("returns dyld's clause when library validation refuses another team's addon", () => {
    assert.equal(
      libraryValidationRefusal(dlopenError(TEAM_ID_REFUSAL)),
      'not valid for use in process: mapping process and mapped file (non-platform) have different Team IDs',
    )
  })

  it('ignores failures that say nothing about the Node binary', () => {
    assert.equal(libraryValidationRefusal(dlopenError(WRONG_ARCHITECTURE)), null)
    assert.equal(libraryValidationRefusal(dlopenError(TEAM_ID_REFUSAL, 'ENOENT')), null)
    assert.equal(libraryValidationRefusal(new Error(TEAM_ID_REFUSAL)), null)
    assert.equal(libraryValidationRefusal('not valid for use in process'), null)
    const quarantined = `dlopen(${ADDON}, 0x0001): tried: '${ADDON}' (code signature in <6E1B> '${ADDON}' not valid for use in process: library load disallowed by system policy)`
    assert.equal(libraryValidationRefusal(dlopenError(quarantined)), null)
  })
})

describe('codesignRefusal', () => {
  it('flags a hardened Node signed by another team without the library-validation exemption', () => {
    const evidence = codesignRefusal(
      codesignOutput({ flags: '0x10000(runtime)', team: '2DC432GLL2', entitlements: [JIT] }),
    )
    assert.equal(
      evidence,
      'codesign reports flags=0x10000(runtime), TeamIdentifier=2DC432GLL2 and no ' +
        'com.apple.security.cs.disable-library-validation entitlement',
    )
  })

  it('passes the nodejs.org build nvm and fnm install', () => {
    const official = { flags: '0x10000(runtime)', team: 'HX7739G8FX' }
    assert.equal(
      codesignRefusal(codesignOutput({ ...official, entitlements: [JIT, DISABLE_LV] })),
      null,
    )
    // The OpenJS team passes even if the entitlement is not reported.
    assert.equal(codesignRefusal(codesignOutput(official)), null)
  })

  it('passes ad-hoc and exempted builds', () => {
    assert.equal(
      codesignRefusal(codesignOutput({ flags: '0x20002(adhoc,linker-signed)', team: 'not set' })),
      null,
    )
    assert.equal(
      codesignRefusal(
        codesignOutput({
          flags: '0x12000(library-validation,runtime)',
          team: '2DC432GLL2',
          entitlements: [DISABLE_LV],
        }),
      ),
      null,
    )
    assert.equal(codesignRefusal('code object is not signed at all'), null)
  })
})

describe('diagnoseNativeAddonLoading', () => {
  function probe(overrides: Partial<NativeAddonProbe>): NativeAddonProbe {
    return {
      platform: 'darwin',
      execPath: CHATGPT_NODE,
      addons: [ADDON],
      exists: () => true,
      dlopen: () => undefined,
      codesign: () => assert.fail('codesign should not run'),
      ...overrides,
    }
  }
  const hardened = codesignOutput({ flags: '0x10000(runtime)', team: '2DC432GLL2' })

  it('does nothing off macOS', () => {
    const result = diagnoseNativeAddonLoading(
      probe({ platform: 'linux', dlopen: () => assert.fail('dlopen should not run') }),
    )
    assert.equal(result, null)
  })

  it('trusts an addon that loads over the code signature', () => {
    assert.equal(diagnoseNativeAddonLoading(probe({})), null)
  })

  it('reports the addon library validation refused', () => {
    const result = diagnoseNativeAddonLoading(
      probe({
        dlopen: () => {
          throw dlopenError(TEAM_ID_REFUSAL)
        },
      }),
    )
    assert.equal(result?.addon, ADDON)
    assert.ok(result.evidence.endsWith('have different Team IDs'))
  })

  it('reads the code signature when no addon is installed yet', () => {
    const result = diagnoseNativeAddonLoading(
      probe({ exists: () => false, codesign: () => hardened }),
    )
    assert.equal(result?.addon, null)
    assert.ok(result.evidence.includes('TeamIdentifier=2DC432GLL2'))
  })

  it('falls back to the code signature when a load fails for another reason', () => {
    const tried: string[] = []
    const result = diagnoseNativeAddonLoading(
      probe({
        addons: [ADDON, '/elsewhere/fsevents.node'],
        dlopen: (addon) => {
          tried.push(addon)
          throw dlopenError(WRONG_ARCHITECTURE)
        },
        codesign: () => null,
      }),
    )
    assert.equal(result, null)
    assert.deepEqual(tried, [ADDON, '/elsewhere/fsevents.node'])
  })
})

describe('pathEntryProviding', () => {
  it('finds the PATH entry whose node resolves to this binary', () => {
    const links = new Map([
      [CHATGPT_NODE, CHATGPT_NODE],
      ['/Applications/ChatGPT.app/Contents/Resources/node', CHATGPT_NODE],
      [NVM_NODE, NVM_NODE],
    ])
    const realpath = (path: string): string => {
      const target = links.get(path)
      if (target === undefined) throw new Error(`ENOENT: ${path}`)
      return target
    }
    const PATH = `/usr/bin::/Applications/ChatGPT.app/Contents/Resources:${NVM_NODE.slice(0, -5)}`
    assert.equal(
      pathEntryProviding(CHATGPT_NODE, PATH, realpath),
      '/Applications/ChatGPT.app/Contents/Resources',
    )
    assert.equal(pathEntryProviding('/opt/elsewhere/node', PATH, realpath), null)
  })
})

describe('nativeAddonRefusalMessage', () => {
  const refusal = { addon: ADDON, evidence: 'not valid for use in process' }

  it('names the binary, the cause and the PATH fix', () => {
    const message = nativeAddonRefusalMessage({
      execPath: CHATGPT_NODE,
      pathEntry: '/Applications/ChatGPT.app/Contents/Resources',
      refusal,
    })
    assert.ok(message.includes(`  ${CHATGPT_NODE}\n`))
    assert.ok(message.includes('refuses unsigned or third-party native modules'))
    assert.ok(message.includes("Put nvm's or Homebrew's Node first on PATH"))
    assert.ok(message.includes('A desktop app bundled this Node: /Applications/ChatGPT.app\n'))
    assert.ok(
      message.includes('PATH reaches it through /Applications/ChatGPT.app/Contents/Resources'),
    )
    assert.ok(message.includes(`Evidence: dlopen refused ${ADDON}`))
  })

  it('mentions a desktop app only for a binary inside an app bundle', () => {
    const message = nativeAddonRefusalMessage({
      execPath: '/opt/custom/bin/node',
      pathEntry: null,
      refusal: { addon: null, evidence: 'codesign reports flags=0x10000(runtime)' },
    })
    assert.ok(!message.includes('desktop app'))
    assert.ok(!message.includes('PATH reaches it'))
    assert.ok(message.includes('the PATH directory that provides this node'))
  })
})
