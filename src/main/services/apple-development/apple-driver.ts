import type { ChildProcess } from 'node:child_process'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, realpath } from 'node:fs/promises'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import type {
  AppleAction,
  AppleCandidate,
  AppleDestination,
  AppleDiagnostic,
  AppleSelection,
  AppleTestSummary,
} from '@shared/types/apple-development.ts'
import { ensureWorkspaceTmpDir } from '../../project-sandbox/config.ts'
import { spawnInProjectSandbox } from '../../project-sandbox/spawn.ts'
import { terminateProcessTree } from '../exec/subprocess-kill.ts'

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_CANDIDATES = 100
const MAX_DISCOVERY_DEPTH = 6
const MAX_DISCOVERY_DIRECTORIES = 2_000
const MAX_DETECTION_DEPTH = 4
const MAX_DETECTION_DIRECTORIES = 256
const MAX_SCHEMES = 200
const MAX_DESTINATIONS = 200
const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  '.build',
  '.git',
  '.swiftpm',
  'build',
  'Carthage',
  'DerivedData',
  'node_modules',
  'Pods',
])

const listOutputSchema = z.object({
  workspace: z.object({ schemes: z.array(z.string()) }).optional(),
  project: z.object({ schemes: z.array(z.string()) }).optional(),
})

const simulatorOutputSchema = z.object({
  devices: z.record(
    z.string(),
    z.array(
      z.object({
        name: z.string(),
        udid: z.string(),
        isAvailable: z.boolean().optional(),
        state: z.string().optional(),
      }),
    ),
  ),
})
const buildSettingsOutputSchema = z.array(
  z.object({
    buildSettings: z.record(z.string(), z.string()),
  }),
)
const MAX_PACKAGE_FILE_BYTES = 4 * 1024 * 1024

export interface AppleDriverDiscovery {
  toolchain: { developerDir: string; version: string } | null
  candidates: AppleCandidate[]
  destinations: AppleDestination[]
  metadataRequiresExecution: boolean
  setupMessage: string | null
}

export interface AppleDriverPlan {
  operationId: string
  root: string
  target: AppleSelection
  action: AppleAction
  testFilter?: string
}

export interface AppleDriverResult {
  exitCode: number | null
  failureReason?: string
  logs: string
  outputTruncated: boolean
  diagnostics: AppleDiagnostic[]
  testSummary: AppleTestSummary | null
  resultBundlePath?: string
  appSession?: { id: string }
}

interface ProcessResult {
  exitCode: number | null
  output: string
  stdout: string
  stderr: string
  truncated: boolean
}

export interface AppleOperationPaths {
  outputRoot: string
  derivedDataPath: string
  clonedSourcePackagesPath: string
  packageCachePath: string
}

export function appleOperationPaths(root: string, operationId: string): AppleOperationPaths {
  const scratchRoot = resolve(ensureWorkspaceTmpDir(), 'apple-development')
  const checkoutKey = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 32)
  const operationKey = createHash('sha256').update(operationId).digest('hex').slice(0, 32)
  const checkoutRoot = resolve(scratchRoot, checkoutKey)
  return {
    outputRoot: resolve(checkoutRoot, 'operations', operationKey),
    derivedDataPath: resolve(checkoutRoot, 'operations', operationKey, 'DerivedData'),
    clonedSourcePackagesPath: resolve(checkoutRoot, 'SourcePackages'),
    packageCachePath: resolve(checkoutRoot, 'PackageCache'),
  }
}

export function appleBuildPathArguments(paths: AppleOperationPaths): string[] {
  return [
    '-derivedDataPath',
    paths.derivedDataPath,
    '-clonedSourcePackagesDirPath',
    paths.clonedSourcePackagesPath,
    '-packageCachePath',
    paths.packageCachePath,
  ]
}

export function appleBuildActionArguments(paths: AppleOperationPaths): string[] {
  return [...appleBuildPathArguments(paths), '-allowProvisioningUpdates']
}

async function ensureContainedDirectory(root: string, target: string): Promise<string> {
  const relativeTarget = relative(root, target)
  if (
    relativeTarget === '' ||
    isAbsolute(relativeTarget) ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`)
  ) {
    throw new Error('Apple operation storage resolved outside Copse scratch space.')
  }
  let cursor = root
  for (const segment of relativeTarget.split(sep)) {
    const next = resolve(cursor, segment)
    await mkdir(next, { recursive: true })
    const canonical = await realpath(next)
    if (!withinRoot(root, canonical)) {
      throw new Error('Apple operation storage contains a symlink outside Copse scratch space.')
    }
    cursor = canonical
  }
  return cursor
}

export async function prepareAppleOperationPaths(
  root: string,
  operationId: string,
): Promise<AppleOperationPaths> {
  const scratchRoot = await realpath(ensureWorkspaceTmpDir())
  const requested = appleOperationPaths(root, operationId)
  return {
    outputRoot: await ensureContainedDirectory(scratchRoot, requested.outputRoot),
    derivedDataPath: await ensureContainedDirectory(scratchRoot, requested.derivedDataPath),
    clonedSourcePackagesPath: await ensureContainedDirectory(
      scratchRoot,
      requested.clonedSourcePackagesPath,
    ),
    packageCachePath: await ensureContainedDirectory(scratchRoot, requested.packageCachePath),
  }
}

function withinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  )
}

async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  const child = await spawnInProjectSandbox(executable, args, {
    cwd,
    ...(env ? { env } : {}),
    signal,
    stdio: 'pipe',
    // Xcode projects may run build scripts and Xcode needs package, cache,
    // signing, developer-service, and Simulator access. The caller obtains
    // authority from a direct UI action or an agent-tool approval before this
    // driver runs; pretending those operations fit the generic project sandbox
    // makes ordinary builds fail while providing a misleading security boundary.
    unsandboxed: true,
  })
  let output = ''
  let stdout = ''
  let stderr = ''
  let bytes = 0
  let stdoutBytes = 0
  let stderrBytes = 0
  let truncated = false
  const appendOutput = (chunk: Buffer): void => {
    if (bytes >= MAX_OUTPUT_BYTES) {
      truncated = true
      return
    }
    const remaining = MAX_OUTPUT_BYTES - bytes
    const accepted = chunk.subarray(0, remaining)
    output += accepted.toString('utf8')
    bytes += accepted.byteLength
    if (accepted.byteLength < chunk.byteLength) truncated = true
  }
  const appendStdout = (chunk: Buffer): void => {
    if (stdoutBytes >= MAX_OUTPUT_BYTES) {
      truncated = true
      return
    }
    const remaining = MAX_OUTPUT_BYTES - stdoutBytes
    const accepted = chunk.subarray(0, remaining)
    stdout += accepted.toString('utf8')
    stdoutBytes += accepted.byteLength
    if (accepted.byteLength < chunk.byteLength) truncated = true
  }
  const appendStderr = (chunk: Buffer): void => {
    if (stderrBytes >= MAX_OUTPUT_BYTES) {
      truncated = true
      return
    }
    const remaining = MAX_OUTPUT_BYTES - stderrBytes
    const accepted = chunk.subarray(0, remaining)
    stderr += accepted.toString('utf8')
    stderrBytes += accepted.byteLength
    if (accepted.byteLength < chunk.byteLength) truncated = true
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    appendOutput(chunk)
    appendStdout(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    appendOutput(chunk)
    appendStderr(chunk)
  })
  const cancelKill: { value: (() => void) | null } = { value: null }
  const abort = (): void => {
    cancelKill.value = terminateProcessTree(child)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await new Promise((resolveResult, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        resolveResult({ exitCode: code, output, stdout, stderr, truncated })
      })
    })
  } finally {
    signal.removeEventListener('abort', abort)
    cancelKill.value?.()
  }
}

function candidateArg(candidate: AppleCandidate): ['-workspace' | '-project', string] {
  return candidate.kind === 'workspace' ? ['-workspace', candidate.id] : ['-project', candidate.id]
}

/** Keep only concrete destinations Xcode reports as eligible for the selected scheme. */
export function parseCompatibleDestinations(
  output: string,
  available: readonly AppleDestination[],
): AppleDestination[] {
  const destinations: AppleDestination[] = []
  let eligible = false
  for (const line of output.split(/\r?\n/)) {
    if (/Available destinations/i.test(line)) {
      eligible = true
      continue
    }
    if (/Ineligible destinations/i.test(line)) {
      eligible = false
      continue
    }
    if (!eligible) continue
    const platform = /(?:^|[{,])\s*platform:\s*([^,}]+)/i.exec(line)?.[1]?.trim()
    const id = /(?:^|[{,])\s*id:\s*([^,}]+)/i.exec(line)?.[1]?.trim()
    const destination = available.find((item) => {
      if (platform === 'macOS') return item.platform === 'macOS'
      return platform === 'iOS Simulator' && id !== undefined && item.id.endsWith(`id=${id}`)
    })
    if (destination && !destinations.some((item) => item.id === destination.id)) {
      destinations.push(destination)
    }
  }
  return destinations.slice(0, MAX_DESTINATIONS)
}

export async function discoverSharedSchemes(
  root: string,
  candidate: AppleCandidate,
): Promise<string[]> {
  const canonicalRoot = await realpath(root).catch(() => null)
  if (!canonicalRoot) return []
  const candidatePath = await realpath(resolve(canonicalRoot, candidate.id)).catch(() => null)
  if (!candidatePath || !withinRoot(canonicalRoot, candidatePath)) return []
  const schemeDirectory = await realpath(resolve(candidatePath, 'xcshareddata', 'xcschemes')).catch(
    () => null,
  )
  if (!schemeDirectory || !withinRoot(canonicalRoot, schemeDirectory)) return []
  const entries = await readdir(schemeDirectory, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.xcscheme')
    .map((entry) => basename(entry.name, '.xcscheme'))
    .filter((scheme) => scheme.length > 0 && scheme.length <= 256)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_SCHEMES)
}

async function readBoundedText(path: string): Promise<string | null> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(MAX_PACKAGE_FILE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_PACKAGE_FILE_BYTES) return null
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Local Swift package references that cannot be resolved from the selected project. */
export async function discoverMissingLocalPackages(
  root: string,
  candidateId: string,
): Promise<string[]> {
  const canonicalRoot = await realpath(root).catch(() => null)
  if (!canonicalRoot) return []
  const candidatePath = await realpath(resolve(canonicalRoot, candidateId)).catch(() => null)
  if (
    !candidatePath ||
    !withinRoot(canonicalRoot, candidatePath) ||
    extname(candidatePath) !== '.xcodeproj'
  ) {
    return []
  }
  const projectFile = await realpath(resolve(candidatePath, 'project.pbxproj')).catch(() => null)
  if (!projectFile || !withinRoot(canonicalRoot, projectFile)) return []
  const text = await readBoundedText(projectFile)
  if (!text) return []

  const missing = new Set<string>()
  for (const object of text.matchAll(
    /\{[^{}]*\bisa\s*=\s*XCLocalSwiftPackageReference;[^{}]*\}/g,
  )) {
    const pathMatch = /\brelativePath\s*=\s*(?:"([^"]+)"|([^;\s]+))\s*;/.exec(object[0])
    const packagePath = pathMatch?.[1] ?? pathMatch?.[2]
    if (!packagePath || packagePath.length > 1_024) continue
    const resolvedPackage = await realpath(resolve(dirname(candidatePath), packagePath)).catch(
      () => null,
    )
    if (!resolvedPackage) missing.add(packagePath)
  }
  return [...missing].sort((left, right) => left.localeCompare(right)).slice(0, 50)
}

export function xcodeFailureDetail(stderr: string): string | null {
  const lines = stderr
    .replaceAll(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const operationDenied = lines.some((line) =>
    /NSPOSIXErrorDomain Code=1 .*Operation not permitted/i.test(line),
  )
  if (operationDenied) {
    const fileUrl = lines
      .flatMap((line) => /NSURL\s*=\s*"?(file:\/\/\/[^";,}]+)/.exec(line)?.[1] ?? [])
      .at(-1)
    try {
      const path = fileUrl ? decodeURIComponent(new URL(fileUrl).pathname) : null
      if (!path) throw new Error('No denied path')
      return `Xcode could not access ${path}: Operation not permitted.`.slice(0, 1_500)
    } catch {
      // Fall through to the bounded original line when Xcode emits a malformed URL.
    }
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (
      line &&
      /(?:unable|failed) to open .*(?:permission|authorization)|(?:don.t|don’t) have permission|operation not permitted/i.test(
        line,
      )
    ) {
      return line.slice(0, 1_500)
    }
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line && /:\s*error:\s+\S/i.test(line)) return line.slice(0, 1_500)
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (
      line &&
      !/^The following build commands failed:$/i.test(line) &&
      !/^\*{0,2}\s*BUILD FAILED\s*\*{0,2}$/i.test(line) &&
      !/^(?:error:\s*)?permissionDenied$/i.test(line) &&
      /error:|failed|could not|cannot|does(?:n't|n’t) exist|permission denied|authorization denied/i.test(
        line,
      )
    ) {
      return line.slice(0, 1_500)
    }
  }
  return lines.at(-1)?.slice(0, 1_500) ?? null
}

function optionalFailureReason(result: ProcessResult): { failureReason?: string } {
  const reason = xcodeFailureDetail(result.output)
  return reason ? { failureReason: reason } : {}
}

function parseDiagnostics(output: string, root: string): AppleDiagnostic[] {
  const diagnostics: AppleDiagnostic[] = []
  const pattern = /^(.*?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm
  for (const match of output.matchAll(pattern)) {
    if (diagnostics.length >= 500) break
    const file = match[1]
    const line = Number(match[2])
    const column = Number(match[3])
    const severity = match[4]
    const message = match[5]
    if (!file || !severity || !message || !Number.isInteger(line) || !Number.isInteger(column)) {
      continue
    }
    const resolvedFile = resolve(root, file)
    diagnostics.push({
      severity: severity === 'error' || severity === 'warning' ? severity : 'note',
      message: message.slice(0, 8_192),
      ...(withinRoot(root, resolvedFile) ? { file: resolvedFile, line, column } : {}),
    })
  }
  return diagnostics
}

function parseTestSummary(output: string): AppleTestSummary | null {
  const match = /Executed (\d+) tests?, with (\d+) failures?(?: \((\d+) unexpected\))?/i.exec(
    output,
  )
  if (!match) return null
  const total = Number(match[1])
  const failed = Number(match[2])
  if (!Number.isInteger(total) || !Number.isInteger(failed)) return null
  return { passed: Math.max(0, total - failed), failed, skipped: null }
}

function boundedOutput(parts: readonly ProcessResult[]): {
  logs: string
  outputTruncated: boolean
} {
  let logs = ''
  let bytes = 0
  let outputTruncated = parts.some((part) => part.truncated)
  for (const part of parts) {
    const separator = logs === '' ? '' : '\n'
    const chunk = Buffer.from(`${separator}${part.output}`, 'utf8')
    const remaining = MAX_OUTPUT_BYTES - bytes
    if (remaining <= 0) {
      outputTruncated = true
      break
    }
    const accepted = chunk.subarray(0, remaining)
    logs += accepted.toString('utf8')
    bytes += accepted.byteLength
    if (accepted.byteLength < chunk.byteLength) outputTruncated = true
  }
  return { logs, outputTruncated }
}

async function scanAppleCandidates(
  root: string,
  limits: { maxCandidates: number; maxDepth: number; maxDirectories: number },
): Promise<AppleCandidate[]> {
  const canonicalRoot = await realpath(root)
  const candidates: AppleCandidate[] = []
  const pending: Array<{ directory: string; depth: number }> = [
    { directory: canonicalRoot, depth: 0 },
  ]
  let scannedDirectories = 0
  while (
    pending.length > 0 &&
    scannedDirectories < limits.maxDirectories &&
    candidates.length < limits.maxCandidates
  ) {
    const current = pending.shift()
    if (!current) break
    scannedDirectories += 1
    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => [])
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const extension = extname(entry.name)
      const path = resolve(current.directory, entry.name)
      if (extension === '.xcworkspace' || extension === '.xcodeproj') {
        const canonical = await realpath(path).catch(() => null)
        if (!canonical || !withinRoot(canonicalRoot, canonical)) continue
        const candidateId = relative(canonicalRoot, canonical).split(sep).join('/')
        if (candidateId.length === 0 || candidateId.length > 512) continue
        candidates.push({
          id: candidateId,
          name: candidateId.slice(0, -extension.length),
          kind: extension === '.xcworkspace' ? 'workspace' : 'project',
          schemes: [],
        })
        if (candidates.length >= limits.maxCandidates) break
        continue
      }
      if (
        current.depth >= limits.maxDepth ||
        entry.name.startsWith('.') ||
        IGNORED_DISCOVERY_DIRECTORIES.has(entry.name)
      ) {
        continue
      }
      pending.push({ directory: path, depth: current.depth + 1 })
    }
  }
  return candidates.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'workspace' ? -1 : 1
    return left.name.localeCompare(right.name)
  })
}

export function discoverAppleCandidates(root: string): Promise<AppleCandidate[]> {
  return scanAppleCandidates(root, {
    maxCandidates: MAX_CANDIDATES,
    maxDepth: MAX_DISCOVERY_DEPTH,
    maxDirectories: MAX_DISCOVERY_DIRECTORIES,
  })
}

/** A shallow, early-exit scan suitable for opening a project overflow menu. */
export async function detectAppleProject(root: string): Promise<boolean> {
  const candidates = await scanAppleCandidates(root, {
    maxCandidates: 1,
    maxDepth: MAX_DETECTION_DEPTH,
    maxDirectories: MAX_DETECTION_DIRECTORIES,
  })
  return candidates.length > 0
}

async function installedDeveloperTool(developerDir: string, tool: string): Promise<string> {
  if (!isAbsolute(developerDir)) throw new Error('The selected developer directory is invalid.')
  const canonicalDeveloperDir = await realpath(developerDir)
  const executable = await realpath(resolve(canonicalDeveloperDir, 'usr', 'bin', tool))
  if (!withinRoot(canonicalDeveloperDir, executable)) {
    throw new Error(`The selected ${tool} executable escapes the developer directory.`)
  }
  return executable
}

type AppleAppSession =
  | {
      kind: 'simulator'
      simulatorId: string
      bundleId: string
      developerDir: string
    }
  | {
      kind: 'macos'
      child: ChildProcess
    }

export class InstalledXcodeDriver {
  private readonly appSessions = new Map<string, AppleAppSession>()

  async discover(
    root: string,
    includeMetadata: boolean,
    signal: AbortSignal,
  ): Promise<AppleDriverDiscovery> {
    if (process.platform !== 'darwin') {
      return {
        toolchain: null,
        candidates: [],
        destinations: [],
        metadataRequiresExecution: false,
        setupMessage: 'Apple Development requires a local macOS host.',
      }
    }

    const developerDirResult = await runProcess('/usr/bin/xcode-select', ['-p'], root, signal)
    if (developerDirResult.exitCode !== 0 || !developerDirResult.output.trim()) {
      return {
        toolchain: null,
        candidates: await discoverAppleCandidates(root),
        destinations: [],
        metadataRequiresExecution: false,
        setupMessage: 'Install Xcode and select its developer directory to continue.',
      }
    }
    const developerDir = developerDirResult.output.trim()
    const env = { DEVELOPER_DIR: developerDir }
    const candidates = await discoverAppleCandidates(root)
    const xcodebuild = await installedDeveloperTool(developerDir, 'xcodebuild').catch(() => null)
    if (!xcodebuild) {
      return {
        toolchain: null,
        candidates,
        destinations: [],
        metadataRequiresExecution: false,
        setupMessage: 'The selected developer directory does not contain a complete Xcode.',
      }
    }
    if (!includeMetadata) {
      return {
        toolchain: {
          developerDir,
          version: 'Xcode detected',
        },
        candidates,
        destinations: [],
        metadataRequiresExecution: candidates.length > 0,
        setupMessage:
          candidates.length === 0
            ? 'No Xcode workspace or project was found within the project directory.'
            : null,
      }
    }

    const versionResult = await runProcess(xcodebuild, ['-version'], root, signal, env)

    for (const candidate of candidates) {
      const sharedSchemes = await discoverSharedSchemes(root, candidate)
      if (sharedSchemes.length > 0) {
        candidate.schemes = sharedSchemes
        continue
      }

      const [flag, value] = candidateArg(candidate)
      const listed = await runProcess(
        xcodebuild,
        ['-list', '-json', flag, value],
        root,
        signal,
        env,
      )
      const parsed = safeJsonParse(listed.stdout, decodeWithSchema(listOutputSchema))
      candidate.schemes = [...new Set(parsed?.workspace?.schemes ?? parsed?.project?.schemes ?? [])]
        .filter((scheme) => scheme.trim() !== '')
        .slice(0, MAX_SCHEMES)
      if (candidate.schemes.length === 0) {
        const detail = xcodeFailureDetail(listed.stderr)
        const summary =
          listed.exitCode === 0
            ? 'Xcode returned no shared schemes for this target.'
            : `Xcode could not load schemes for this target (exit ${String(listed.exitCode ?? 'unknown')})${detail ? `: ${detail}` : '.'}`
        candidate.metadataError = summary.slice(0, 2_048)
      }
    }

    const simctl = await installedDeveloperTool(developerDir, 'simctl').catch(() => null)
    const simulators = simctl
      ? await runProcess(simctl, ['list', 'devices', 'available', '--json'], root, signal, env)
      : { exitCode: null, output: '', stdout: '', stderr: '', truncated: false }
    const parsedSimulators = safeJsonParse(
      simulators.stdout,
      decodeWithSchema(simulatorOutputSchema),
    )
    const destinations: AppleDestination[] = [
      { id: 'platform=macOS', name: 'This Mac', platform: 'macOS', supported: true },
    ]
    for (const [runtime, devices] of Object.entries(parsedSimulators?.devices ?? {})) {
      if (!runtime.includes('iOS')) continue
      for (const device of devices) {
        if (destinations.length >= MAX_DESTINATIONS) break
        if (device.isAvailable === false) continue
        destinations.push({
          id: `platform=iOS Simulator,id=${device.udid}`,
          name: device.name,
          platform: 'iOS Simulator',
          supported: true,
          ...(device.state === 'Booted' ? { booted: true } : {}),
        })
      }
    }
    return {
      toolchain: {
        developerDir,
        version:
          versionResult.exitCode === 0
            ? versionResult.output.trim().slice(0, 512) || 'Unknown Xcode version'
            : 'Unknown Xcode version',
      },
      candidates,
      destinations,
      metadataRequiresExecution: false,
      setupMessage:
        candidates.length === 0
          ? 'No Xcode workspace or project was found within the project directory.'
          : versionResult.exitCode === 0
            ? null
            : 'Copse could not inspect the selected Xcode installation.',
    }
  }

  async destinations(
    root: string,
    candidate: AppleCandidate,
    scheme: string,
    available: readonly AppleDestination[],
    developerDir: string,
    signal: AbortSignal,
  ): Promise<AppleDestination[]> {
    const candidatePath = await realpath(resolve(root, candidate.id))
    if (!withinRoot(root, candidatePath)) {
      throw new Error('Selected Xcode project escapes the execution root.')
    }
    const xcodebuild = await installedDeveloperTool(developerDir, 'xcodebuild')
    const [flag, value] = candidateArg(candidate)
    const result = await runProcess(
      xcodebuild,
      [flag, value, '-scheme', scheme, '-showdestinations'],
      root,
      signal,
      { DEVELOPER_DIR: developerDir },
    )
    if (result.exitCode !== 0) {
      throw new Error(
        xcodeFailureDetail(result.output) ?? 'Xcode could not load destinations for this scheme.',
      )
    }
    const compatible = parseCompatibleDestinations(result.output, available)
    if (compatible.length === 0) {
      throw new Error('Xcode reported no supported destinations for this scheme.')
    }
    return compatible
  }

  async execute(
    plan: AppleDriverPlan,
    developerDir: string,
    signal: AbortSignal,
  ): Promise<AppleDriverResult> {
    const candidatePath = resolve(plan.root, plan.target.candidateId)
    const canonical = await realpath(candidatePath)
    if (!withinRoot(plan.root, canonical))
      throw new Error('Selected Xcode project escapes the execution root.')
    const kind = extname(candidatePath) === '.xcworkspace' ? 'workspace' : 'project'
    const missingLocalPackages = await discoverMissingLocalPackages(
      plan.root,
      plan.target.candidateId,
    )
    if (missingLocalPackages.length > 0) {
      const paths = missingLocalPackages.join(', ')
      const failureReason = `Missing local Swift package${missingLocalPackages.length === 1 ? '' : 's'}: ${paths}. Restore the referenced package directories before building.`
      return {
        exitCode: 1,
        failureReason,
        logs: failureReason,
        outputTruncated: false,
        diagnostics: [],
        testSummary: null,
      }
    }
    const [candidateFlag, candidateValue] = candidateArg({
      id: plan.target.candidateId,
      name: basename(plan.target.candidateId),
      kind,
      schemes: [],
    })
    const paths = await prepareAppleOperationPaths(plan.root, plan.operationId)
    const xcodebuild = await installedDeveloperTool(developerDir, 'xcodebuild')
    const resultBundlePath = resolve(
      paths.outputRoot,
      plan.action === 'test' ? 'TestResults.xcresult' : 'BuildResults.xcresult',
    )
    const commonArgs = [
      candidateFlag,
      candidateValue,
      '-scheme',
      plan.target.schemeId,
      '-configuration',
      plan.target.configuration,
      '-destination',
      plan.target.destinationId,
      ...appleBuildActionArguments(paths),
    ]
    const env = { DEVELOPER_DIR: developerDir }
    const args = [...commonArgs, '-resultBundlePath', resultBundlePath]
    if (plan.action === 'test') {
      if (plan.testFilter) args.push(`-only-testing:${plan.testFilter}`)
      args.push('test')
    } else {
      args.push('build')
    }
    const result = await runProcess(xcodebuild, args, plan.root, signal, env)
    const buildOutput = boundedOutput([result])
    if (plan.action !== 'run' || result.exitCode !== 0) {
      return {
        exitCode: result.exitCode,
        ...(result.exitCode === 0 ? {} : optionalFailureReason(result)),
        logs: buildOutput.logs,
        outputTruncated: buildOutput.outputTruncated,
        diagnostics: parseDiagnostics(buildOutput.logs, plan.root),
        testSummary: plan.action === 'test' ? parseTestSummary(buildOutput.logs) : null,
        resultBundlePath,
      }
    }

    const settings = await runProcess(
      xcodebuild,
      [
        candidateFlag,
        candidateValue,
        '-scheme',
        plan.target.schemeId,
        '-configuration',
        plan.target.configuration,
        '-destination',
        plan.target.destinationId,
        ...appleBuildPathArguments(paths),
        '-showBuildSettings',
        '-json',
      ],
      plan.root,
      signal,
      env,
    )
    const parsedSettings = safeJsonParse(
      settings.stdout,
      decodeWithSchema(buildSettingsOutputSchema),
    )
    const application = parsedSettings?.find(
      (entry) => entry.buildSettings['WRAPPER_EXTENSION'] === 'app',
    )
    const targetBuildDir = application?.buildSettings['TARGET_BUILD_DIR']
    const productName = application?.buildSettings['FULL_PRODUCT_NAME']
    const executablePath = application?.buildSettings['EXECUTABLE_PATH']
    const bundleId = application?.buildSettings['PRODUCT_BUNDLE_IDENTIFIER']
    if (
      settings.exitCode !== 0 ||
      !targetBuildDir ||
      !productName ||
      !executablePath ||
      !bundleId
    ) {
      const output = boundedOutput([result, settings])
      return {
        exitCode: settings.exitCode === 0 ? 1 : settings.exitCode,
        failureReason:
          xcodeFailureDetail(settings.output) ??
          'The built app path or bundle identifier was unavailable.',
        logs: `${output.logs}\nThe built app path or bundle identifier was unavailable.`,
        outputTruncated: output.outputTruncated,
        diagnostics: parseDiagnostics(output.logs, plan.root),
        testSummary: null,
      }
    }
    const appPath = await realpath(resolve(targetBuildDir, productName))
    const canonicalOutputRoot = await realpath(paths.outputRoot)
    if (!withinRoot(canonicalOutputRoot, appPath)) {
      throw new Error('The built app resolved outside this operation output directory.')
    }

    if (plan.target.destinationId === 'platform=macOS') {
      const executable = await realpath(resolve(targetBuildDir, executablePath))
      if (!withinRoot(appPath, executable)) {
        throw new Error('The built executable resolved outside the selected app bundle.')
      }
      const child = await spawnInProjectSandbox(executable, [], {
        cwd: dirname(appPath),
        env,
        stdio: 'pipe',
        unsandboxed: true,
      })
      if (child.pid === undefined) {
        await new Promise<void>((resolveLaunch, rejectLaunch) => {
          child.once('spawn', resolveLaunch)
          child.once('error', rejectLaunch)
        })
      }
      const appSession = { id: randomUUID() }
      this.appSessions.set(appSession.id, { kind: 'macos', child })
      child.stdout?.resume()
      child.stderr?.resume()
      child.once('exit', () => this.appSessions.delete(appSession.id))
      child.once('error', () => this.appSessions.delete(appSession.id))
      child.unref()
      const output = boundedOutput([result, settings])
      return {
        exitCode: 0,
        logs: output.logs,
        outputTruncated: output.outputTruncated,
        diagnostics: parseDiagnostics(output.logs, plan.root),
        testSummary: null,
        appSession,
      }
    }

    const simulatorId = /(?:^|,)id=([^,]+)/.exec(plan.target.destinationId)?.[1]
    if (!plan.target.destinationId.startsWith('platform=iOS Simulator') || !simulatorId) {
      const failureReason = 'Run requires a macOS or explicitly selected iOS Simulator destination.'
      const output = boundedOutput([result, settings])
      return {
        exitCode: 1,
        failureReason,
        logs: `${output.logs}\n${failureReason}`,
        outputTruncated: output.outputTruncated,
        diagnostics: parseDiagnostics(output.logs, plan.root),
        testSummary: null,
      }
    }

    const simctl = await installedDeveloperTool(developerDir, 'simctl')
    const boot = await runProcess(simctl, ['bootstatus', simulatorId, '-b'], plan.root, signal, env)
    const install =
      boot.exitCode === 0
        ? await runProcess(simctl, ['install', simulatorId, appPath], plan.root, signal, env)
        : null
    const launch =
      install?.exitCode === 0
        ? await runProcess(simctl, ['launch', simulatorId, bundleId], plan.root, signal, env)
        : null
    const stages = [
      result,
      settings,
      boot,
      ...(install ? [install] : []),
      ...(launch ? [launch] : []),
    ]
    const output = boundedOutput(stages)
    const finalStage = launch ?? install ?? boot
    if (finalStage.exitCode !== 0 || !launch) {
      return {
        exitCode: finalStage.exitCode === 0 ? 1 : finalStage.exitCode,
        ...(finalStage.exitCode === 0
          ? { failureReason: 'The Simulator app did not launch.' }
          : optionalFailureReason(finalStage)),
        logs: output.logs,
        outputTruncated: output.outputTruncated,
        diagnostics: parseDiagnostics(output.logs, plan.root),
        testSummary: null,
      }
    }
    const appSession = { id: randomUUID() }
    this.appSessions.set(appSession.id, {
      kind: 'simulator',
      simulatorId,
      bundleId,
      developerDir,
    })
    return {
      exitCode: 0,
      logs: output.logs,
      outputTruncated: output.outputTruncated,
      diagnostics: parseDiagnostics(output.logs, plan.root),
      testSummary: null,
      appSession,
    }
  }

  async stopAppSession(sessionId: string, root: string, signal: AbortSignal): Promise<boolean> {
    const session = this.appSessions.get(sessionId)
    if (!session) return false
    if (session.kind === 'macos') {
      this.appSessions.delete(sessionId)
      if (session.child.exitCode !== null || session.child.signalCode !== null) return false
      const cancelKill = terminateProcessTree(session.child)
      session.child.once('close', cancelKill)
      return true
    }
    const simctl = await installedDeveloperTool(session.developerDir, 'simctl')
    const result = await runProcess(
      simctl,
      ['terminate', session.simulatorId, session.bundleId],
      root,
      signal,
      { DEVELOPER_DIR: session.developerDir },
    )
    if (result.exitCode === 0) this.appSessions.delete(sessionId)
    return result.exitCode === 0
  }
}
