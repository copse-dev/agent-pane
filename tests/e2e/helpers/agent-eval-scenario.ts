import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

export type PromptAttachment = {
  path: string
  content?: string
  fixture?: string
}

export type EvalPrompt =
  | string
  | {
      text: string
      attachments?: PromptAttachment[]
    }

export interface EvalScenario {
  id: string
  description?: string
  workspace?: {
    type: 'current' | 'tempProject'
    prefix?: string
    seedFiles?: PromptAttachment[]
  }
  prompts?: EvalPrompt[]
  promptVariants?: string[]
  autonomy?: {
    tracePath: string
    requireShellApproval?: boolean
  }
  assertWorkspace?: {
    git?: {
      minCommits?: number
    }
    homePage?: {
      path?: string
      contains?: string[]
      linksTo?: string
    }
    menuPage?: {
      path?: string
      contains?: string[]
    }
    filesContain?: Array<{
      glob?: string
      contains: string[]
    }>
  }
}

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

const evalScenarioSchema: z.ZodType<EvalScenario> = z.object({
  id: z.string(),
  description: z.string().optional(),
  workspace: z
    .object({
      type: z.enum(['current', 'tempProject']),
      prefix: z.string().optional(),
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
  assertWorkspace: z
    .object({
      git: z.object({ minCommits: z.number().optional() }).optional(),
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
}
