/** Base-change planning only: never dispatch CI, execute a test, or authorize a merge. */
import { execFileSync } from 'node:child_process'
import {
  ciExcludedSpecs,
  computeSelection,
  isDocsOnlyChange,
  listSpecs,
  listUnitTests,
  reachableFiles,
  type OracleFiles,
} from '../test-oracle.mts'

const MAX_BUFFER = 64 * 1024 * 1024
const LIMITS = { unit: 64, e2e: 16 }
const GLOBAL_INPUT =
  /^(?:\.github\/workflows\/|scripts\/|package(?:-lock)?\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig|wdio\.|\.npmrc$|\.gitattributes$)/
const IPC_FILE =
  /^(?:src\/preload\/|src\/main\/ipc\/|src\/shared\/api-protocol\.mts$|schemas\/api-protocol\.)/
const IPC_CONSUMER = /\b(?:window\.api|ipcRenderer|ipcMain|ElectronAPI)\b/
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|css|html|md|ya?ml)$/

export type RefreshRefs = {
  testedBase: string
  testedCandidate: string
  testedPrHead: string
  base: string
  prHead: string
  candidate: string
}

export type RefreshPlan = {
  mode: 'skip' | 'subset' | 'review'
  mappingVersion: 1
  refs: RefreshRefs | null
  candidateTree: string | null
  changes: { pr: string[]; base: string[] }
  areas: { pr: string[]; base: string[]; overlap: string[] }
  unitSpecs: string[]
  e2eSpecs: string[]
  reasons: string[]
}

function git(args: string[], input?: string): Buffer {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    timeout: 30_000,
    maxBuffer: MAX_BUFFER,
  })
}

function text(args: string[]): string {
  return git(args).toString('utf8').trim()
}

function commit(ref: string): string {
  return text(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
}

function diff(from: string, to: string): string[] {
  // Disabling rename folding preserves both old and new paths.
  return git(['diff', '--name-only', '--no-renames', '-z', from, to, '--'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort()
}

/** Bulk read immutable blobs, never checking out or executing candidate code. */
function snapshot(ref: string): OracleFiles {
  const paths = new Map<string, string>()
  for (const entry of git(['ls-tree', '-r', '-z', ref]).toString('utf8').split('\0')) {
    if (!entry) continue
    const match = /^(\d+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry)
    const mode = match?.[1]
    const type = match?.[2]
    const sha = match?.[3]
    const path = match?.[4]
    if (!mode || !type || !sha || !path) throw new Error('Cannot read oracle Git tree')
    if (type !== 'blob' || mode === '120000')
      throw new Error('Submodules or symbolic links require refresh review')
    if (/[\r\n]/.test(path)) throw new Error('Unsupported path in oracle Git tree')
    paths.set(path, sha)
  }
  const blobs = new Map<string, string>()
  const ids = [
    ...new Set([...paths].filter(([path]) => TEXT_FILE.test(path)).map(([, sha]) => sha)),
  ]
  if (ids.length) {
    const output = git(['cat-file', '--batch'], `${ids.join('\n')}\n`)
    let offset = 0
    for (const id of ids) {
      const end = output.indexOf(10, offset)
      if (end < 0) throw new Error('Incomplete oracle blob response')
      const header = output.subarray(offset, end).toString('utf8')
      const match = /^([0-9a-f]+) blob (\d+)$/.exec(header)
      const size = Number(match?.[2])
      if (match?.[1] !== id || !Number.isSafeInteger(size) || size < 0)
        throw new Error('Invalid oracle blob response')
      offset = end + 1
      if (offset + size >= output.length || output[offset + size] !== 10)
        throw new Error('Truncated oracle blob response')
      blobs.set(id, output.subarray(offset, offset + size).toString('utf8'))
      offset += size + 1
    }
    if (offset !== output.length) throw new Error('Unexpected oracle blob response')
  }
  return {
    paths: (dir) => [...paths.keys()].filter((path) => path.startsWith(`${dir}/`)),
    exists: (path) => paths.has(path),
    read: (path) => blobs.get(paths.get(path) ?? '') ?? '',
  }
}

type Impact = {
  areas: Set<string>
  tests: Map<string, Set<string>>
  unknown: Set<string>
}

function ipc(files: Iterable<string>, tree: OracleFiles): boolean {
  return [...files].some((file) => IPC_FILE.test(file) || IPC_CONSUMER.test(tree.read(file)))
}

/** Execution-plan broadness is deliberately not used as an area identity. */
function impact(changed: string[], trees: OracleFiles[]): Impact {
  const areas = new Set<string>()
  const tests = new Map<string, Set<string>>()
  const mapped = new Set<string>()
  const attach = (area: string, test: string): void => {
    const entries = tests.get(area) ?? new Set<string>()
    entries.add(test)
    tests.set(area, entries)
  }
  for (const tree of trees) {
    const selection = computeSelection(changed, tree)
    const cache = new Map<string, Set<string>>()
    const allTests = [...listUnitTests(tree), ...listSpecs(tree)]
    for (const file of changed) {
      if (isDocsOnlyChange([file])) continue
      areas.add(`file:${file}`)
      if (!tree.exists(file)) continue
      const dependencies = reachableFiles(file, cache, tree)
      const footprint = new Set([file, ...dependencies])
      for (const dependency of dependencies) areas.add(`file:${dependency}`)
      const usesIpc = ipc(footprint, tree)
      if (usesIpc) areas.add('contract:ipc')
      for (const test of allTests) {
        const dependenciesOfTest = reachableFiles(test, cache, tree)
        const direct =
          (selection.unitReasons.get(test) ?? []).some(
            (reason) =>
              reason === `imports ${file}` ||
              (reason === 'test file itself changed' && test === file),
          ) ||
          (selection.e2eReasons.get(test) ?? []).some(
            (reason) =>
              reason === `imports ${file}` ||
              reason.endsWith(` in ${file}`) ||
              (reason === 'spec file itself changed' && test === file),
          )
        if (direct) {
          mapped.add(file)
          areas.add(`test:${test}`)
          attach(`test:${test}`, test)
          for (const dependency of footprint) attach(`file:${dependency}`, test)
        }
        // A pure leaf can still affect an IPC caller. Its mapped consumers'
        // contracts matter even when the leaf does not import that contract.
        if ((usesIpc || direct) && ipc([test, ...dependenciesOfTest], tree)) {
          mapped.add(file)
          areas.add('contract:ipc')
          attach('contract:ipc', test)
        }
      }
    }
  }
  const unknown = new Set(
    changed.filter(
      (file) => !isDocsOnlyChange([file]) && (GLOBAL_INPUT.test(file) || !mapped.has(file)),
    ),
  )
  return { areas, tests, unknown }
}

/** No branch update or test execution occurs. Review never contains runnable lists. */
export function planRefresh(input: RefreshRefs): RefreshPlan {
  const plan: RefreshPlan = {
    mode: 'review',
    mappingVersion: 1,
    refs: null,
    candidateTree: null,
    changes: { pr: [], base: [] },
    areas: { pr: [], base: [], overlap: [] },
    unitSpecs: [],
    e2eSpecs: [],
    reasons: [],
  }
  try {
    const refs: RefreshRefs = {
      testedBase: commit(input.testedBase),
      testedCandidate: commit(input.testedCandidate),
      testedPrHead: commit(input.testedPrHead),
      base: commit(input.base),
      prHead: commit(input.prHead),
      candidate: commit(input.candidate),
    }
    plan.refs = refs
    if (refs.testedPrHead !== refs.prHead) {
      plan.reasons.push(
        'Source head differs from the previously tested source; new PR validation required',
      )
      return plan
    }
    for (const [ancestor, descendant] of [
      [refs.testedBase, refs.base],
      [refs.testedBase, refs.testedCandidate],
      [refs.testedPrHead, refs.testedCandidate],
      [refs.base, refs.candidate],
      [refs.prHead, refs.candidate],
    ]) {
      if (!ancestor || !descendant) throw new Error('Missing refresh ancestry')
      git(['merge-base', '--is-ancestor', ancestor, descendant])
    }
    plan.candidateTree = text(['rev-parse', `${refs.candidate}^{tree}`])
    const fork = text(['merge-base', refs.testedBase, refs.prHead])
    plan.changes.pr = diff(fork, refs.prHead)
    plan.changes.base = diff(refs.testedBase, refs.base)
    if (
      plan.changes.base.length === 0 ||
      plan.changes.pr.length === 0 ||
      isDocsOnlyChange(plan.changes.base) ||
      isDocsOnlyChange(plan.changes.pr)
    ) {
      plan.mode = 'skip'
      plan.reasons.push('No new base changes or one side is documentation-only')
      return plan
    }
    const old = snapshot(refs.testedCandidate)
    const current = snapshot(refs.candidate)
    // The PR itself may have deleted a path before its previous validation.
    // Its old consumers remain visible in that run's target tree.
    const trees = [snapshot(refs.testedBase), old, current]
    const pr = impact(plan.changes.pr, trees)
    const base = impact(plan.changes.base, trees)
    const changed = new Set([...plan.changes.pr, ...plan.changes.base])
    const overlap = [...pr.areas]
      .filter(
        (area) => base.areas.has(area) && (!area.startsWith('file:') || changed.has(area.slice(5))),
      )
      .sort()
    plan.areas = { pr: [...pr.areas].sort(), base: [...base.areas].sort(), overlap }
    const unknown = [...new Set([...pr.unknown, ...base.unknown])].sort()
    if (unknown.length) {
      plan.reasons.push(`Cannot establish bounded affected areas: ${unknown.join(', ')}`)
      return plan
    }
    if (!overlap.length) {
      plan.mode = 'skip'
      plan.reasons.push('No mapped dependency, test, or IPC-contract area overlaps')
      return plan
    }
    const selected = new Set<string>()
    for (const area of overlap)
      for (const impactOfSide of [pr, base])
        for (const test of impactOfSide.tests.get(area) ?? []) selected.add(test)
    const unitAll = listUnitTests(current)
    const excluded = ciExcludedSpecs(current)
    const e2eAll = listSpecs(current).filter((test) => !excluded.has(test))
    const unit = unitAll.filter((test) => selected.has(test))
    const e2e = e2eAll.filter((test) => selected.has(test))
    if (
      unit.length + e2e.length === 0 ||
      unit.length > LIMITS.unit ||
      e2e.length > LIMITS.e2e ||
      (unitAll.length > 0 && unit.length === unitAll.length) ||
      (e2eAll.length > 0 && e2e.length === e2eAll.length) ||
      [...selected].some((test) => !current.exists(test) || /\s/.test(test))
    ) {
      plan.reasons.push(
        'Overlapping areas need unbounded, whole-tier, or removed tests; review required without a full rerun',
      )
      return plan
    }
    plan.mode = 'subset'
    plan.unitSpecs = unit
    plan.e2eSpecs = e2e
    plan.reasons.push('Run only these explicit tests on the recorded fresh candidate')
  } catch {
    plan.reasons.push(
      'Cannot verify refs, candidate ancestry, or historical oracle inputs; review required without a full rerun',
    )
  }
  return plan
}

/** Separate keys prevent accidental use as the ordinary full/subset CI plan. */
export function emitRefreshPlan(plan: RefreshPlan): void {
  process.stdout.write(`refresh_mode=${plan.mode}\n`)
  process.stdout.write(`refresh_unit_specs=${plan.unitSpecs.join(' ')}\n`)
  process.stdout.write(`refresh_e2e_specs=${plan.e2eSpecs.join(' ')}\n`)
}
