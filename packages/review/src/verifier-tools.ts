// The tools Stage 4's two roles add on top of the reviewer's read tools.
//
// The REPRODUCER writes one test file into the head checkout and names the
// argv that runs it; the orchestrator runs that argv on head, copies the same
// file into base and runs it there, and hands both results back. The finding
// has differential execution evidence when it fails on head and passes on base.
// Stage 4 must also audit whether that difference actually proves the claim.
//
// The CHALLENGER reads and runs like a reviewer and closes with `verdict`:
// refuted, with the lines that show the claim wrong; stands, when it actively
// confirmed the defect; or undetermined. The burden of proof is on the finding.
import { rm } from 'node:fs/promises'
import { z } from 'zod'
import type { LLMTool } from '@copse/llm/wire-types.ts'
import { wrapExternalContent } from '@copse/agent/external-content.ts'
import { decodeWithSchema } from '@copse/std/safe-json.ts'
import { errorMessage } from '@copse/std/errors.ts'
import { jailPath, readCheckoutFile, writeCheckoutFile } from './checkout-fs.ts'
import type { CellCommandResult } from './isolation.ts'
import {
  MAX_TOOL_OUTPUT_CHARS,
  createReviewerToolExecutor,
  reviewerTools,
  type ReviewerToolExecutor,
  type ReviewerToolHost,
} from './reviewer-tools.ts'

export const REPRODUCER_DIR = '.copse-review'
const REPRODUCER_TIMEOUT_MS = 3 * 60 * 1000
const MAX_REPRODUCER_CHARS = 20_000

export const VERDICT_OUTCOMES = ['refuted', 'stands', 'undetermined'] as const
export type VerdictOutcome = (typeof VERDICT_OUTCOMES)[number]

const verdictArgs = decodeWithSchema(
  z.object({
    status: z.enum(VERDICT_OUTCOMES),
    /** For `refuted`: the lines that show the claim wrong. For `stands`: what confirmed it. */
    reason: z.string().min(8).max(1_200),
    reproducerAssessment: z.enum(['valid', 'invalid', 'undetermined']).optional(),
  }),
)
export type ChallengeVerdict = NonNullable<ReturnType<typeof verdictArgs>>

const reproducerArgs = decodeWithSchema(
  z.object({
    /** Repo-relative path under `.copse-review/`; the same path is used on base. */
    path: z.string().min(1),
    content: z.string().min(1).max(MAX_REPRODUCER_CHARS),
    /** How to run it, from the checkout root. No shell. */
    argv: z.array(z.string().min(1)).min(1),
  }),
)
export type ReproducerRequest = NonNullable<ReturnType<typeof reproducerArgs>>

export interface ReproducerRun {
  readonly path: string
  readonly content: string
  readonly argv: readonly string[]
  readonly head: CellCommandResult
  readonly base: CellCommandResult
  /** Opposite exit codes are a differential, not yet proof of the finding. */
  readonly separates: boolean
}

export interface VerifierToolHost extends ReviewerToolHost {
  readonly requireReproducerAssessment?: boolean
  readonly baseCheckout: string
  prepareBase(signal: AbortSignal): Promise<void>
}

function verdictTool(requireReproducerAssessment: boolean): LLMTool {
  return {
    name: 'verdict',
    description:
      'Close the challenge. refuted: you can show, from the code or a command, that the claim is wrong; stands: you actively confirmed the defect; undetermined: neither.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...VERDICT_OUTCOMES] },
        reason: {
          type: 'string',
          description:
            'The lines or output that decide it. When auditing a reproducer, explain the exercised behavior on BOTH revisions, the assertion failure or claimed runtime error and its link to this claim.',
        },
        ...(requireReproducerAssessment
          ? {
              reproducerAssessment: {
                type: 'string',
                enum: ['valid', 'invalid', 'undetermined'],
                description:
                  'valid only if this test executes the claimed behavior on both revisions and head fails for that defect. Source-text assertions, skipped base paths, absent APIs, setup failures, and unrelated failures are not proof. A plausible finding can stand with invalid proof.',
              },
            }
          : {}),
      },
      required: [
        'status',
        'reason',
        ...(requireReproducerAssessment ? ['reproducerAssessment'] : []),
      ],
    },
  }
}

export function challengerTools(requireReproducerAssessment = false): LLMTool[] {
  return [
    ...reviewerTools().filter(
      (tool) => tool.name !== 'report_finding' && tool.name !== 'finish_review',
    ),
    verdictTool(requireReproducerAssessment),
  ]
}

/** A one-tool protocol-repair surface for a challenger that ended in prose. */
export function challengerClosureTools(requireReproducerAssessment = false): LLMTool[] {
  return [verdictTool(requireReproducerAssessment)]
}

export function reproducerTools(): LLMTool[] {
  return [
    ...reviewerTools().filter(
      (tool) => tool.name !== 'report_finding' && tool.name !== 'finish_review',
    ),
    {
      name: 'write_reproducer',
      description: `Write a test file under ${REPRODUCER_DIR}/ that fails because of the defect and passes without it, and say how to run it (argv from the repository root, no shell). It is run on the change and on the base it was made against; both results come back. Call again to revise.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: `Repo-relative path under ${REPRODUCER_DIR}/` },
          content: { type: 'string' },
          argv: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'content', 'argv'],
      },
    },
  ]
}

export interface VerifierToolExecutor extends ReviewerToolExecutor {
  /** The challenger's closing verdict, if it gave one. */
  verdict(): ChallengeVerdict | null
  /** The last reproducer written and run, if any. */
  reproducer(): ReproducerRun | null
}

function status(result: CellCommandResult): string {
  return result.timedOut ? 'timed out' : `exit ${String(result.exitCode)}`
}

export function createVerifierToolExecutor(host: VerifierToolHost): VerifierToolExecutor {
  const base = createReviewerToolExecutor(host)
  let verdict: ChallengeVerdict | null = null
  let reproducer: ReproducerRun | null = null

  async function runReproducer(request: ReproducerRequest, signal: AbortSignal): Promise<string> {
    if (host.cell === null || host.shellDecision !== 'allow') {
      return 'Error: commands cannot run in this review, so a reproducer cannot be executed'
    }
    const normalised = request.path.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!normalised.startsWith(`${REPRODUCER_DIR}/`) || normalised.includes('..')) {
      return `Error: the reproducer must live under ${REPRODUCER_DIR}/`
    }
    const [file, ...rest] = request.argv
    if (file === undefined) return 'Error: argv is empty'
    signal.throwIfAborted()
    await host.prepareBase(signal)
    signal.throwIfAborted()
    writeCheckoutFile(host.headCheckout, normalised, request.content)
    writeCheckoutFile(host.baseCheckout, normalised, request.content)
    try {
      const head = await host.cell.run({
        target: 'head',
        argv: [file, ...rest],
        timeoutMs: REPRODUCER_TIMEOUT_MS,
        maxOutputBytes: MAX_TOOL_OUTPUT_CHARS * 4,
        signal,
      })
      const baseRun = await host.cell.run({
        target: 'base',
        argv: [file, ...rest],
        timeoutMs: REPRODUCER_TIMEOUT_MS,
        maxOutputBytes: MAX_TOOL_OUTPUT_CHARS * 4,
        signal,
      })
      const scrubbed = {
        head: { ...head, output: host.scrub(head.output) },
        base: { ...baseRun, output: host.scrub(baseRun.output) },
      }
      const separates =
        !scrubbed.head.timedOut &&
        !scrubbed.base.timedOut &&
        scrubbed.head.exitCode !== null &&
        scrubbed.head.exitCode !== 0 &&
        scrubbed.base.exitCode === 0
      reproducer = {
        path: normalised,
        content: request.content,
        argv: [file, ...rest],
        head: scrubbed.head,
        base: scrubbed.base,
        separates,
      }
      const clip = (text: string): string =>
        text.length > MAX_TOOL_OUTPUT_CHARS / 2 ? text.slice(-MAX_TOOL_OUTPUT_CHARS / 2) : text
      return [
        `on the change: ${status(scrubbed.head)}`,
        wrapExternalContent('reproducer_head', clip(scrubbed.head.output)),
        `on the base: ${status(scrubbed.base)}`,
        wrapExternalContent('reproducer_base', clip(scrubbed.base.output)),
        separates
          ? 'The exit codes separate head from base. This is not confirmation: a challenger must audit whether the test proves the claimed behavior on both revisions. Stop writing tests now.'
          : 'This reproducer does not confirm the finding (it must fail on the change and pass on the base). Revise it, or stop if the defect cannot be reproduced.',
      ].join('\n')
    } finally {
      // Base stays pristine for the next reproducer; head keeps the artefact.
      await rm(jailPath(host.baseCheckout, normalised), { force: true })
    }
  }

  return {
    ...base,
    async execute(name, args, signal, toolCallId): Promise<string> {
      try {
        if (name === 'verdict') {
          const input = verdictArgs(args)
          if (input === null)
            return 'Error: verdict needs { status: refuted|stands|undetermined, reason }'
          if (host.requireReproducerAssessment && input.reproducerAssessment === undefined)
            return 'Error: verdict requires reproducerAssessment: valid|invalid|undetermined and a reason auditing the test on both revisions'
          if (input.reproducerAssessment === 'valid' && input.status !== 'stands')
            return 'Error: valid reproducer proof requires the finding to stand'
          verdict = input
          return 'Verdict recorded. Reply with one line and stop.'
        }
        if (name === 'write_reproducer') {
          const input = reproducerArgs(args)
          if (input === null)
            return 'Error: write_reproducer needs { path, content, argv: string[] }'
          return await runReproducer(input, signal)
        }
        return await base.execute(name, args, signal, toolCallId)
      } catch (err) {
        return `Error: ${errorMessage(err)}`
      }
    },
    verdict: () => verdict,
    reproducer: () => reproducer,
  }
}

/** Read the artefact a reproducer left in the head checkout, for the report. */
export function readReproducer(headCheckout: string, path: string): string | null {
  try {
    return readCheckoutFile(headCheckout, path)
  } catch {
    return null
  }
}
