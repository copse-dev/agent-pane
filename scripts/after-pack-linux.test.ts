import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

type CheckLinuxNatives = (resources: string, arch: 'x64' | 'arm64') => void

// A runtime path keeps the test bundler from inlining the CommonJS hook, whose
// `module.exports` is the afterPack function with the helper attached to it.
const afterPackPath = pathToFileURL(resolve('scripts/after-pack.cjs')).href
const afterPack: unknown = z
  .object({ default: z.unknown() })
  .parse(await import(afterPackPath)).default
const helper: unknown =
  typeof afterPack === 'function' ? Reflect.get(afterPack, 'checkLinuxNatives') : undefined
const checkLinuxNatives = z
  .custom<CheckLinuxNatives>((value) => typeof value === 'function')
  .parse(helper)

const X64 = 0x3e
const ARM64 = 0xb7

function elf(machine: number): Buffer {
  const header = Buffer.alloc(64)
  header.writeUInt32BE(0x7f454c46, 0)
  header.writeUInt16LE(machine, 18)
  return header
}

const NATIVES = [
  'app.asar.unpacked/dist/resources/gortex/gortex',
  'app.asar.unpacked/node_modules/node-pty/build/Release/pty.node',
  'app.asar.unpacked/node_modules/@napi-rs/keyring-linux-x64-gnu/keyring.linux-x64-gnu.node',
  'app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp',
]

const JAR =
  'app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar'

describe('Linux after-pack native check', () => {
  let resources: string

  beforeEach(() => {
    resources = mkdtempSync(join(tmpdir(), 'copse-after-pack-linux-'))
    write(JAR, Buffer.from('PK'))
  })

  afterEach(() => {
    rmSync(resources, { recursive: true, force: true })
  })

  function write(relative: string, contents: Buffer): void {
    const path = join(resources, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    chmodSync(path, 0o755)
  }

  it('accepts a package whose natives all match the target architecture', () => {
    for (const native of NATIVES) write(native, elf(X64))
    checkLinuxNatives(resources, 'x64')
  })

  it('fails when node-pty was left without its compiled binding', () => {
    for (const native of NATIVES) {
      if (!native.endsWith('pty.node')) write(native, elf(X64))
    }
    assert.throws(() => {
      checkLinuxNatives(resources, 'x64')
    }, /lacks .*pty\.node/)
  })

  it('fails when a native binary targets another architecture', () => {
    for (const native of NATIVES) write(native, elf(native.endsWith('gortex') ? ARM64 : X64))
    assert.throws(() => {
      checkLinuxNatives(resources, 'x64')
    }, /gortex targets ELF machine 0xb7, not x64/)
  })

  it('fails when the seccomp helper lost its executable bit', () => {
    for (const native of NATIVES) write(native, elf(X64))
    chmodSync(join(resources, NATIVES[3] ?? ''), 0o644)
    assert.throws(() => {
      checkLinuxNatives(resources, 'x64')
    }, /helper is not executable: .*apply-seccomp/)
  })

  it('fails when the JVM proxy agent jar was left inside app.asar', () => {
    for (const native of NATIVES) write(native, elf(X64))
    rmSync(join(resources, JAR))
    assert.throws(() => {
      checkLinuxNatives(resources, 'x64')
    }, /lacks .*srt-proxy-agent\.jar/)
  })
})
