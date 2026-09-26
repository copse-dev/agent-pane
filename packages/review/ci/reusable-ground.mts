import { z } from 'zod'
import { decodeStage0Report } from '../src/stage0-report.ts'

// Changes to the trusted runner or its dependencies invalidate prior grounding.
// PR-owned commands/dependencies are already pinned by head + merge-base.
export const GROUND_POLICY_PATHS = [
  '.github/workflows/review-ground.yml',
  'packages',
  'scripts/prepare-review-stage0.mts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'patches',
  '.npmrc',
  '.nvmrc',
  'tsconfig.node.json',
] as const

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const runSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  display_title: z.string(),
  event: z.literal('workflow_dispatch'),
  status: z.literal('completed'),
  conclusion: z.literal('success'),
  head_branch: z.literal('main'),
  head_sha: sha,
  path: z.literal('.github/workflows/review-ground.yml'),
  created_at: z.iso.datetime(),
  repository: z.object({ id: z.literal(1274237362) }),
  actor: z.object({ id: z.union([z.literal(338988), z.literal(41898282)]) }),
  triggering_actor: z.object({ id: z.union([z.literal(338988), z.literal(41898282)]) }),
})

export interface GroundReuseRequest {
  readonly pr: number
  readonly head: string
  readonly mergeBase: string
  readonly now: number
}

/** Metadata is from GitHub's API, never from the artifact. */
export function reusableGroundRun(value: unknown, request: GroundReuseRequest): number | null {
  const parsed = runSchema.safeParse(value)
  if (!parsed.success) return null
  const run = parsed.data
  const age = request.now - Date.parse(run.created_at)
  const name = `copse-review-ground pr=${String(request.pr)}`
  return run.name === name && run.display_title === name && age >= 0 && age < 24 * 60 * 60_000
    ? run.id
    : null
}

/** Reuse only complete, clean checks; failures and gaps deserve a fresh run. */
export function reusableGroundReport(value: unknown, request: GroundReuseRequest): boolean {
  const report = decodeStage0Report(value)
  if (
    !report ||
    report.headCommit !== request.head ||
    report.mergeBase !== request.mergeBase ||
    report.dirtyWorkingTree ||
    !report.execution.decision.execute ||
    report.execution.backend !== 'ephemeral-runner' ||
    report.execution.strength !== 'container' ||
    report.findings.length > 0 ||
    report.checks.length !== 4 ||
    report.coverage.notChecked.length > 0 ||
    report.preparation.head?.status !== 'passed' ||
    report.preparation.head.exitCode !== 0 ||
    report.preparation.head.target !== 'head' ||
    report.preparation.head.kind !== 'prepare'
  )
    return false
  const project = report.project.head
  if (!project || project.ecosystem === 'unsupported') return false
  return ['build', 'typecheck', 'lint', 'test'].every((kind) => {
    const checks = report.checks.filter((check) => check.kind === kind)
    const commands = project.commands.filter((command) => command.kind === kind)
    const check = checks[0]
    const command = commands[0]
    return (
      checks.length === 1 &&
      commands.length === 1 &&
      check?.verdict === 'clean' &&
      check.head?.target === 'head' &&
      check.head.kind === kind &&
      check.head.status === 'passed' &&
      check.head.exitCode === 0 &&
      check.head.argv.length > 0 &&
      JSON.stringify(check.head.argv) === JSON.stringify(command?.argv) &&
      report.coverage.checked.includes(check.kind)
    )
  })
}
