/**
 * Rendering-input identity for reference screenshots — SHADOW MODE.
 *
 * Every CI e2e shard already re-renders the reference PNGs its specs own. This
 * module names what went into one of those renders: the spec and everything it
 * imports, the fixtures it reads, the renderer source the test oracle maps to
 * it, the bundled assets and fonts, the dependency lockfile, the capture and
 * viewport helpers, and the runtime (Electron, Chromium, runner image, system
 * fonts). The identity is a sha256 over those inputs' own hashes, so two runs
 * share an identity exactly when nothing in that list differs.
 *
 * Nothing consumes the identity yet. Records are published as a CI artifact so
 * the rate at which identical identities produce identical PNG bytes can be
 * measured across runs and runners before any reuse proposal is written; see
 * docs/plans/screenshot-evidence-reuse.md. No gate, status, label or
 * acceptance path reads these records, and a record is never an approval.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  BROAD_PATTERNS,
  extractSpecScreenshots,
  extractSpecTokens,
  listSourceFiles,
  reachableFiles,
  SELECTOR_STOPLIST,
  tokenMatcher,
  type OracleFiles,
} from '../test-oracle.mts'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'
import { SCREENSHOT_NAME } from './screenshot-manifest.mts'

/** The read-only source view the oracle uses, plus a file/directory probe. */
export type IdentityTree = OracleFiles & { isFile: (path: string) => boolean }

export const INPUT_CLASSES = [
  'spec',
  'fixtures',
  'renderer',
  'assets',
  'dependencies',
  'capture',
] as const
export type InputClass = (typeof INPUT_CLASSES)[number]
export type RenderingInputs = Record<InputClass, string[]>

/**
 * Root-level files the identity considers. `OracleFiles.paths` walks a
 * directory, and walking the repository root would include node_modules, so the
 * root candidates are named. Missing files are simply absent from the record.
 */
const ROOT_FILES = [
  '.npmrc',
  '.nvmrc',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'wdio.ci.conf.ts',
  'wdio.conf.ts',
  'wdio.demo.conf.ts',
  'wdio.eval.conf.ts',
] as const

const DEPENDENCY_FILES = new Set<string>([
  '.npmrc',
  '.nvmrc',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
])

/** Runtime state the harness writes beside tracked files; never a rendering input. */
const RUNTIME_FILES = new Set<string>(['tests/e2e/electron-shell/.e2e-env.json'])

/** Directories walked for broad (global) inputs; the root is covered by ROOT_FILES. */
const WALKED_DIRECTORIES = ['scripts', 'src', 'tests'] as const

const FIXTURE_LITERAL = /['"`]((?:tests\/e2e\/fixtures|tests\/fixtures)\/[A-Za-z0-9_./-]+)['"`]/g

const SHA256 = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const SPEC_PATH = /^tests\/e2e\/[A-Za-z0-9][A-Za-z0-9._-]*\.e2e\.ts$/
// Repository-relative segments: a dotfile such as `.nvmrc` is fine, `.`/`..` are not.
const INPUT_SEGMENT = '\\.?[A-Za-z0-9_@-][A-Za-z0-9_.@-]*'
const INPUT_PATH = new RegExp(`^${INPUT_SEGMENT}(?:/${INPUT_SEGMENT})*$`)
const MAX_RECORD_TEXT = 64 * 1024 * 1024
const MAX_FILES = 50_000
const MAX_RECORDS = 4096

const hash = z.string().regex(SHA256)
const commit = z.string().regex(COMMIT)
const short = z.string().trim().min(1).max(200)

export const renderingEnvironmentSchema = z
  .object({
    electron: short,
    chromium: short,
    node: short,
    os: short,
    arch: short,
    image: short,
    headless: short,
    timezone: short,
    systemFonts: short,
  })
  .strict()
export type RenderingEnvironment = z.infer<typeof renderingEnvironmentSchema>

export const renderingProvenanceSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    run: z.string().regex(/^[1-9][0-9]*$/),
    attempt: z.string().regex(/^[1-9][0-9]*$/),
    job: short,
    event: short,
    shard: z.string().regex(/^[1-9][0-9]*\/[1-9][0-9]*$/),
    checkout: commit,
    head: commit,
    base: commit.nullable(),
    runner: z.object({ name: short, environment: short }).strict(),
  })
  .strict()
export type RenderingProvenance = z.infer<typeof renderingProvenanceSchema>

const renderingResultSchema = z
  .object({
    sha256: hash,
    bytes: z.number().int().positive().max(16777216),
    rendered: z.boolean().nullable(),
  })
  .strict()
export type RenderingResult = z.infer<typeof renderingResultSchema>

const inputPath = z.string().min(1).max(512).regex(INPUT_PATH)
const inputPaths = z.array(inputPath).max(MAX_FILES)
const inputsSchema = z
  .object({
    spec: inputPaths,
    fixtures: inputPaths,
    renderer: inputPaths,
    assets: inputPaths,
    dependencies: inputPaths,
    capture: inputPaths,
  })
  .strict() satisfies z.ZodType<RenderingInputs>

const identityRecordSchema = z
  .object({
    name: z.string().regex(SCREENSHOT_NAME),
    spec: z.string().regex(SPEC_PATH),
    identity: hash,
    inputs: inputsSchema,
    result: renderingResultSchema.nullable(),
  })
  .strict()
export type IdentityRecord = z.infer<typeof identityRecordSchema>

export const markerStates = z.enum(['valid', 'missing', 'invalidated'])
export type MarkerState = z.infer<typeof markerStates>

const identityRecordsSchema = z
  .object({
    version: z.literal(1),
    provenance: renderingProvenanceSchema,
    environment: renderingEnvironmentSchema,
    marker: markerStates,
    files: z.record(inputPath, hash),
    records: z.array(identityRecordSchema).max(MAX_RECORDS),
  })
  .strict()
export type IdentityRecords = z.infer<typeof identityRecordsSchema>

function sortedUnique(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** JSON with every object's keys sorted, so equal structures hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function classifyBroad(path: string): InputClass {
  if (
    path.startsWith('tests/e2e/fixtures/') ||
    path.startsWith('tests/e2e/scenarios/') ||
    path.startsWith('tests/demo/')
  )
    return 'fixtures'
  if (path.startsWith('src/')) return 'renderer'
  if (DEPENDENCY_FILES.has(path) || /^tsconfig.*\.json$/.test(path)) return 'dependencies'
  return 'capture'
}

/** Per-process caches shared across every spec of one run. */
export interface InputsCache {
  imports: Map<string, Set<string>>
  sources?: Map<string, string>
  broad?: Map<InputClass, string[]>
  sourceFiles?: string[]
}

export function newInputsCache(): InputsCache {
  return { imports: new Map() }
}

function broadInputs(tree: IdentityTree, cache: InputsCache): Map<InputClass, string[]> {
  if (cache.broad) return cache.broad
  const out = new Map<InputClass, string[]>(INPUT_CLASSES.map((cls) => [cls, []]))
  const candidates = [
    ...ROOT_FILES.filter((path) => tree.isFile(path)),
    ...WALKED_DIRECTORIES.flatMap((dir) => tree.paths(dir)),
  ]
  for (const path of candidates) {
    if (RUNTIME_FILES.has(path)) continue
    const broad = BROAD_PATTERNS.some((re) => re.test(path))
    if (broad) out.get(classifyBroad(path))?.push(path)
    else if (DEPENDENCY_FILES.has(path)) out.get('dependencies')?.push(path)
    else if (path.startsWith('tests/e2e/fixtures/')) out.get('fixtures')?.push(path)
  }
  // Everything under assets/ ships with the renderer bundle (fonts, marks, icons).
  out.set('assets', tree.paths('assets'))
  // The e2e launcher is not matched by the oracle's broad patterns but decides
  // the virtual display geometry the renders run on.
  if (tree.isFile('scripts/run-e2e.mts')) out.get('capture')?.push('scripts/run-e2e.mts')
  cache.broad = out
  return out
}

function sourceBody(path: string, tree: IdentityTree, cache: InputsCache): string {
  cache.sources ??= new Map()
  let body = cache.sources.get(path)
  if (body === undefined) {
    body = tree.read(path)
    cache.sources.set(path, body)
  }
  return body
}

/** Fixture paths a spec (or a helper it imports) names as a string literal. */
function literalFixtures(bodies: Iterable<string>, tree: IdentityTree): string[] {
  const out: string[] = []
  for (const body of bodies) {
    for (const m of body.matchAll(FIXTURE_LITERAL)) {
      const literal = m[1]
      if (literal === undefined || literal.includes('..')) continue
      if (tree.isFile(literal)) out.push(literal)
      else out.push(...tree.paths(literal))
    }
  }
  return out
}

/**
 * The files whose bytes can change what `spec` renders, grouped by class and
 * disjoint across classes (a path belongs to the first class that claims it).
 *
 * The mapping is the oracle's own: the import graph (`reachableFiles`), the
 * selector vocabulary (`extractSpecTokens` + `tokenMatcher` over shipped source)
 * and the broad, render-affecting globals (`BROAD_PATTERNS`). It is a superset
 * on purpose: an input that does not really reach the pixels only makes two
 * renders look different when they were the same, never the reverse.
 */
export function renderingInputs(
  spec: string,
  tree: IdentityTree,
  cache: InputsCache = newInputsCache(),
): RenderingInputs {
  if (!SPEC_PATH.test(spec)) throw new Error(`Not an e2e spec path: ${spec}`)
  const reach = reachableFiles(spec, cache.imports, tree)
  const specFiles = [spec, ...reach].filter((path) => !RUNTIME_FILES.has(path))
  const tokens = extractSpecTokens(tree.read(spec)).filter(
    (tok) => !SELECTOR_STOPLIST.has(tok.value),
  )
  const matchers = tokens.map((tok) => tokenMatcher(tok))
  cache.sourceFiles ??= listSourceFiles(tree)
  const mapped = cache.sourceFiles.filter((path) => {
    const body = sourceBody(path, tree, cache)
    return matchers.some((matches) => matches(body))
  })
  const broad = broadInputs(tree, cache)
  const claimed = new Set<string>()
  const claim = (paths: Iterable<string>): string[] => {
    const out: string[] = []
    for (const path of sortedUnique(paths)) {
      if (claimed.has(path)) continue
      claimed.add(path)
      out.push(path)
    }
    return out
  }
  return {
    spec: claim(specFiles),
    fixtures: claim([
      ...(broad.get('fixtures') ?? []),
      ...literalFixtures(
        specFiles.map((path) => sourceBody(path, tree, cache)),
        tree,
      ),
    ]),
    assets: claim(broad.get('assets') ?? []),
    dependencies: claim(broad.get('dependencies') ?? []),
    capture: claim(broad.get('capture') ?? []),
    renderer: claim([...(broad.get('renderer') ?? []), ...mapped]),
  }
}

function inputDigests(inputs: RenderingInputs, files: Record<string, string>): unknown {
  const out: Record<string, Record<string, string>> = {}
  for (const cls of INPUT_CLASSES) {
    const digests: Record<string, string> = {}
    for (const path of inputs[cls]) {
      const digest = files[path]
      if (digest === undefined) throw new Error(`Input ${path} has no recorded hash`)
      digests[path] = digest
    }
    out[cls] = digests
  }
  return out
}

/** The identity: a hash over the rendering inputs' hashes, never over provenance. */
export function identityHash(
  record: Pick<IdentityRecord, 'name' | 'spec' | 'inputs'>,
  files: Record<string, string>,
  environment: RenderingEnvironment,
): string {
  return sha256Hex(
    canonicalJson({
      version: 1,
      name: record.name,
      spec: record.spec,
      environment: renderingEnvironmentSchema.parse(environment),
      inputs: inputDigests(record.inputs, files),
    }),
  )
}

export interface ScreenshotFile {
  bytes: Uint8Array
  mtimeMs: number
}

export interface BuildIdentityInput {
  tree: IdentityTree
  /** Specs this shard ran, in the shard's order. */
  specs: readonly string[]
  environment: RenderingEnvironment
  provenance: RenderingProvenance
  /** sha256 of a repository file's bytes. */
  hashFile: (path: string) => string
  /** The rendered or restored PNG for a name, or null when absent. */
  screenshot: (name: string) => ScreenshotFile | null
  /** Every name the baseline manifest knows; unmapped ones are the marker controls. */
  baselineNames: readonly string[]
  /** mtime of the marker stamped after hydration and before the run, or null. */
  markerMs: number | null
  cache?: InputsCache
}

/**
 * Build the per-shard record set. `rendered` is true when the PNG was written
 * after the marker, which the `prepare` step stamps after hydrating baselines.
 * If any PNG no spec of this shard owns is newer than the marker, something
 * other than a spec wrote after it (a late hydration, a restore), so the marker
 * proves nothing and every `rendered` becomes null rather than a guess.
 */
export function buildIdentityRecords(input: BuildIdentityInput): IdentityRecords {
  const cache = input.cache ?? newInputsCache()
  const environment = renderingEnvironmentSchema.parse(input.environment)
  const provenance = renderingProvenanceSchema.parse(input.provenance)
  const files: Record<string, string> = {}
  const digest = (path: string): string => {
    const known = files[path]
    if (known !== undefined) return known
    const computed = input.hashFile(path)
    files[path] = computed
    return computed
  }
  const owners = new Map<string, string>()
  const inputsBySpec = new Map<string, RenderingInputs>()
  for (const spec of input.specs) {
    const inputs = renderingInputs(spec, input.tree, cache)
    inputsBySpec.set(spec, inputs)
    for (const cls of INPUT_CLASSES) for (const path of inputs[cls]) digest(path)
    for (const name of extractSpecScreenshots(input.tree.read(spec))) {
      const owner = owners.get(name)
      if (owner !== undefined && owner !== spec)
        throw new Error(`Screenshot ${name} is written by both ${owner} and ${spec}`)
      owners.set(name, spec)
    }
  }
  const shots = new Map<string, ScreenshotFile | null>()
  const shot = (name: string): ScreenshotFile | null => {
    if (!shots.has(name)) shots.set(name, input.screenshot(name))
    return shots.get(name) ?? null
  }
  let marker: MarkerState = input.markerMs === null ? 'missing' : 'valid'
  if (input.markerMs !== null) {
    for (const name of input.baselineNames) {
      if (owners.has(name)) continue
      const control = shot(name)
      if (control && control.mtimeMs > input.markerMs) {
        marker = 'invalidated'
        break
      }
    }
  }
  const records: IdentityRecord[] = []
  for (const [name, spec] of [...owners.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const inputs = inputsBySpec.get(spec)
    if (!inputs) throw new Error(`No inputs computed for ${spec}`)
    const png = shot(name)
    const result: RenderingResult | null = png
      ? {
          sha256: sha256Hex(png.bytes),
          bytes: png.bytes.byteLength,
          rendered:
            marker === 'valid' && input.markerMs !== null ? png.mtimeMs > input.markerMs : null,
        }
      : null
    const partial = { name, spec, inputs }
    records.push({ ...partial, identity: identityHash(partial, files, environment), result })
  }
  return parseIdentityRecords(
    serializeIdentityRecords({ version: 1, provenance, environment, marker, files, records }),
  )
}

export function serializeIdentityRecords(records: IdentityRecords): string {
  return `${JSON.stringify(
    {
      version: records.version,
      provenance: records.provenance,
      environment: records.environment,
      marker: records.marker,
      files: Object.fromEntries(
        Object.entries(records.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
      records: [...records.records].sort((a, b) => a.name.localeCompare(b.name, 'en')),
    },
    null,
    2,
  )}\n`
}

/**
 * Decode a record set and refuse anything the identity cannot vouch for: an
 * input with no hash, an identity that does not recompute from the listed
 * inputs and environment, a spec absent from its own inputs, duplicate names,
 * a shard index past its total, or provenance that is missing or malformed.
 */
export function parseIdentityRecords(text: string): IdentityRecords {
  const parsed =
    text.length <= MAX_RECORD_TEXT
      ? safeJsonParse(text, decodeWithSchema(identityRecordsSchema))
      : null
  if (!parsed) throw new Error('Invalid screenshot identity records')
  const [index, total] = parsed.provenance.shard.split('/').map(Number)
  if (index === undefined || total === undefined || index > total)
    throw new Error('Invalid screenshot identity records: shard index exceeds its total')
  if (Object.keys(parsed.files).length > MAX_FILES)
    throw new Error('Invalid screenshot identity records: too many files')
  const names = new Set<string>()
  for (const record of parsed.records) {
    if (names.has(record.name))
      throw new Error(`Invalid screenshot identity records: duplicate ${record.name}`)
    names.add(record.name)
    if (!record.inputs.spec.includes(record.spec))
      throw new Error(`Invalid screenshot identity records: ${record.name} omits its spec`)
    const seen = new Set<string>()
    for (const cls of INPUT_CLASSES) {
      const paths = record.inputs[cls]
      const canonical = sortedUnique(paths)
      if (paths.length !== canonical.length || paths.some((path, i) => path !== canonical[i]))
        throw new Error(
          `Invalid screenshot identity records: ${record.name} ${cls} inputs unsorted`,
        )
      for (const path of paths) {
        if (seen.has(path))
          throw new Error(`Invalid screenshot identity records: ${path} listed twice`)
        seen.add(path)
        if (!Object.hasOwn(parsed.files, path))
          throw new Error(`Invalid screenshot identity records: ${path} has no hash`)
      }
    }
    let expected: string
    try {
      expected = identityHash(record, parsed.files, parsed.environment)
    } catch {
      throw new Error('Invalid screenshot identity records: identity cannot be recomputed')
    }
    if (expected !== record.identity)
      throw new Error(`Invalid screenshot identity records: ${record.name} identity mismatch`)
  }
  return parsed
}

/** `i/n` → { index, total } with 1 <= i <= n, or null. */
export function parseShard(text: string): { index: number; total: number } | null {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(text)
  if (!m || m[1] === undefined || m[2] === undefined) return null
  const index = Number(m[1])
  const total = Number(m[2])
  return index <= total ? { index, total } : null
}

/**
 * Environment fields read from the Actions runner. `image` is the hosted image
 * (ImageOS/ImageVersion); a self-hosted runner exposes no image identity yet, so
 * it records the environment with `unknown-image` and the plan lists that gap.
 */
export function environmentFromRunner(
  env: NodeJS.ProcessEnv,
  versions: { electron: string; chromium: string; node: string; systemFonts: string },
): RenderingEnvironment {
  const text = (value: string | undefined, fallback: string): string => nonEmpty(value) ?? fallback
  const imageOs = env['ImageOS']?.trim()
  const imageVersion = env['ImageVersion']?.trim()
  return renderingEnvironmentSchema.parse({
    electron: versions.electron,
    chromium: versions.chromium,
    node: versions.node,
    os: text(env['RUNNER_OS'], process.platform),
    arch: text(env['RUNNER_ARCH'], process.arch),
    image:
      imageOs && imageVersion
        ? `${imageOs}/${imageVersion}`
        : `${text(env['RUNNER_ENVIRONMENT'], 'local')}:unknown-image`,
    headless: text(env['COPSE_E2E_HEADLESS'], 'unset'),
    timezone: text(env['TZ'], 'unset'),
    systemFonts: versions.systemFonts,
  })
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

/** Provenance fields read from the Actions event, or null when any is missing. */
export function provenanceFromRunner(
  env: NodeJS.ProcessEnv,
  input: { shard: string; checkout: string; head: string | undefined; base: string | undefined },
): RenderingProvenance | null {
  const candidate = {
    repository: env['GITHUB_REPOSITORY'] ?? '',
    run: env['GITHUB_RUN_ID'] ?? '',
    attempt: env['GITHUB_RUN_ATTEMPT'] ?? '',
    job: env['GITHUB_JOB'] ?? '',
    event: env['GITHUB_EVENT_NAME'] ?? '',
    shard: input.shard,
    checkout: input.checkout,
    head: nonEmpty(input.head) ?? input.checkout,
    base: nonEmpty(input.base),
    runner: { name: env['RUNNER_NAME'] ?? '', environment: env['RUNNER_ENVIRONMENT'] ?? '' },
  }
  const result = renderingProvenanceSchema.safeParse(candidate)
  return result.success ? result.data : null
}
