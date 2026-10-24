/** Read-only Git evidence collection and local, resumable visual review notes. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'
import { isDirectExecution } from './lib/direct-execution.mts'
import {
  parseScreenshotManifest,
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
  screenshotHash,
  screenshotObjectKey,
  verifyScreenshot,
  type ScreenshotEntry,
} from './lib/screenshot-manifest.mts'
import {
  classification,
  evidenceSchema,
  makeReviewPacket,
  parseReviewLedger,
  parseReviewPacket,
  recordReview,
  reviewProgress,
  type ReviewEvidence,
  type ReviewImage,
  type ReviewItem,
  type ReviewLedger,
  type ReviewPacket,
} from './lib/screenshot-review-records.mts'

import { updateScreenshotReadme } from './lib/screenshot-review-manifest.mts'

const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/
const DEFAULT_R2 = 'https://pub-7ec931b58a7b480ba1cd3e535dc12f3c.r2.dev'
type Source = { entry: ScreenshotEntry; ref: string; legacy: boolean }

const pullSchema = z.object({
  state: z.literal('open'),
  head: z.object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    repo: z.object({ full_name: z.string() }),
  }),
  base: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
})
const runSchema = z.object({
  head_sha: z.string(),
  conclusion: z.enum(['success', 'failure', 'timed_out']),
  path: z.literal('.github/workflows/ci.yml'),
  html_url: z.string(),
})
const jobsSchema = z.object({
  jobs: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })),
})

/**
 * Whether a run's candidate job passed. The publisher also publishes a red run
 * whose `screenshot-artifacts` job passed: it needs only build and e2e, so the
 * screenshots rendered even if lint or a unit test failed.
 */
function renderedScreenshots(jobs: string): boolean {
  return (
    safeJsonParse(jobs, decodeWithSchema(jobsSchema))?.jobs.some(
      (job) => job.name === 'screenshot-artifacts' && job.conclusion === 'success',
    ) ?? false
  )
}

/** Lookup is read-only. The reviewer must still bind the publication to this CI run. */
export function discoverReview(
  cwd: string,
  repository: string,
  pr: number,
  run: string,
): { base: string; head: string; compare: string } {
  evidenceSchema.shape.repository.parse(repository)
  evidenceSchema.shape.pr.parse(pr)
  evidenceSchema.shape.run.parse(run)
  function api(path: string): string {
    return execFileSync('gh', ['api', `repos/${repository}/${path}`], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  const pull = safeJsonParse(api(`pulls/${String(pr)}`), decodeWithSchema(pullSchema))
  const workflow = safeJsonParse(api(`actions/runs/${run}`), decodeWithSchema(runSchema))
  const rendered =
    workflow?.conclusion === 'success' ||
    (workflow !== null &&
      renderedScreenshots(api(`actions/runs/${run}/jobs?filter=latest&per_page=100`)))
  if (
    !pull ||
    pull.head.repo.full_name !== repository ||
    !workflow ||
    workflow.head_sha !== pull.head.sha ||
    !rendered
  )
    throw new Error(
      'Need an open same-repository PR and a current-head CI run that rendered its screenshots; use verified pinned evidence for other publication types',
    )
  const branch = `screenshot-compare/pr-${String(pr)}/${pull.head.sha.slice(0, 12)}`
  git(cwd, [
    'fetch',
    '--no-tags',
    `https://github.com/${repository}.git`,
    branch,
    pull.base.sha,
    pull.head.sha,
  ])
  const compare = git(cwd, ['rev-parse', 'FETCH_HEAD']).toString().trim()
  return { base: pull.base.sha, head: pull.head.sha, compare }
}

function git(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function snapshot(cwd: string, ref: string): Map<string, Source> {
  const files = git(cwd, ['ls-tree', '-r', '--name-only', ref, '--', SCREENSHOT_DIRECTORY])
    .toString()
    .trim()
    .split('\n')
  const pngs = files.filter((path) => path.endsWith('.png'))
  const result = new Map<string, Source>()
  // Before the R2 cutover, tracked PNGs are authoritative even if a staging manifest exists.
  if (pngs.length) {
    for (const path of pngs) {
      const name = path.slice(SCREENSHOT_DIRECTORY.length + 1)
      if (!IMAGE_NAME.test(name)) throw new Error(`Invalid screenshot path: ${path}`)
      const bytes = git(cwd, ['show', `${ref}:${path}`])
      result.set(name, {
        entry: { sha256: screenshotHash(bytes), bytes: bytes.length },
        ref,
        legacy: true,
      })
    }
  } else if (files.includes(SCREENSHOT_MANIFEST)) {
    const manifest = parseScreenshotManifest(
      git(cwd, ['show', `${ref}:${SCREENSHOT_MANIFEST}`]).toString(),
    )
    for (const [name, entry] of Object.entries(manifest.screenshots))
      result.set(name, { entry, ref, legacy: false })
  } else throw new Error(`No screenshot references at ${ref}; cannot establish complete evidence`)
  return result
}

export function screenshotDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new Error('Invalid PNG header')
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20)
  if (!width || !height || width > 32768 || height > 32768)
    throw new Error('Invalid PNG dimensions')
  return { width, height }
}

async function download(entry: ScreenshotEntry): Promise<Buffer> {
  const url = new URL(
    `${(process.env['SCREENSHOT_R2_PUBLIC_URL'] ?? DEFAULT_R2).replace(/\/$/, '')}/${screenshotObjectKey(entry)}`,
  )
  if (url.protocol !== 'https:') throw new Error('Screenshot reads require HTTPS')
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' })
  if (!response.ok || !response.body)
    throw new Error(`Screenshot download failed (${String(response.status)}): ${entry.sha256}`)
  const chunks: Uint8Array[] = []
  let count = 0
  for await (const chunk of response.body) {
    count += chunk.length
    if (count > entry.bytes || count > MAX_IMAGE_BYTES)
      throw new Error(`Oversized screenshot: ${entry.sha256}`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function safeDirectory(path: string): void {
  const parent = dirname(path)
  if (parent !== path) safeDirectory(parent)
  if (existsSync(path)) {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
      throw new Error(`Unsafe review directory: ${path}`)
  } else mkdirSync(path)
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function writeJson(path: string, value: unknown): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function loadReviewLedger(directory: string): ReviewLedger {
  const path = join(directory, 'receipts.json')
  return existsSync(path)
    ? parseReviewLedger(readFileSync(path, 'utf8'))
    : { version: 1, receipts: [] }
}

export async function collectReview(
  cwd: string,
  evidence: ReviewEvidence,
  directory: string,
  readObject = download,
): Promise<ReviewPacket> {
  evidence = evidenceSchema.parse(evidence)
  directory = resolve(directory)
  const baselineDirectory = resolve(cwd, SCREENSHOT_DIRECTORY)
  if (directory === baselineDirectory || directory.startsWith(`${baselineDirectory}${sep}`))
    throw new Error('Keep review packets outside baseline paths')
  for (const ref of [evidence.base, evidence.head, evidence.compare]) {
    if (
      git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
        .toString()
        .trim() !== ref
    )
      throw new Error('Evidence must name full commit SHAs')
  }
  const parents = git(cwd, ['show', '-s', '--format=%P', evidence.compare]).toString().trim()
  if (parents !== evidence.head)
    throw new Error('Compare commit must have exactly one parent: the reviewed head')
  const changes = git(cwd, [
    'diff',
    '--no-renames',
    '--name-status',
    evidence.head,
    evidence.compare,
  ])
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
  if (
    !changes.length ||
    changes.some((line) => {
      const [status, path] = line.split('\t')
      return (
        !path ||
        !['A', 'M'].includes(status ?? '') ||
        (path !== SCREENSHOT_MANIFEST &&
          !(path === 'README.md' && status === 'M') &&
          !(
            path.startsWith(`${SCREENSHOT_DIRECTORY}/`) &&
            IMAGE_NAME.test(path.slice(SCREENSHOT_DIRECTORY.length + 1))
          ))
      )
    })
  )
    throw new Error('Compare commit must only add or modify screenshot evidence')
  if (changes.includes('M\tREADME.md')) {
    for (const ref of [evidence.head, evidence.compare]) {
      if (!git(cwd, ['ls-tree', ref, '--', 'README.md']).toString().startsWith('100644 blob '))
        throw new Error('Compare README must be a regular file')
    }
    const before = parseScreenshotManifest(
      git(cwd, ['show', `${evidence.head}:${SCREENSHOT_MANIFEST}`]).toString(),
    )
    const after = parseScreenshotManifest(
      git(cwd, ['show', `${evidence.compare}:${SCREENSHOT_MANIFEST}`]).toString(),
    )
    const beforeText = git(cwd, ['show', `${evidence.head}:README.md`]).toString()
    const afterText = git(cwd, ['show', `${evidence.compare}:README.md`]).toString()
    if (afterText !== updateScreenshotReadme(beforeText, before, after))
      throw new Error('Compare README changes are not the accepted screenshot hash updates')
  }
  const base = snapshot(cwd, evidence.base),
    head = snapshot(cwd, evidence.head),
    compare = snapshot(cwd, evidence.compare)
  for (const name of head.keys())
    if (!compare.has(name)) throw new Error('Candidate evidence cannot remove references')
  safeDirectory(directory)
  loadReviewLedger(directory) // Fail before replacing any packet if progress is corrupt.
  safeDirectory(join(directory, 'images'))
  const cache = new Map<string, ReviewImage>()
  const legacy = new Map<string, { name: string; source: Source }>()
  for (const entries of [base, head, compare])
    for (const [name, source] of entries)
      if (source.legacy) legacy.set(source.entry.sha256, { name, source })
  async function materialize(
    name: string,
    source: Source | undefined,
  ): Promise<ReviewImage | null> {
    if (!source) return null
    const { entry } = source
    if (entry.bytes > MAX_IMAGE_BYTES) throw new Error(`Oversized screenshot: ${name}`)
    const previous = cache.get(entry.sha256)
    if (previous) {
      if (previous.bytes !== entry.bytes) throw new Error('Conflicting lengths for screenshot hash')
      return previous
    }
    const path = join(directory, 'images', `${entry.sha256}.png`)
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
      throw new Error('Unsafe cached image')
    const old = legacy.get(entry.sha256)
    const bytes = existsSync(path)
      ? readFileSync(path)
      : old
        ? git(cwd, ['show', `${old.source.ref}:${SCREENSHOT_DIRECTORY}/${old.name}`])
        : await readObject(entry)
    verifyScreenshot(bytes, entry)
    const dimensions = screenshotDimensions(bytes)
    if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' })
    const image = { ...entry, ...dimensions }
    cache.set(entry.sha256, image)
    return image
  }
  const items: Omit<ReviewItem, 'key'>[] = []
  for (const [kind, before, after] of [
    ['committed', base, head],
    ['candidate', head, compare],
  ] as const) {
    for (const name of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const a = before.get(name),
        b = after.get(name)
      if (a?.entry.sha256 === b?.entry.sha256 && a?.entry.bytes === b?.entry.bytes) continue
      items.push({
        id: `${kind}/${name}`,
        kind,
        name,
        before: await materialize(name, a),
        after: await materialize(name, b),
      })
    }
  }
  const packet = makeReviewPacket(evidence, items)
  // Immutable packets preserve provenance across heads; current.json is only a convenience pointer.
  const archived = join(directory, `${packet.fingerprint}.json`)
  if (!existsSync(archived)) writeJson(archived, packet)
  writeJson(join(directory, 'current.json'), packet)
  writeReviewReport(directory, packet, loadReviewLedger(directory))
  return packet
}

function markdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ')
}

export function writeReviewReport(
  directory: string,
  packet: ReviewPacket,
  ledger: ReviewLedger,
): void {
  const progress = reviewProgress(packet, ledger)
  function link(image: ReviewImage | null): string {
    return image
      ? `[${String(image.width)}×${String(image.height)}](images/${image.sha256}.png)`
      : 'Absent'
  }
  const lines = [
    '# Screenshot review working notes',
    '',
    '**Not approval.** Verify live PR, trusted CI provenance, capture environment and coverage before acceptance. Open linked images at full resolution.',
    '',
    `Repository: ${packet.evidence.repository}; PR: ${String(packet.evidence.pr)}; mode: ${packet.evidence.mode}.`,
    `Base: ${packet.evidence.base}; head: ${packet.evidence.head}; compare: ${packet.evidence.compare}.`,
    `CI run supplied by reviewer: https://github.com/${packet.evidence.repository}/actions/runs/${packet.evidence.run}`,
    '',
    `Context: ${markdown(packet.evidence.context)}`,
    '',
    `Recorded: ${String(progress.filter((entry) => entry.state === 'recorded').length)}/${String(progress.length)}. Revalidate: ${String(progress.filter((entry) => entry.state === 'revalidate').length)}. Unreviewed: ${String(progress.filter((entry) => entry.state === 'unreviewed').length)}.`,
    '',
    '| Item | Before | After | Progress | Classification | Note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...progress.map(
      (entry) =>
        `| ${markdown(entry.id)} | ${link(entry.before)} | ${link(entry.after)} | ${entry.state} | ${entry.receipt?.classification ?? ''} | ${markdown(entry.receipt?.note ?? '')} |`,
    ),
    '',
    'Recorded breakage, instability and unresolved findings still block acceptance. A zero-item packet does not prove no candidates or full stack coverage.',
    '',
  ]
  const report = join(directory, 'review.md')
  if (existsSync(report) && lstatSync(report).isSymbolicLink())
    throw new Error('Unsafe report path')
  writeAtomic(report, lines.join('\n'))
}

export async function screenshotReview(args: string[], cwd = process.cwd()): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: Object.fromEntries(
      [
        'repo',
        'pr',
        'base',
        'head',
        'compare',
        'run',
        'context',
        'mode',
        'item',
        'classification',
        'note',
      ].map((name) => [name, { type: 'string' }]),
    ),
  })
  const pr = Number(values['pr'])
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('Supply --pr <positive PR number>')
  const directory = resolve(cwd, '.tmp', 'screenshot-review', String(pr))
  const command = positionals[0]
  if (positionals.length !== 1) throw new Error('Use collect, record, or status')
  if (command === 'collect') {
    const pinned = [values['base'], values['head'], values['compare']]
    if (pinned.some(Boolean) && !pinned.every(Boolean))
      throw new Error(
        'Supply all three of --base, --head, --compare or omit all three for GitHub discovery',
      )
    const refs = pinned.every(Boolean)
      ? { base: values['base'], head: values['head'], compare: values['compare'] }
      : discoverReview(cwd, values['repo'] ?? '', pr, values['run'] ?? '')
    const evidence = evidenceSchema.parse({
      repository: values['repo'],
      pr,
      ...refs,
      run: values['run'],
      context: values['context'],
      mode: values['mode'] ?? 'pr',
    })
    await collectReview(cwd, evidence, directory)
  } else if (command === 'record' || command === 'status') {
    safeDirectory(directory)
    const packet = parseReviewPacket(readFileSync(join(directory, 'current.json'), 'utf8'))
    const ledger = loadReviewLedger(directory)
    if (command === 'record') {
      const updated = recordReview(
        packet,
        ledger,
        values['item'] ?? '',
        classification.parse(values['classification']),
        values['note'] ?? '',
      )
      writeJson(join(directory, 'receipts.json'), updated)
      writeReviewReport(directory, packet, updated)
    } else writeReviewReport(directory, packet, ledger)
  } else throw new Error('Use collect, record, or status')
  console.log(join(directory, 'review.md'))
}

if (isDirectExecution(import.meta.url, 'screenshot-review')) {
  screenshotReview(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
