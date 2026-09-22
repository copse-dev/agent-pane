// A lens is a scoped brief with its own tool budget (docs/plans/copse-reviewer.md,
// Stage 2). Lenses matter more than model count: one model given "only look
// for broken contracts" finds what a generic "review this" does not. Every
// lens stays inside B4 — bugs and regressions only; the `docs` lens the plan
// sketches is deferred with the `docs` class.
import { EXTERNAL_CONTENT_BLOCK } from '@copse/agent/external-content.ts'
import { FINDING_CLASSES, type FindingClass } from './finding.ts'

export interface Lens {
  readonly id: string
  readonly title: string
  /** What to look for, and what not to. Becomes part of the system prompt. */
  readonly brief: string
  /** The classes this lens is expected to raise; others are still accepted. */
  readonly classes: readonly FindingClass[]
  /** Upper bound on tool-using steps for one run under this lens. */
  readonly maxSteps: number
}

const NOT_STYLE =
  'Do not report style, naming, formatting, documentation, or anything the repository’s own linter would flag.'

export const CORRECTNESS_LENS: Lens = {
  id: 'correctness',
  title: 'Bugs and regressions',
  brief: [
    'Look only for defects this change introduces or fails to handle: wrong behaviour, a broken',
    'contract between caller and callee, a missed edge case, an error path that now misbehaves,',
    'a concurrency or resource problem, a security hole, an incompatible API change, or a test',
    `that no longer exercises what it claims to. ${NOT_STYLE}`,
  ].join(' '),
  classes: ['test', 'contract', 'security', 'concurrency', 'resource', 'api-compat'],
  maxSteps: 24,
}

export const CONTRACTS_LENS: Lens = {
  id: 'contracts',
  title: 'Contracts and API compatibility',
  brief: [
    'Look only at the boundaries this change touches: function signatures, return shapes, thrown',
    'errors, persisted formats, wire protocols, configuration keys and exported names. Find every',
    'caller or consumer of a changed boundary with search_code and check whether it still holds.',
    'A changed default, a narrowed input, a widened output or a renamed export that a consumer',
    `still relies on is a finding; a boundary whose consumers were all updated is not. ${NOT_STYLE}`,
  ].join(' '),
  classes: ['contract', 'api-compat'],
  maxSteps: 24,
}

export const BOUNDARIES_LENS: Lens = {
  id: 'boundaries',
  title: 'Semantic boundaries and defaults',
  brief: [
    'Look only at new or changed producers, adapters, tools, serializers and result builders.',
    'For each one, name its closest existing analogue, inventory semantic fields the analogue',
    'supplies that the change omits, and trace every omission through transforms and consumers.',
    'A passing producer-level test does not settle downstream behaviour. Neither the existence',
    'of a fallback nor the fact that it predates the change proves that taking it is intended.',
    'When an omission selects different rendering, trust, permission, persistence or default',
    'behaviour, require concrete repository evidence that the difference is intentional; without',
    `that evidence, report the causal defect at the changed producer. ${NOT_STYLE}`,
  ].join(' '),
  classes: ['contract', 'security', 'api-compat'],
  maxSteps: 20,
}

export const TESTS_LENS: Lens = {
  id: 'tests',
  title: 'Tests that no longer prove what they claim',
  brief: [
    'Look only at the tests around this change. A test that was weakened to pass, a test whose',
    'assertion no longer exercises the changed code path, a fixture that hides the new behaviour,',
    'a skipped or deleted test with no replacement, and changed behaviour with no test at all are',
    'findings. Read the test and the code it targets together; run the test with run_command when',
    `you are unsure what it exercises. ${NOT_STYLE}`,
  ].join(' '),
  classes: ['test'],
  maxSteps: 20,
}

export const SECURITY_LENS: Lens = {
  id: 'security',
  title: 'Security',
  brief: [
    'Look only for security weaknesses this change introduces: untrusted input reaching a shell,',
    'a path, a query, a template or an eval; a check that was removed or reordered; a secret or',
    'credential written, logged or sent; a permission or sandbox boundary widened; a comparison',
    'that is not constant-time where it must be; a deserialisation of untrusted data. Trace the',
    `data from where it enters to where it is used before you report. ${NOT_STYLE}`,
  ].join(' '),
  classes: ['security'],
  maxSteps: 24,
}

export const CONCURRENCY_LENS: Lens = {
  id: 'concurrency',
  title: 'Concurrency and resources',
  brief: [
    'Look only for ordering, lifetime and resource problems this change introduces: a race',
    'between two async paths, an await that was dropped, a lock or queue that is bypassed, a',
    'handle, listener, timer, child process or temp file that is no longer released on every',
    'path, a retry that is unbounded, a cancellation that is ignored. Follow each resource from',
    `acquisition to release before you report. ${NOT_STYLE}`,
  ].join(' '),
  classes: ['concurrency', 'resource'],
  maxSteps: 20,
}

export const LENSES: readonly Lens[] = [
  CORRECTNESS_LENS,
  CONTRACTS_LENS,
  BOUNDARIES_LENS,
  TESTS_LENS,
  SECURITY_LENS,
  CONCURRENCY_LENS,
]

export const DEFAULT_LENS_IDS: readonly string[] = [CORRECTNESS_LENS.id]

/**
 * Resolve a `--lenses` spec: a comma-separated list of ids, or `all`. Unknown
 * ids are an error, never silently dropped; an empty spec is the default.
 */
export function resolveLenses(spec: string | undefined): Lens[] {
  if (spec === undefined || spec.trim() === '') {
    return LENSES.filter((lens) => DEFAULT_LENS_IDS.includes(lens.id))
  }
  if (spec.trim() === 'all') return [...LENSES]
  const ids = spec
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  const lenses: Lens[] = []
  for (const id of ids) {
    const lens = LENSES.find((candidate) => candidate.id === id)
    if (lens === undefined) {
      throw new Error(`unknown lens ${id}; one of ${LENSES.map((l) => l.id).join(', ')}, or all`)
    }
    if (!lenses.includes(lens)) lenses.push(lens)
  }
  return lenses
}

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
    '- Review causal impact, not just edited lines. An unchanged line can become newly wrong or reachable because of this change; do not dismiss a defect merely because its best anchor is unchanged.',
    '- When a value, result shape, or capability crosses a boundary, find the closest existing analogue and trace producer → transforms → consumers. Compare semantic tags, defaults, provenance, permissions, persistence, rendering, and tests where they matter; matching TypeScript shapes alone is not enough.',
    '- Before declaring a new producer clean, list fields its closest analogue supplies that it omits. Follow each omission through the consumer fallback: undefined, internal, compact, empty, or a default branch is observable behaviour, not evidence that the field does not matter.',
    '- Do not invent concerns, do not pad. A short list a human reads in full beats a long one they skim.',
    '- A clean change is a complete answer: report nothing, but still attest what you checked.',
    '- Your final tool call must be finish_review, exactly once and after every report_finding call. State what you checked and what you could not verify; use "Nothing" only when there is no material uncertainty. Put any defect you did not already send through report_finding in finish_review.findings, or [] when there are none. Then stop.',
    '- Do not end with plain text instead of finish_review. Without that structured completion, the review is incomplete and fails closed.',
    EXTERNAL_CONTENT_BLOCK,
  ].join('\n')
}
