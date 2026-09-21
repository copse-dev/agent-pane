import { readFileSync, writeFileSync } from 'node:fs'

const PREVIEW_TARGET = /^pr-([1-9]\d*)(-preview)?$/

export interface DemoPreviewReconciliationPlan {
  openPullCount: number
  retainedTargets: string[]
  closedTargets: string[]
  previewBytesBefore: number
  previewBytesAfter: number
  reclaimedPreviewBytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Validate the complete, paginated response produced by `gh api --paginate --slurp`. */
export function openPullNumbersFromPages(value: unknown): Set<number> {
  if (!Array.isArray(value) || value.length === 0 || !value.every(Array.isArray)) {
    throw new Error('Expected a paginated array of open-pull response pages')
  }
  const numbers = new Set<number>()
  for (const page of value) {
    for (const pull of page) {
      if (
        !isRecord(pull) ||
        typeof pull['number'] !== 'number' ||
        !Number.isSafeInteger(pull['number']) ||
        pull['number'] < 1
      ) {
        throw new Error('Open-pull inventory contained an invalid pull number')
      }
      numbers.add(pull['number'])
    }
  }
  return numbers
}

/** A retry after an ambiguous push still needs a Pages deploy if it found no work. */
export function shouldDeployAfterEmptyPlan(
  plan: DemoPreviewReconciliationPlan,
  appliedBeforeThisPlan: boolean,
): boolean {
  return plan.closedTargets.length === 0 && appliedBeforeThisPlan
}

/**
 * Select only generated per-PR directories whose PR is no longer open.
 *
 * Names outside the exact `pr-N` / `pr-N-preview` format are intentionally
 * preserved, including the persistent `main`, `release`, and `vendor` trees.
 */
export function planDemoPreviewReconciliation(
  directories: readonly string[],
  openPullNumbers: ReadonlySet<number>,
  previewBytesByTarget: ReadonlyMap<string, number> = new Map(),
): DemoPreviewReconciliationPlan {
  const previewTargets = [...new Set(directories.filter((name) => PREVIEW_TARGET.test(name)))].sort(
    (left, right) => left.localeCompare(right, 'en'),
  )
  const retainedTargets: string[] = []
  const closedTargets: string[] = []
  for (const target of previewTargets) {
    const match = PREVIEW_TARGET.exec(target)
    if (!match) continue
    if (openPullNumbers.has(Number(match[1]))) retainedTargets.push(target)
    else closedTargets.push(target)
  }
  const previewBytesBefore = previewTargets.reduce(
    (total, target) => total + (previewBytesByTarget.get(target) ?? 0),
    0,
  )
  const previewBytesAfter = retainedTargets.reduce(
    (total, target) => total + (previewBytesByTarget.get(target) ?? 0),
    0,
  )
  return {
    openPullCount: openPullNumbers.size,
    retainedTargets,
    closedTargets,
    previewBytesBefore,
    previewBytesAfter,
    reclaimedPreviewBytes: previewBytesBefore - previewBytesAfter,
  }
}

/** Sum `git ls-tree -rl` blob bytes by exact top-level preview directory. */
export function previewBytesByTargetFromTree(tree: string): Map<string, number> {
  const bytesByTarget = new Map<string, number>()
  for (const line of tree.split('\0')) {
    if (line.length === 0) continue
    const tab = line.indexOf('\t')
    if (tab < 0) throw new Error('NUL-delimited tree record omitted its path separator')
    const fields = line.slice(0, tab).split(' ')
    const size = Number(fields.at(-1))
    const target = line.slice(tab + 1).split('/', 1)[0]
    if (!target || !PREVIEW_TARGET.test(target)) continue
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Tree metadata contained an invalid blob size for ${target}`)
    }
    bytesByTarget.set(target, (bytesByTarget.get(target) ?? 0) + size)
  }
  return bytesByTarget
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name)
  const value = index < 0 ? undefined : args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name} argument`)
  return value
}

function main(): void {
  const args = process.argv.slice(2)
  const directoriesPath = requiredOption(args, '--directories')
  const pullsPath = requiredOption(args, '--open-pulls')
  const treePath = requiredOption(args, '--tree')
  const targetsPath = requiredOption(args, '--targets-out')
  const changedPath = requiredOption(args, '--changed-out')
  const appliedBeforeThisPlan = requiredOption(args, '--applied-before') === 'true'
  const directories = readFileSync(directoriesPath, 'utf8')
    .split('\n')
    .filter((name) => name.length > 0)
  const openPullNumbers = openPullNumbersFromPages(JSON.parse(readFileSync(pullsPath, 'utf8')))
  const plan = planDemoPreviewReconciliation(
    directories,
    openPullNumbers,
    previewBytesByTargetFromTree(readFileSync(treePath, 'utf8')),
  )
  writeFileSync(
    targetsPath,
    plan.closedTargets.length > 0 ? `${plan.closedTargets.join('\n')}\n` : '',
  )
  writeFileSync(
    changedPath,
    shouldDeployAfterEmptyPlan(plan, appliedBeforeThisPlan) ? 'true\n' : 'false\n',
  )
  process.stdout.write(`${JSON.stringify(plan)}\n`)
}

if (process.argv[1]?.endsWith('/demo-preview-reconcile.mts')) main()
