import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

const promptAttachmentSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  fixture: z.string().optional(),
})

const evalPromptSchema = z.union([
  z.string(),
  z.object({
    text: z.string(),
    attachments: z.array(promptAttachmentSchema).optional(),
  }),
])

const evalScenarioSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  workspace: z
    .object({
      type: z.enum(['current', 'tempProject']),
      prefix: z.string().optional(),
      initializeGit: z.boolean().optional(),
      /** Copy the current checkout's origin into an isolated temp repo for GitHub-tool evals. */
      copyGitRemoteFromCurrent: z.boolean().optional(),
      seedFiles: z.array(promptAttachmentSchema).optional(),
    })
    .optional(),
  prompts: z.array(evalPromptSchema).optional(),
  promptVariants: z.array(z.string()).optional(),
  autonomy: z
    .object({
      tracePath: z.string(),
      requireShellApproval: z.boolean().optional(),
    })
    .optional(),
  backgroundWake: z
    .object({
      continuationCount: z.number().int().positive(),
      reloadRenderer: z.boolean().optional(),
      finalAssistantContains: z.string().min(1),
      timeoutMs: z.number().positive().optional(),
    })
    .optional(),
  toolUse: z
    .object({
      requireTools: z.array(z.string()).optional(),
      /** Passes when the run used at least one of these; `requireTools` is a conjunction. */
      requireAnyTools: z.array(z.string()).optional(),
      /** Require one completed call from every group of alternative tools. */
      requireSuccessfulToolGroups: z.array(z.array(z.string().min(1)).min(1)).optional(),
      forbidTools: z.array(z.string()).optional(),
      /** Fail when `run_shell` ran a command a first-class tool already covers. */
      forbidDisplacedShell: z.boolean().optional(),
      /** Fail when `run_shell` ran destructive VCS recovery (`reset --hard` / `clean -fd`). */
      forbidDestructiveGitShell: z.boolean().optional(),
      /** Fail when `run_shell` touched `~/.copse/workspace` (use read_archive / file tools). */
      forbidCopseWorkspaceShell: z.boolean().optional(),
      /** Fail when a `sandbox_network_audit` card names a GitHub host. */
      forbidGithubNetworkDenial: z.boolean().optional(),
      forbidGlobalTempWrites: z.boolean().optional(),
      requireBackgroundWakeStart: z.boolean().optional(),
      maxApprovals: z.number().int().nonnegative().optional(),
      /**
       * Ceiling on decisions that interrupted the user to let a shell command
       * out of the sandbox. Narrower than `maxApprovals`, which counts every
       * dialog the run raised whatever asked for it.
       */
      maxShellEscalationPrompts: z.number().int().nonnegative().optional(),
      /** Arm Guarded YOLO before the first prompt; harm prompts still require rejection. */
      armGuardedYolo: z.boolean().optional(),
    })
    .optional(),
  assertWorkspace: z
    .object({
      git: z
        .object({
          minCommits: z.number().optional(),
          allCommitMessagesContain: z.array(z.string()).optional(),
        })
        .optional(),
      homePage: z
        .object({
          path: z.string().optional(),
          contains: z.array(z.string()).optional(),
          linksTo: z.string().optional(),
        })
        .optional(),
      menuPage: z
        .object({
          path: z.string().optional(),
          contains: z.array(z.string()).optional(),
        })
        .optional(),
      filesContain: z
        .array(
          z.object({
            glob: z.string().optional(),
            contains: z.array(z.string()),
          }),
        )
        .optional(),
    })
    .optional(),
})

/**
 * Scenario shape, inferred from the schema that parses it.
 *
 * This was written twice — a hand-written interface plus the same object
 * annotated `z.ZodType<EvalScenario>` — and under `exactOptionalPropertyTypes`
 * the two cannot agree: zod types an omitted field as `T | undefined`, the
 * interface as "absent, or `T`". `tsc` rejects the annotation outright, so the
 * file only typechecked while nothing in a checked project imported it.
 * Inferring leaves the parser as the single declaration of the shape.
 */
export type EvalScenario = z.infer<typeof evalScenarioSchema>
export type EvalPrompt = z.infer<typeof evalPromptSchema>
export type PromptAttachment = z.infer<typeof promptAttachmentSchema>

export function loadEvalScenario(path: string): EvalScenario {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return evalScenarioSchema.parse(value)
}

export function selectedEvalPrompts(scenario: EvalScenario): EvalPrompt[] {
  const variants = scenario.promptVariants
  if (variants && variants.length > 0) {
    const rawIndex = process.env['COPSE_EVAL_PROMPT_VARIANT'] ?? '0'
    const index = Number.parseInt(rawIndex, 10)
    const prompt = variants[index]
    if (!Number.isInteger(index) || index < 0 || prompt === undefined) {
      throw new Error(
        `COPSE_EVAL_PROMPT_VARIANT must select 0..${String(variants.length - 1)}; received ${rawIndex}`,
      )
    }
    return [prompt]
  }
  if (!scenario.prompts || scenario.prompts.length === 0) {
    throw new Error(`Scenario ${scenario.id} must define prompts or promptVariants`)
  }
  return scenario.prompts
}

export function createEvalProject(scenario: EvalScenario): {
  root: string
  cleanup: () => void
} {
  if (scenario.workspace?.type !== 'tempProject') {
    return { root: process.cwd(), cleanup: () => undefined }
  }
  const prefix = scenario.workspace.prefix ?? `${scenario.id}-`
  const root = mkdtempSync(join(tmpdir(), prefix))
  return {
    root,
    cleanup: () => {
      if (process.env['COPSE_EVAL_KEEP_WORKSPACE'] === '1') return
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function resolvePromptAttachment(attachment: PromptAttachment): {
  path: string
  content: string
} {
  if (attachment.content !== undefined) {
    return { path: attachment.path, content: attachment.content }
  }
  if (!attachment.fixture) {
    throw new Error(`Attachment ${attachment.path} must define either content or fixture`)
  }
  const fixturePath = resolve(process.cwd(), attachment.fixture)
  return { path: attachment.path, content: readFileSync(fixturePath, 'utf8') }
}

export function seedEvalWorkspace(root: string, scenario: EvalScenario): void {
  for (const seedFile of scenario.workspace?.seedFiles ?? []) {
    const file = resolvePromptAttachment(seedFile)
    const target = resolve(root, file.path)
    const relativeTarget = relative(root, target)
    if (
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${sep}`) ||
      isAbsolute(relativeTarget)
    ) {
      throw new Error(`Seed file escapes the eval workspace: ${file.path}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.content, 'utf8')
  }
  if (scenario.workspace?.initializeGit === true) {
    // Copse's real New project flow initializes Git before opening the first
    // chat. Mirror that boundary so native write tools can apply new files
    // directly instead of staging approval-only diffs in an untracked folder.
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' })
  }
  if (scenario.workspace?.copyGitRemoteFromCurrent === true) {
    if (scenario.workspace.initializeGit !== true) {
      throw new Error('copyGitRemoteFromCurrent requires initializeGit')
    }
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim()
    if (!origin) throw new Error('Current checkout has no origin remote for the eval workspace')
    execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root, stdio: 'ignore' })
  }
}
