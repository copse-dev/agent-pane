import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const XCODE_SELECT = '/usr/bin/xcode-select'
const XCRUN = '/usr/bin/xcrun'
const MAX_FAILURE_OUTPUT = 4_000

export interface NativeToolchainCommandResult {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  errorMessage?: string
}

export type NativeToolchainCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => NativeToolchainCommandResult

export interface NativeToolchainCheckOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  temporaryRoot?: string
  runCommand?: NativeToolchainCommandRunner
}

interface Observation {
  value: string | null
  failure: string | null
}

function defaultRunCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): NativeToolchainCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error ? { errorMessage: result.error.message } : {}),
  }
}

function commandFailure(result: NativeToolchainCommandResult): string {
  const output = result.stderr.trim() || result.stdout.trim()
  if (output) return output
  if (result.errorMessage) return result.errorMessage
  if (result.signal) return `terminated by ${result.signal}`
  return `exited with status ${String(result.status)}`
}

function observeCommand(
  label: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  runCommand: NativeToolchainCommandRunner,
): Observation {
  const result = runCommand(command, args, env)
  const value = result.stdout.trim()
  if (result.status === 0 && value) return { value, failure: null }
  return { value: null, failure: `${label}: ${commandFailure(result)}` }
}

function boundedFailureOutput(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= MAX_FAILURE_OUTPUT) return trimmed
  return `${trimmed.slice(0, MAX_FAILURE_OUTPUT)}\n… output truncated`
}

function toolchainError(
  developerDirectory: Observation,
  developerDirectoryFromEnvironment: boolean,
  sdk: Observation,
  compiler: Observation,
  failure: string,
): Error {
  const developerSource = developerDirectoryFromEnvironment ? ' (from DEVELOPER_DIR)' : ''
  const lines = [
    '',
    'ERROR: Copse cannot build its macOS native module because the selected Apple developer toolchain failed a compile/link check.',
    '',
    `  Developer directory: ${developerDirectory.value ?? '(unavailable)'}${developerSource}`,
    `  macOS SDK: ${sdk.value ?? '(unavailable)'}`,
    `  C++ compiler: ${compiler.value ?? '(unavailable)'}`,
    '',
    'Xcode or the Command Line Tools may be incomplete or out of sync after a macOS/Xcode update.',
    'Update Xcode, then finish its setup and select it:',
    '',
    '  sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer',
    '  sudo xcodebuild -runFirstLaunch',
    '',
  ]
  if (developerDirectoryFromEnvironment) {
    lines.push(
      'DEVELOPER_DIR overrides xcode-select for this build. Clear it or point it at the updated Xcode before retrying.',
      '',
    )
  }
  lines.push(
    'If you use only the standalone Command Line Tools, update them in System Settings > General > Software Update,',
    'or start their installation with:',
    '',
    '  xcode-select --install',
    '',
    'Then retry:',
    '',
    '  make run',
    '',
    'Toolchain check output:',
    boundedFailureOutput(failure),
  )
  return new Error(lines.join('\n'))
}

/**
 * Link a tiny C++ program with the selected macOS SDK before node-gyp emits a
 * long native-module build log. This catches partial Xcode/CLT updates where
 * clang can compile sources but its linker cannot parse the newly installed
 * SDK's text-based stubs.
 */
export function checkMacosNativeToolchain(options: NativeToolchainCheckOptions = {}): void {
  if ((options.platform ?? process.platform) !== 'darwin') return

  const env = options.env ?? process.env
  const runCommand = options.runCommand ?? defaultRunCommand
  const developerOverride = env['DEVELOPER_DIR']?.trim() ?? ''
  const developerDirectory = developerOverride
    ? { value: developerOverride, failure: null }
    : observeCommand(
        'Could not resolve the selected developer directory',
        XCODE_SELECT,
        ['--print-path'],
        env,
        runCommand,
      )
  const sdk = observeCommand(
    'Could not resolve the macOS SDK',
    XCRUN,
    ['--sdk', 'macosx', '--show-sdk-path'],
    env,
    runCommand,
  )
  const compiler = observeCommand(
    'Could not resolve clang++',
    XCRUN,
    ['--sdk', 'macosx', '--find', 'clang++'],
    env,
    runCommand,
  )

  const inspectionFailures: string[] = []
  if (developerDirectory.failure) inspectionFailures.push(developerDirectory.failure)
  if (sdk.failure) inspectionFailures.push(sdk.failure)
  if (compiler.failure) inspectionFailures.push(compiler.failure)
  if (sdk.value === null || compiler.value === null) {
    throw toolchainError(
      developerDirectory,
      Boolean(developerOverride),
      sdk,
      compiler,
      inspectionFailures.join('\n'),
    )
  }

  const probeDirectory = mkdtempSync(
    join(options.temporaryRoot ?? tmpdir(), 'copse-native-toolchain-'),
  )
  try {
    const source = join(probeDirectory, 'probe.cc')
    const executable = join(probeDirectory, 'probe')
    writeFileSync(source, 'int main() { return 0; }\n')
    const result = runCommand(
      compiler.value,
      ['-isysroot', sdk.value, source, '-o', executable],
      env,
    )
    if (result.status !== 0) {
      throw toolchainError(
        developerDirectory,
        Boolean(developerOverride),
        sdk,
        compiler,
        commandFailure(result),
      )
    }
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true })
  }
}

function main(): void {
  checkMacosNativeToolchain()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
