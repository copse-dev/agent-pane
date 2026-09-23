import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  checkMacosNativeToolchain,
  type NativeToolchainCommandResult,
  type NativeToolchainCommandRunner,
} from './check-macos-native-toolchain.mts'

const temporaryRoot = mkdtempSync(join(tmpdir(), 'copse-native-toolchain-test-'))

after(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

function commandResult(
  stdout = '',
  stderr = '',
  status: number | null = 0,
): NativeToolchainCommandResult {
  return { status, signal: null, stdout, stderr }
}

function toolchainRunner(compilerResult = commandResult()): {
  runCommand: NativeToolchainCommandRunner
  calls: string[]
} {
  const calls: string[] = []
  const runCommand: NativeToolchainCommandRunner = (command, args) => {
    calls.push([command, ...args].join(' '))
    if (command === '/usr/bin/xcode-select') {
      return commandResult('/Applications/Xcode.app/Contents/Developer\n')
    }
    if (command === '/usr/bin/xcrun' && args.includes('--show-sdk-path')) {
      return commandResult('/Applications/Xcode.app/SDKs/MacOSX27.0.sdk\n')
    }
    if (command === '/usr/bin/xcrun' && args.includes('--find')) {
      return commandResult('/Applications/Xcode.app/Toolchains/usr/bin/clang++\n')
    }
    if (command === '/Applications/Xcode.app/Toolchains/usr/bin/clang++') {
      return compilerResult
    }
    return commandResult('', `unexpected command: ${command}`, 1)
  }
  return { runCommand, calls }
}

describe('macOS native toolchain preflight', () => {
  it('does nothing outside macOS', () => {
    let called = false
    checkMacosNativeToolchain({
      platform: 'linux',
      runCommand: () => {
        called = true
        return commandResult()
      },
    })
    assert.equal(called, false)
  })

  it('accepts a toolchain that can link against its selected SDK', () => {
    const { runCommand, calls } = toolchainRunner()

    assert.doesNotThrow(() => {
      checkMacosNativeToolchain({ platform: 'darwin', runCommand, temporaryRoot })
    })
    assert.equal(calls.length, 4)
    assert.match(calls[3] ?? '', /clang\+\+ -isysroot .*MacOSX27\.0\.sdk .*probe\.cc -o .*probe$/)
  })

  it('turns an SDK/linker mismatch into an actionable Xcode diagnostic', () => {
    const { runCommand } = toolchainRunner(
      commandResult('', 'libSystem.B.tbd:4:20: error: unknown architecture arm64e.x1-macos\n', 1),
    )

    assert.throws(
      () => {
        checkMacosNativeToolchain({ platform: 'darwin', runCommand, temporaryRoot })
      },
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(
          error.message,
          /selected Apple developer toolchain failed a compile\/link check/,
        )
        assert.match(
          error.message,
          /Developer directory: \/Applications\/Xcode\.app\/Contents\/Developer/,
        )
        assert.match(error.message, /macOS SDK: .*MacOSX27\.0\.sdk/)
        assert.match(error.message, /C\+\+ compiler: .*clang\+\+/)
        assert.match(error.message, /unknown architecture arm64e\.x1-macos/)
        assert.match(
          error.message,
          /sudo xcode-select --switch \/Applications\/Xcode\.app\/Contents\/Developer/,
        )
        assert.match(error.message, /sudo xcodebuild -runFirstLaunch/)
        assert.match(error.message, /make run/)
        return true
      },
    )
  })

  it('identifies a DEVELOPER_DIR override when tool discovery fails', () => {
    const runCommand: NativeToolchainCommandRunner = (_command, args) =>
      commandResult('', `xcrun failed for ${args.join(' ')}`, 1)

    assert.throws(
      () => {
        checkMacosNativeToolchain({
          platform: 'darwin',
          env: { DEVELOPER_DIR: '/Applications/Xcode-beta.app/Contents/Developer' },
          runCommand,
          temporaryRoot,
        })
      },
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(
          error.message,
          /Developer directory: \/Applications\/Xcode-beta\.app\/Contents\/Developer \(from DEVELOPER_DIR\)/,
        )
        assert.match(error.message, /DEVELOPER_DIR overrides xcode-select/)
        assert.match(error.message, /macOS SDK: \(unavailable\)/)
        return true
      },
    )
  })
})
