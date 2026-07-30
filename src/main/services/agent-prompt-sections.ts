/**
 * Composable base-prompt sections for ablation evals (#744 / #743 follow-up).
 *
 * The production prompts in `agent-prompt.ts` assemble every section. Ablation
 * tests and future plumbing A/B runs omit one section at a time (e.g. the tool
 * list) while holding the model and task fixed — matching the "hold the model
 * constant and vary the plumbing" framing in
 * `docs/plans/industry-benchmarks.md`.
 *
 * Full assembly (omit none) is byte-identical to the historical `buildBasePrompt`
 * template so shipping prompts cannot drift from the sectioned source.
 */

export const PROMPT_SECTION_IDS = [
  'preamble',
  'tools',
  'workspace',
  'openEnded',
  'modifyingFiles',
  'toolChoice',
  'workingStyle',
  'gitBranchSafety',
] as const

export type PromptSectionId = (typeof PROMPT_SECTION_IDS)[number]

export interface PromptSectionVars {
  /** Mode-specific tool lines listed above the shared git/run_shell tail. */
  tools: string
  /** Shared git / shell / ask_user / todos tool tail. */
  toolTail: string
  /** Open-ended question, step 1: how to gather context. */
  gather: string
  /** Open-ended question, step 2: avoid redoing the same work. */
  avoidRepeat: string
  /** Modifying files, step 1: understand the file first. */
  understand: string
  /** Verb used in "always <verb> before writing" (explore vs read). */
  inspectVerb: string
  /** Tool-choice rules steering away from run_shell for reads/searches. */
  toolChoice: string
  /** Full working-style block including the "Working style:" heading. */
  workingStyle: string
  /** Full git-branch-safety block including its heading. */
  gitBranchSafety: string
}

export type PromptSections = Record<PromptSectionId, string>

/** Build the named sections that compose a base system prompt. */
export function buildPromptSections(v: PromptSectionVars): PromptSections {
  return {
    preamble: "You are a coding assistant with access to the user's local workspace.",
    // Tool list + skills placeholder. Joined to workspace with a single newline
    // (not a blank line) to match the historical template.
    tools: `Available tools:
${v.tools}
${v.toolTail}
{SKILLS_TOOLS_LINE}`,
    workspace: 'Working directory: {WORKSPACE_ROOT}',
    openEnded: `When the user asks an open-ended question (review, explain, validate, summarize):
1. ${v.gather}
2. ${v.avoidRepeat}`,
    modifyingFiles: `When modifying files:
1. ${v.understand}
2. Use str_replace for partial edits or write_file for full rewrites. If git is clean, edits apply directly to disk. If git already has user/unowned changes or there are pending proposed diffs, edits are staged for user approval instead.
3. Do not assume file content; always ${v.inspectVerb} before writing
4. Generated code must be runnable: include the imports, dependencies, and wiring it needs to run
5. When you make an edit, use str_replace or write_file rather than pasting the file's new contents into the chat
6. Read the tool result carefully: if it says applied directly, run_shell, git, and read_file can validate immediately. If it says staged/pending, those tools still see only on-disk content; use staged_diffs/read_staged_diff to inspect proposed content and ask the user to approve before shell validation.
7. If staged_diffs reports existing git changes, avoid direct overwrites and preserve the user's dirty tree.
8. If a retry would not be informed by new information, stop and present your diagnosis via ask_user instead of trying the same fix again`,
    toolChoice: `Tool choice:
${v.toolChoice}`,
    workingStyle: v.workingStyle,
    gitBranchSafety: v.gitBranchSafety,
  }
}

/**
 * Assemble a base prompt from sections, optionally omitting some for ablation.
 *
 * Join rules mirror the historical template:
 * - `tools` and `workspace` share a single newline (no blank line between them)
 * - every other kept section is separated by a blank line
 */
export function assemblePromptFromSections(
  sections: PromptSections,
  omit: readonly PromptSectionId[] = [],
): string {
  const omitted = new Set<PromptSectionId>(omit)
  const parts: string[] = []

  const push = (id: PromptSectionId): void => {
    if (!omitted.has(id)) parts.push(sections[id])
  }

  push('preamble')
  if (!omitted.has('tools') && !omitted.has('workspace')) {
    parts.push(`${sections.tools}\n${sections.workspace}`)
  } else {
    push('tools')
    push('workspace')
  }
  push('openEnded')
  push('modifyingFiles')
  push('toolChoice')
  push('workingStyle')
  push('gitBranchSafety')

  return parts.join('\n\n')
}
