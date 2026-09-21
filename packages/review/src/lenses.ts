// A lens is a scoped brief with its own tool budget (docs/plans/copse-reviewer.md,
// Stage 2). Lenses matter more than model count: one model given "only look
// for broken contracts" finds what a generic "review this" does not. Phase 1
// ships the one lens B4 allows — bugs and regressions — and the shape the
// others slot into.
import { EXTERNAL_CONTENT_BLOCK } from '@copse/agent/external-content.ts'
import { FINDING_CLASSES } from './finding.ts'

export interface Lens {
  readonly id: string
  readonly title: string
  /** What to look for, and what not to. Becomes part of the system prompt. */
  readonly brief: string
  /** Upper bound on tool-using steps for one run under this lens. */
  readonly maxSteps: number
}

export const CORRECTNESS_LENS: Lens = {
  id: 'correctness',
  title: 'Bugs and regressions',
  brief: [
    'Look only for defects this change introduces or fails to handle: wrong behaviour, a broken',
    'contract between caller and callee, a missed edge case, an error path that now misbehaves,',
    'a concurrency or resource problem, a security hole, an incompatible API change, or a test',
    'that no longer exercises what it claims to. Do not report style, naming, formatting,',
    'documentation, or anything the repository’s own linter would flag.',
  ].join(' '),
  maxSteps: 24,
}

export const LENSES: readonly Lens[] = [CORRECTNESS_LENS]

export interface LensPromptOptions {
  /** Whether `run_command` will work: the cell exists and shell is allowed. */
  readonly canRun: boolean
}

/**
 * The system prompt for one lens. The quality bar is restated as instructions
 * because it is a product requirement, not a suggestion: no evidence, no
 * finding; "clean" is a complete answer; say what was not checked.
 */
export function lensSystemPrompt(lens: Lens, options: LensPromptOptions): string {
  const running = options.canRun
    ? 'You may run commands with run_command; they execute in an isolated copy of the change, so run the tests that cover what you are unsure about.'
    : 'run_command is not available in this run, so settle what you can by reading and say what you could not verify.'
  return [
    'You are Copse Reviewer, reviewing one change to a repository.',
    '',
    `Lens: ${lens.title}. ${lens.brief}`,
    '',
    'Tools: read_file, list_dir, search_code and git_diff read the change and the code around it. Read every changed file that matters before judging it; the diff alone is not enough.',
    running,
    '',
    'Report each defect with the report_finding tool, one call per defect, anchored at the exact file and lines where the bug is. Every finding needs a falsifiable one-sentence claim and the specific reason it is wrong. If a command you ran demonstrates it, pass that call id as evidence.',
    '',
    'Rules:',
    `- Allowed classes: ${FINDING_CLASSES.join(', ')}. Nothing else is a finding.`,
    '- No evidence, no finding. If you cannot point at the lines and say why they are wrong, do not report it.',
    '- Do not invent concerns, do not pad. A short list a human reads in full beats a long one they skim.',
    '- A clean change is a complete answer: report nothing and say so.',
    '- When you are done, reply in plain text with one line on what you checked and one on what you could not, then stop.',
    EXTERNAL_CONTENT_BLOCK,
  ].join('\n')
}
