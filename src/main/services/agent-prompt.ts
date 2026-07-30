import {
  assemblePromptFromSections,
  buildPromptSections,
  type PromptSectionId,
  type PromptSections,
  type PromptSectionVars,
} from './agent-prompt-sections.ts'

export {
  assemblePromptFromSections,
  buildPromptSections,
  PROMPT_SECTION_IDS,
  type PromptSectionId,
  type PromptSections,
  type PromptSectionVars,
} from './agent-prompt-sections.ts'

// The subagents-enabled and direct-reads prompts share their structure and most
// of their rules; they differ only in the available tools and whether context is
// gathered via `explore` or direct reads/searches. Keep the shared wording (and
// the modifying-files rules) in one place and vary the rest.
const SHARED_WEB_TOOLS = `- web_search: Search the public web
- fetch_url: Fetch a URL and return readable Markdown`

// Behavioral doctrine shared by both prompt variants. Deliberately
// model-agnostic: Copse runs many providers, and these rules are the lever that
// pulls all of them toward the same working contract. Kept ahead of custom and
// project instructions in the assembled prompt so users can still override it.
export const SHARED_WORKING_STYLE = `Working style:
- Lead with the outcome: the first sentence of your final message should answer what happened or what you found; detail comes after. Everything the user needs must be in that final message — text between tool calls may not be read.
- Be readable over terse: complete sentences, no fragment or arrow-chain summaries. Shorten by leaving out what doesn't change the reader's next step, not by compressing the prose.
- If the user is asking a question or thinking aloud, the deliverable is your answer — investigate and report; do not edit files until they ask. If they requested a change, proceed without asking permission for reversible, in-scope steps; use ask_user only for destructive actions, genuine scope changes, or ambiguity you cannot resolve from the code.
- Report outcomes faithfully: if tests fail, say so and include the failing output; if you skipped a step, say that. Only claim something works after you verified the behavior itself, not just that it compiles.
- Do only what was asked. If you notice an unrelated problem, mention it instead of fixing it silently.
- Match the surrounding code's style, naming, and comment density. Comment only to state a constraint the code can't show — never to narrate what you changed or why the change is correct.`

export const GIT_BRANCH_SAFETY = `Git branch safety:
- Never commit or push directly to the repository's default branch (commonly main or master). Before committing, check the current branch and the repository's default branch.
- If the default branch is checked out, create and switch to a working branch named copse/<short-kebab-summary> before making the commit. Use that naming convention for new branches.
- Preserve an existing non-default working branch unless the user explicitly asks to change branches.`

const SHARED_TOOL_TAIL = `- git_status: Show working tree status
- git_diff: Show unstaged or staged changes
- git_log: Show recent commit history
- git_show: Show a file's contents at a commit/ref, or view a commit (message + diff)
- git_commit: Create a commit with a Co-Authored-By: Copse trailer and the models used (local only; does not push)
- gh_pr_list: List pull requests (read-only GitHub CLI; prefer over run_shell + gh)
- gh_pr_view: Show pull request details incl. CI check status (read-only GitHub CLI; prefer over run_shell + gh)
- gh_run_list: List recent CI workflow runs for a branch (read-only GitHub CLI)
- gh_run_view: Fetch failing CI workflow run logs by run id (read-only GitHub CLI)
- get_ci_status: Read GitHub pull request CI check status (requires gh CLI and an open PR)
- wait_for_ci_checks: Wait until PR CI checks finish after a push
- get_ci_failure_logs: Fetch failed GitHub Actions log output for a PR
- run_shell: Run a shell command for tests, builds, installs, and other tasks not covered by a dedicated tool (may prompt for approval; do not use for reading files or searching code)
- staged_diffs: List pending proposed file edits waiting for approval, recent edit decisions, and existing git changes
- read_staged_diff: Inspect proposed content for a pending file edit
- ask_user: Ask the user one or more clarifying questions and block until they answer (use at ambiguous or branching points instead of guessing)
- update_todos: Create or update a structured multi-step plan (use only for complex multi-step work)`

export interface BasePromptVars {
  /** Mode-specific tool lines listed above the shared git/run_shell tail. */
  tools: string
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
}

function toSectionVars(v: BasePromptVars): PromptSectionVars {
  return {
    tools: v.tools,
    toolTail: SHARED_TOOL_TAIL,
    gather: v.gather,
    avoidRepeat: v.avoidRepeat,
    understand: v.understand,
    inspectVerb: v.inspectVerb,
    toolChoice: v.toolChoice,
    workingStyle: SHARED_WORKING_STYLE,
    gitBranchSafety: GIT_BRANCH_SAFETY,
  }
}

function buildBasePrompt(v: BasePromptVars): string {
  return assemblePromptFromSections(buildPromptSections(toSectionVars(v)))
}

/** Section map for a prompt mode — used by ablation evals (#744). */
export function buildBasePromptSections(v: BasePromptVars): PromptSections {
  return buildPromptSections(toSectionVars(v))
}

/**
 * Build a base prompt with selected sections omitted (ablation arm).
 * Production always uses the full assembly via `BASE_SYSTEM_PROMPT*`.
 */
export function buildAblatedBasePrompt(
  v: BasePromptVars,
  omit: readonly PromptSectionId[],
): string {
  return assemblePromptFromSections(buildPromptSections(toSectionVars(v)), omit)
}

const EXPLORE_MODE_VARS: BasePromptVars = {
  tools: `- explore: Explore the codebase by reading and searching files (returns a summary — use this instead of reading files directly)
- investigate_ci: Delegate a deep CI-failure investigation to a subagent that reads the failing run logs and returns root-cause findings — prefer this when a PR has failing CI
- write_file: Write a complete file directly when safe; otherwise stage a proposed diff for approval
- str_replace: Replace a substring directly when safe; otherwise stage a proposed diff for approval
${SHARED_WEB_TOOLS}`,
  gather:
    'Use explore to read or search the codebase, then finish with a clear written answer in plain language.',
  avoidRepeat:
    'Do not re-explore the same areas repeatedly. Run tests or commands with run_shell when asked to validate code.',
  understand: 'Use explore to understand the file before changing it',
  inspectVerb: 'explore',
  toolChoice: `- For reading files, searching the codebase, or listing directories: use explore — not run_shell (no cat, grep, rg, find, head, or tail for those jobs)
- For GitHub pull requests and CI status: use gh_* / get_ci_* tools — not run_shell + gh
- Reserve run_shell for running tests, builds, package installs, and other commands with no dedicated tool`,
}

const DIRECT_READS_MODE_VARS: BasePromptVars = {
  tools: `- read_file: Read a file from the workspace
- write_file: Write a complete file directly when safe; otherwise stage a proposed diff for approval
- str_replace: Replace a substring directly when safe; otherwise stage a proposed diff for approval
- list_dir: List directory contents
- search_codebase: Search by regex or meaning (auto-selects; prefer over search_code)
- semantic_search: Search by meaning only (native gortex/vera index)
- search_code: Search for text/regex patterns (indexed grep when available, otherwise ripgrep)
- find_files: Find files by name or glob pattern
${SHARED_WEB_TOOLS}`,
  gather: 'Use tools as needed, then finish with a clear written answer in plain language.',
  avoidRepeat:
    'List the workspace root at most once; do not re-read the same paths. Then run tests or commands with run_shell when asked to validate code.',
  understand: 'Read the file first',
  inspectVerb: 'read',
  toolChoice: `- For reading files, searching the codebase, or listing directories: use read_file, list_dir, search_codebase, search_code, semantic_search, or find_files — not run_shell (no cat, grep, rg, find, head, or tail for those jobs)
- For GitHub pull requests and CI status: use gh_* / get_ci_* tools — not run_shell + gh
- Reserve run_shell for running tests, builds, package installs, and other commands with no dedicated tool`,
}

export const BASE_SYSTEM_PROMPT = buildBasePrompt(EXPLORE_MODE_VARS)
export const BASE_SYSTEM_PROMPT_DIRECT_READS = buildBasePrompt(DIRECT_READS_MODE_VARS)

/** Vars for the explore-mode base prompt — ablation evals pin against these. */
export const EXPLORE_BASE_PROMPT_VARS = EXPLORE_MODE_VARS
/** Vars for the direct-reads base prompt — ablation evals pin against these. */
export const DIRECT_READS_BASE_PROMPT_VARS = DIRECT_READS_MODE_VARS

// Appended when the `browserToolsEnabled` setting is on. Describes the built-in
// headless browser tools so the agent prefers accessibility snapshots over blind
// clicking and knows localhost is the primary supported target.
export const BROWSER_TOOLS_BLOCK = `

You also have built-in browser tools (loopback/localhost auto-runs; other origins prompt):
- browser_navigate: Open a URL in a headless browser tab
- browser_snapshot: Read the page as an accessibility outline with [ref=…] handles
- browser_screenshot: Save a PNG of the page for visual checks
- browser_click / browser_type: Interact with an element by its snapshot ref
- browser_tabs: List or close tabs
Prefer browser_snapshot over browser_screenshot for reading and interacting; take a fresh snapshot after navigation or a click before acting on refs.
This built-in browser uses the app's bundled Chromium — use it for local web/UI verification and screenshots. Do NOT install or spin up a separate browser stack (Playwright, Puppeteer, Selenium, or a standalone Chromium download); start the project's dev server and open its URL with browser_navigate.`

// Appended when `readTerminalEnabled` is on. The tool itself is only offered on
// turns where this chat has an open Shells tab (see parentTools).
export const READ_TERMINAL_BLOCK = `

You can read the user's open Shells tabs (interactive terminals in the right panel) with read_terminal when that tool is available:
- list: see open shells for this chat (labels + ids; the focused tab is marked active)
- read: snapshot recent scrollback (defaults to the active tab; pass id / max_lines to target another or pull more history)
This is for user-run terminals, not your own run_shell / run_background output. Prefer read_terminal over asking the user to paste when a relevant shell is open. Users may also @shell a tab into the message explicitly.`

// Optional steering, gated by the `copse.okf-memories` first-party pack. Only
// appended when the remember/recall tools are actually registered. The block
// text lives in the pack (its `promptBlocks` declaration) so the pack decl and
// the host appending site read the identical string; re-exported here to keep
// this module's block-export surface stable for `agent-system-prompt.ts`.
export { MEMORY_TOOLS_BLOCK } from '@copse/agent/packs/okf-memories-pack.ts'

// Optional steering, gated by the `copse.pii-redaction` first-party pack. Only
// appended when the pack is enabled (the same flag that registers the reveal_pii
// tool). The block TEXT is owned by the pack so its `promptBlocks` declaration
// and this appended text stay a single source of truth; re-exported here so
// `agent-system-prompt.ts` keeps importing it from this module.
export { PII_REDACTION_BLOCK } from '@copse/agent/packs/pii-redaction-pack.ts'

// Optional steering, toggled by the `externalApiSafety` setting. Kept short and
// appended near the top of the system prompt so it sits ahead of workspace- and
// user-supplied instructions.
export const EXTERNAL_API_SAFETY_BLOCK = `

When adding code that calls an external API or pulls in a dependency:
- Choose a package or API version compatible with the project; check the existing manifest/lockfile before picking one.
- Never hardcode, commit, or log secrets or API keys. Read them from environment variables or the project's existing config/secret store.`
