#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { t as listTar, x as extractTar } from 'tar'

import {
  DEFAULT_TERMINAL_BENCH_DEBUG_OUTPUT,
  DEFAULT_TERMINAL_BENCH_MAX_EXTRACT_BYTES,
  DEFAULT_TERMINAL_BENCH_MAX_EXTRACT_ENTRIES,
  parseTerminalBenchRunManifest,
  parseTerminalBenchShardIndex,
  repositoryFromGitRemote,
  selectTerminalBenchCapsule,
  TERMINAL_BENCH_RUN_MANIFEST,
  terminalBenchArchiveEntryPath,
  terminalBenchArchiveEntryTypeAllowed,
  terminalBenchRunPrefix,
  verifyTerminalBenchCapsule,
  type TerminalBenchCapsuleRecord,
  type TerminalBenchRunManifest,
} from './lib/terminal-bench-debug.mts'
import {
  hasFlag,
  option,
  optionWithDefault,
  parseOptions,
  positiveInt,
  type Options,
} from './lib/cloud-hosts.mts'

type Command = 'list' | 'fetch' | 'thread' | 'help'

interface DebugConfig {
  bucket: string
  endpoint: string
  objectPrefix: string
  outputRoot: string
  readerEnv: NodeJS.ProcessEnv
}

function usage(): string {
  return `Usage:
  npm run bench:terminal:debug -- list --run <github-run-id> [options]
  npm run bench:terminal:debug -- fetch --run <github-run-id> (--task <name> | --trial-id <id>) [options]
  npm run bench:terminal:debug -- thread --run <github-run-id> (--task <name> | --trial-id <id>) [options]

Options:
  --attempt <n>       GitHub workflow run attempt (default: 1)
  --repository <o/r>  GitHub repository (default: GITHUB_REPOSITORY or origin)
  --bucket <name>     Scaleway Object Storage bucket (default: SCW_OBJECT_STORAGE_BUCKET)
  --region <region>   Scaleway Object Storage region (default: SCW_OBJECT_STORAGE_REGION or fr-par)
  --endpoint <url>    S3 endpoint override
  --output <path>     Safe extraction root (default: ${DEFAULT_TERMINAL_BENCH_DEBUG_OUTPUT})
  --json              Machine-readable output for list

Reader credentials:
  SCW_OBJECT_STORAGE_READER_ACCESS_KEY_ID
  SCW_OBJECT_STORAGE_READER_SECRET_KEY
`
}

function command(value: string | undefined): Command {
  if (value === undefined || value === 'help' || value === '--help') return 'help'
  if (value === 'list' || value === 'fetch' || value === 'thread') return value
  throw new Error(`unknown command '${value}'`)
}

function requiredValue(value: string | undefined, message: string): string {
  if (!value) throw new Error(message)
  return value
}

function repository(options: Options): string {
  const explicit = option(options, 'repository') ?? process.env['GITHUB_REPOSITORY']?.trim()
  if (explicit) return explicit
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = repositoryFromGitRemote(remote)
    if (parsed) return parsed
  } catch {
    // The CLI can also run outside a checkout when --repository is explicit.
  }
  throw new Error('pass --repository or set GITHUB_REPOSITORY')
}

function readerEnvironment(): NodeJS.ProcessEnv {
  const accessKey = process.env['SCW_OBJECT_STORAGE_READER_ACCESS_KEY_ID']?.trim()
  const secretKey = process.env['SCW_OBJECT_STORAGE_READER_SECRET_KEY']?.trim()
  if (!accessKey || !secretKey) {
    throw new Error(
      'set SCW_OBJECT_STORAGE_READER_ACCESS_KEY_ID and SCW_OBJECT_STORAGE_READER_SECRET_KEY; worker write credentials are intentionally not used',
    )
  }
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: accessKey,
    AWS_SECRET_ACCESS_KEY: secretKey,
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  }
}

function config(options: Options): DebugConfig {
  const runId = requiredValue(option(options, 'run'), 'missing required --run')
  const attempt = positiveInt(optionWithDefault(options, 'attempt', '1'), 'attempt')
  const region = optionWithDefault(
    options,
    'region',
    process.env['SCW_OBJECT_STORAGE_REGION']?.trim() || 'fr-par',
  )
  return {
    bucket: requiredValue(
      option(options, 'bucket') ?? process.env['SCW_OBJECT_STORAGE_BUCKET']?.trim(),
      'pass --bucket or set SCW_OBJECT_STORAGE_BUCKET',
    ),
    endpoint: optionWithDefault(options, 'endpoint', `https://s3.${region}.scw.cloud`),
    objectPrefix: terminalBenchRunPrefix(repository(options), runId, attempt),
    outputRoot: resolve(optionWithDefault(options, 'output', DEFAULT_TERMINAL_BENCH_DEBUG_OUTPUT)),
    readerEnv: readerEnvironment(),
  }
}

function requireAws(configured: DebugConfig): void {
  const probe = spawnSync('aws', ['--version'], {
    encoding: 'utf8',
    env: configured.readerEnv,
  })
  if (probe.error || probe.status !== 0) {
    throw new Error('AWS CLI is required for Terminal-Bench Object Storage retrieval')
  }
}

function downloadObject(
  configured: DebugConfig,
  key: string,
  destination: string,
  optional = false,
): boolean {
  const result = spawnSync(
    'aws',
    [
      's3',
      'cp',
      `s3://${configured.bucket}/${key}`,
      destination,
      '--only-show-errors',
      '--endpoint-url',
      configured.endpoint,
    ],
    { encoding: 'utf8', env: configured.readerEnv },
  )
  if (!result.error && result.status === 0) return true
  if (optional) return false
  const detail =
    result.stderr.trim() || result.error?.message || `aws exited ${String(result.status)}`
  throw new Error(`unable to retrieve s3://${configured.bucket}/${key}: ${detail}`)
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function loadRun(
  configured: DebugConfig,
): Promise<{ manifest: TerminalBenchRunManifest; capsules: TerminalBenchCapsuleRecord[] }> {
  requireAws(configured)
  const scratch = await mkdtemp(join(tmpdir(), 'copse-terminal-debug-'))
  try {
    const manifestPath = join(scratch, TERMINAL_BENCH_RUN_MANIFEST)
    downloadObject(
      configured,
      `${configured.objectPrefix}/${TERMINAL_BENCH_RUN_MANIFEST}`,
      manifestPath,
    )
    const manifest = parseTerminalBenchRunManifest(await readJson(manifestPath))
    if (manifest.objectPrefix !== configured.objectPrefix) {
      throw new Error('retrieved run manifest does not match the requested run')
    }
    const capsules: TerminalBenchCapsuleRecord[] = []
    for (let shardIndex = 0; shardIndex < manifest.shardCount; shardIndex += 1) {
      const indexPath = join(scratch, `shard-${String(shardIndex)}-index.json`)
      const key = `${manifest.objectPrefix}/shard-${String(shardIndex)}/index.json`
      if (!downloadObject(configured, key, indexPath, true)) {
        console.warn(`bench:terminal:debug: shard ${String(shardIndex)} has no readable index`)
        continue
      }
      capsules.push(...parseTerminalBenchShardIndex(await readJson(indexPath), shardIndex))
    }
    return { manifest, capsules }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function selection(options: Options): { taskName?: string; trialId?: string } {
  const taskName = option(options, 'task')
  const trialId = option(options, 'trial-id')
  return {
    ...(taskName !== undefined ? { taskName } : {}),
    ...(trialId !== undefined ? { trialId } : {}),
  }
}

async function validateArchive(path: string): Promise<void> {
  let bytes = 0
  let entries = 0
  await listTar({
    file: path,
    gzip: true,
    strict: true,
    onentry: (entry) => {
      entries += 1
      bytes += entry.size
      if (entries > DEFAULT_TERMINAL_BENCH_MAX_EXTRACT_ENTRIES) {
        throw new Error('capsule contains too many archive entries')
      }
      if (bytes > DEFAULT_TERMINAL_BENCH_MAX_EXTRACT_BYTES) {
        throw new Error('capsule expands beyond the 1 GiB safety limit')
      }
      if (!archiveEntryAllowed(entry.path, entry.type)) {
        throw new Error(`capsule contains unsafe archive entry '${entry.path}' (${entry.type})`)
      }
    },
  })
}

function archiveEntryAllowed(path: string, type: string): boolean {
  const rootDirectory = (path === '.' || path === './') && type === 'Directory'
  return (
    rootDirectory ||
    (terminalBenchArchiveEntryPath(path) !== undefined &&
      terminalBenchArchiveEntryTypeAllowed(type))
  )
}

async function existingExtraction(
  destination: string,
  capsule: TerminalBenchCapsuleRecord,
): Promise<boolean> {
  try {
    const marker = await readJson(join(destination, '.capsule.json'))
    return (
      typeof marker === 'object' &&
      marker !== null &&
      Reflect.get(marker, 'trialId') === capsule.trialId &&
      Reflect.get(marker, 'sha256') === capsule.sha256
    )
  } catch {
    return false
  }
}

async function extractCapsule(
  configured: DebugConfig,
  manifest: TerminalBenchRunManifest,
  capsule: TerminalBenchCapsuleRecord,
): Promise<string> {
  await mkdir(configured.outputRoot, { recursive: true })
  const destination = join(configured.outputRoot, capsule.trialId)
  try {
    await stat(destination)
    if (await existingExtraction(destination, capsule)) return destination
    throw new Error(
      `refusing to replace existing extraction '${destination}'; choose a different --output`,
    )
  } catch (error) {
    if (error instanceof Error && !('code' in error)) throw error
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') !== 'ENOENT') {
      throw error
    }
  }

  const scratch = await mkdtemp(join(configured.outputRoot, '.download-'))
  const archivePath = join(scratch, capsule.archive)
  const extraction = join(scratch, 'trial')
  try {
    downloadObject(
      configured,
      `${manifest.objectPrefix}/shard-${String(capsule.shardIndex)}/${capsule.archive}`,
      archivePath,
    )
    await verifyTerminalBenchCapsule(archivePath, capsule.bytes, capsule.sha256)
    await validateArchive(archivePath)
    await mkdir(extraction)
    await extractTar({
      cwd: extraction,
      file: archivePath,
      gzip: true,
      preservePaths: false,
      strict: true,
      filter: (path, entry) => archiveEntryAllowed(path, 'type' in entry ? entry.type : 'unknown'),
    })
    await writeFile(
      join(extraction, '.capsule.json'),
      `${JSON.stringify({ schemaVersion: 1, trialId: capsule.trialId, sha256: capsule.sha256 })}\n`,
    )
    await rename(extraction, destination)
    return destination
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function printCapsules(capsules: readonly TerminalBenchCapsuleRecord[], json: boolean): void {
  const sorted = [...capsules].sort(
    (a, b) =>
      a.taskName.localeCompare(b.taskName) || (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
  )
  if (json) {
    console.log(JSON.stringify(sorted, null, 2))
    return
  }
  if (sorted.length === 0) {
    console.log('No completed Terminal-Bench capsules were found.')
    return
  }
  for (const capsule of sorted) {
    console.log(
      `${(capsule.outcome ?? 'unknown').toUpperCase().padEnd(7)} ${capsule.taskName.padEnd(42)} ` +
        `shard=${String(capsule.shardIndex).padStart(2)} trial=${capsule.trialId}`,
    )
  }
}

async function main(): Promise<void> {
  const selectedCommand = command(process.argv[2])
  if (selectedCommand === 'help') {
    console.log(usage())
    return
  }
  const options = parseOptions(process.argv, 3)
  const configured = config(options)
  const run = await loadRun(configured)
  if (selectedCommand === 'list') {
    printCapsules(run.capsules, hasFlag(options, 'json'))
    return
  }
  const capsule = selectTerminalBenchCapsule(run.capsules, selection(options))
  const extracted = await extractCapsule(configured, run.manifest, capsule)
  if (selectedCommand === 'fetch') {
    console.log(extracted)
    return
  }
  const threadPath = join(extracted, 'agent', 'thread', 'thread.jsonl')
  try {
    process.stdout.write(await readFile(threadPath, 'utf8'))
  } catch {
    throw new Error(`capsule does not contain ${threadPath.slice(extracted.length + 1)}`)
  }
}

if (process.argv[1]?.endsWith('debug-terminal-bench.mts')) {
  void main().catch((error: unknown) => {
    console.error(`bench:terminal:debug: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
