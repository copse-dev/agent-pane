import type { RoadmapCategory, RoadmapComplexity } from '../../src/shared/roadmap/complexity.ts'
import type { RoadmapFit } from '../../src/shared/roadmap/fit.ts'
import type { RoadmapReviewVerdict } from '../../src/shared/roadmap/review.ts'
import type { RoadmapCoverageVerdict } from '../../src/shared/roadmap/coverage.ts'
import type { FollowUpContext } from '../../src/shared/follow-ups/types.ts'

/**
 * Labelled cases for the six background questions (see README.md). Every label
 * is the author's judgement against the wording the product question uses; a
 * `note` explains any label a careful reader could dispute. The cases are
 * synthetic but shaped like Copse's own backlog, so they measure the questions
 * as asked, not a model's general knowledge.
 */

export interface LabelCase<T extends string> {
  id: string
  /** The roadmap prompt the question judges. */
  text: string
  expected: T
  note?: string
}

export const COMPLEXITY_CASES: readonly LabelCase<RoadmapComplexity>[] = [
  {
    id: 'rename-decision-label',
    text: 'Rename the `tier-shadow` decision label to `tier-preview` in the decision log copy.',
    expected: 'low',
  },
  {
    id: 'fix-permissions-typo',
    text: "Fix the typo 'recieve' in the Settings → Permissions hint text.",
    expected: 'low',
  },
  {
    id: 'fit-parser-test',
    text: 'Add a unit test that parseFitVerdict ignores a verdict word on the second line.',
    expected: 'low',
  },
  {
    id: 'follow-up-timeout',
    text: 'Change the follow-up suggestion timeout from 15 seconds to 20 seconds.',
    expected: 'low',
  },
  {
    id: 'roadmap-title-ellipsis',
    text: 'Make long roadmap row titles truncate with an ellipsis instead of wrapping onto two lines.',
    expected: 'low',
  },
  {
    id: 'about-version',
    text: 'Show the full build hash next to the version string in the About section.',
    expected: 'low',
  },
  {
    id: 'hide-test-while-saving',
    text: 'Disable the "Test classifier" button while a classifier connection is being saved.',
    expected: 'low',
  },
  {
    id: 'gortex-warning',
    text: 'Log a warning instead of throwing when the vendored gortex binary is missing at startup.',
    expected: 'low',
  },
  {
    id: 'copy-issue-link',
    text: 'Add a "Copy issue link" action to each roadmap row that copies the pinned issue URL.',
    expected: 'medium',
  },
  {
    id: 'footer-usage',
    text: 'Show the current thread’s input and output token usage in the footer usage tooltip.',
    expected: 'medium',
  },
  {
    id: 'terminal-shortcut',
    text: 'Add a keyboard shortcut that toggles the terminal pane and list it in the shortcuts dialog.',
    expected: 'medium',
  },
  {
    id: 'per-project-small-model',
    text: 'Let each project choose its own small-tasks model, falling back to the global choice.',
    expected: 'medium',
  },
  {
    id: 'hide-done-filter',
    text: 'Add a filter to the roadmap pane that hides items marked done, remembered per project.',
    expected: 'medium',
  },
  {
    id: 'retry-issue-fetch',
    text: 'Retry a failed GitHub issue fetch once in the import picker, then show the error inline.',
    expected: 'medium',
  },
  {
    id: 'follow-up-setting',
    text: 'Add a Settings toggle that turns off follow-up bubbles, and respect it in the renderer.',
    expected: 'medium',
  },
  {
    id: 'roadmap-csv',
    text: 'Add a CSV export of the roadmap next to the existing Markdown export.',
    expected: 'medium',
    note: 'Could read as low; it spans the export service, a menu entry and a test.',
  },
  {
    id: 'sqlite-threads',
    text: 'Move thread storage from JSON files to SQLite, with a migration for existing threads.',
    expected: 'high',
  },
  {
    id: 'multi-window',
    text: 'Support multiple windows so two projects can run side by side with separate agents.',
    expected: 'high',
  },
  {
    id: 'policy-engine',
    text: 'Replace the permission gate with a policy engine that supports per-project rules and an audit log.',
    expected: 'high',
  },
  {
    id: 'linux-container-sandbox',
    text: 'Run each agent turn in a container sandbox on Linux with the same guarantees as macOS ASRT.',
    expected: 'high',
  },
  {
    id: 'plugin-marketplace',
    text: 'Build a plugin marketplace with signed packages, versioning and automatic updates.',
    expected: 'high',
  },
  {
    id: 'collaborative-threads',
    text: 'Add real-time collaborative editing of a thread between two users.',
    expected: 'high',
  },
  {
    id: 'streaming-renderer',
    text: 'Rewrite the markdown renderer to stream incrementally and virtualise very long outputs.',
    expected: 'high',
  },
  {
    id: 'remote-agent-reconnect',
    text: 'Run agents on a remote server and reconnect to them after network drops without losing turns.',
    expected: 'high',
  },
]

export const CATEGORY_CASES: readonly LabelCase<RoadmapCategory>[] = [
  {
    id: 'empty-prompt-crash',
    text: 'The roadmap pane crashes when an item’s prompt is empty.',
    expected: 'bug',
  },
  {
    id: 'duplicate-bubbles',
    text: 'Follow-up bubbles appear twice after switching to another thread and back.',
    expected: 'bug',
  },
  {
    id: 'terminal-focus',
    text: 'The terminal loses keyboard focus after a worktree switch on Linux.',
    expected: 'bug',
  },
  {
    id: 'stale-classifier-key',
    text: 'A classifier connection keeps its old key after its base URL is changed to another vendor.',
    expected: 'bug',
  },
  {
    id: 'theme-flash',
    text: 'Dark mode flashes white on startup before the saved theme loads.',
    expected: 'bug',
  },
  {
    id: 'closed-issues-open',
    text: 'The import picker shows closed issues as open after a refresh.',
    expected: 'bug',
  },
  {
    id: 'copy-line-numbers',
    text: 'Copying a code block also copies its line numbers.',
    expected: 'bug',
  },
  {
    id: 'settings-save-error',
    text: 'Saving settings throws "Setting key not readable" when the proxy field is filled in.',
    expected: 'bug',
  },
  { id: 'roadmap-search', text: 'Add a search box to the roadmap pane.', expected: 'feature' },
  {
    id: 'pin-threads',
    text: 'Let users pin a thread to the top of the sidebar.',
    expected: 'feature',
  },
  {
    id: 'regenerate-title',
    text: 'Add a "Regenerate title" action to the thread menu.',
    expected: 'feature',
  },
  {
    id: 'review-thread-badge',
    text: 'Show the number of open review threads as a badge on the PR chip.',
    expected: 'feature',
  },
  {
    id: 'reorder-roadmap',
    text: 'Allow drag-and-drop reordering of roadmap items.',
    expected: 'feature',
  },
  {
    id: 'auto-run-tests',
    text: 'Add an option to run the test suite automatically after each agent edit.',
    expected: 'feature',
  },
  {
    id: 'paste-images',
    text: 'Support pasting images from the clipboard into the composer.',
    expected: 'feature',
  },
  {
    id: 'probability-hover',
    text: 'Show the classifier’s probability when hovering a roadmap badge.',
    expected: 'feature',
  },
  {
    id: 'offline-mode',
    text: 'Build an offline mode that queues agent requests while disconnected and replays them on reconnect.',
    expected: 'project',
  },
  {
    id: 'component-framework',
    text: 'Migrate the renderer from hand-written DOM helpers to a component framework.',
    expected: 'project',
  },
  {
    id: 'team-workspaces',
    text: 'Add team workspaces with shared roadmaps, per-member permissions and an admin console.',
    expected: 'project',
  },
  {
    id: 'telemetry-pipeline',
    text: 'Introduce opt-in telemetry: consent flow, a local buffer, an upload service and a dashboard.',
    expected: 'project',
  },
  {
    id: 'windows-port',
    text: 'Ship a Windows build with an installer, auto-update and sandbox parity.',
    expected: 'project',
  },
  {
    id: 'planner-executor',
    text: 'Replace the agent loop with a planner/executor architecture and compare it on the benchmarks.',
    expected: 'project',
  },
  {
    id: 'docs-site',
    text: 'Publish a versioned, searchable docs site generated from the repository’s docs.',
    expected: 'project',
  },
  {
    id: 'e2e-encryption',
    text: 'Add end-to-end encryption for threads synced across devices.',
    expected: 'project',
  },
]

export interface CoverageItem {
  id: string
  title: string
  body: string
  /** A pinned issue ref, shown to both backends as context. */
  issue: string
}

export interface CoverageIssue {
  number: number
  title: string
  body: string
  /** The roadmap item that already addresses the issue, or null when none does. */
  expected: { itemId: string; verdict: RoadmapCoverageVerdict } | null
  note?: string
}

/**
 * One roadmap and the open issues checked against it. Issues pinned on an item
 * are left out: the product never asks about them.
 */
export const COVERAGE_ROADMAP: readonly CoverageItem[] = [
  {
    id: 'r-terminal-toggle',
    title: 'Terminal toggle shortcut',
    body: 'Add a keyboard shortcut (Ctrl+`) that shows and hides the terminal pane, and list it in the shortcuts dialog.',
    issue: '',
  },
  {
    id: 'r-theme-flash',
    title: 'Fix theme flash',
    body: 'Apply the saved theme before first paint so dark mode no longer flashes white on startup.',
    issue: '',
  },
  {
    id: 'r-roadmap-csv',
    title: 'Roadmap CSV export',
    body: 'Add a CSV export of roadmap items with title, status, complexity, category and pinned issue.',
    issue: '',
  },
  {
    id: 'r-retry-fetch',
    title: 'Retry issue fetch',
    body: 'Retry a failed GitHub issue fetch once in the import picker, then show the error inline instead of a dialog.',
    issue: '',
  },
  {
    id: 'r-pin-threads',
    title: 'Thread pinning',
    body: 'Let users pin threads to the top of the sidebar and keep the pins per project.',
    issue: '',
  },
  {
    id: 'r-follow-up-toggle',
    title: 'Follow-up toggle',
    body: 'Add a Settings toggle that turns off the follow-up suggestion bubbles under the composer.',
    issue: '',
  },
  {
    id: 'r-worktree-focus',
    title: 'Worktree focus',
    body: 'Restore terminal focus after switching worktrees on Linux.',
    issue: '#88',
  },
  {
    id: 'r-sqlite',
    title: 'SQLite threads',
    body: 'Move thread storage to SQLite with a migration for existing threads.',
    issue: '',
  },
  {
    id: 'r-paste-images',
    title: 'Clipboard images',
    body: 'Support pasting images into the composer from the clipboard.',
    issue: '',
  },
  {
    id: 'r-footer-usage',
    title: 'Usage in footer',
    body: 'Show the current thread’s input and output token counts in the footer tooltip.',
    issue: '',
  },
]

export const COVERAGE_ISSUES: readonly CoverageIssue[] = [
  {
    number: 101,
    title: 'Dark mode flashes white when launching',
    body: 'Every launch shows a white window for half a second before the dark theme applies.',
    expected: { itemId: 'r-theme-flash', verdict: 'likely' },
  },
  {
    number: 102,
    title: 'Keyboard shortcut to show/hide the terminal',
    body: 'I keep reaching for the mouse to open the terminal. A shortcut would help.',
    expected: { itemId: 'r-terminal-toggle', verdict: 'likely' },
  },
  {
    number: 103,
    title: 'Export the roadmap',
    body: 'I would like to export the roadmap to CSV and to JSON so I can share it and script against it.',
    expected: { itemId: 'r-roadmap-csv', verdict: 'partial' },
    note: 'The item covers CSV but not JSON.',
  },
  {
    number: 104,
    title: 'Paste screenshots into the chat',
    body: 'Cmd+V with a screenshot on the clipboard does nothing in the message box.',
    expected: { itemId: 'r-paste-images', verdict: 'likely' },
  },
  {
    number: 105,
    title: 'Import picker shows a scary error on a transient 502',
    body: 'GitHub returned a 502 once and the picker showed a blocking error dialog. Retrying worked.',
    expected: { itemId: 'r-retry-fetch', verdict: 'likely' },
  },
  {
    number: 106,
    title: 'Pin important threads and colour-code them',
    body: 'I want to pin a few threads to the top and give each a colour.',
    expected: { itemId: 'r-pin-threads', verdict: 'partial' },
    note: 'Pinning is covered; colours are not.',
  },
  {
    number: 107,
    title: 'Crash when opening Settings with no network',
    body: 'Offline, opening Settings shows a blank dialog and the console logs a TypeError.',
    expected: null,
  },
  {
    number: 108,
    title: 'Show the cost of each thread in dollars',
    body: 'I want to see how much each conversation cost, not just tokens.',
    expected: { itemId: 'r-footer-usage', verdict: 'partial' },
    note: 'Token counts are the input to cost but leave the dollar figure undone.',
  },
  {
    number: 109,
    title: 'Vim keybindings in the editor',
    body: 'Please add a Vim mode to the file editor.',
    expected: null,
  },
  {
    number: 110,
    title: 'Turn off the suggestion chips under the composer',
    body: 'The little suggestion buttons after each reply are distracting. Let me hide them.',
    expected: { itemId: 'r-follow-up-toggle', verdict: 'likely' },
  },
]

export interface FollowUpCase {
  id: string
  context: FollowUpContext
  /** Presets that must be offered. */
  required: readonly string[]
  /** Presets that may be offered without counting against the answer. */
  allowed?: readonly string[]
  note?: string
}

export const FOLLOW_UP_CASES: readonly FollowUpCase[] = [
  {
    id: 'fixed-failing-test',
    context: {
      userMessage: 'Fix the failing login test.',
      assistantMessage:
        'The test timed out because the retry loop never backed off. I added exponential back-off in auth.ts and updated login.test.ts to expect it.',
      toolNames: ['read_file', 'edit_file'],
    },
    required: ['run-tests'],
  },
  {
    id: 'explained-concept',
    context: {
      userMessage: 'What does the permission gate do?',
      assistantMessage:
        'It decides whether a shell command may run: commands inside the sandbox run, commands that reach outside prompt you, and a classifier can screen them when no OS sandbox is available.',
      toolNames: ['read_file'],
    },
    required: [],
  },
  {
    id: 'refactor-in-progress',
    context: {
      userMessage: 'Split the settings dialog into separate panels.',
      assistantMessage:
        'I have moved Account and Billing into their own panels. Security is still in the old dialog; I will do that next.',
      toolNames: ['edit_file', 'write_file'],
    },
    required: ['continue'],
    allowed: ['run-tests'],
  },
  {
    id: 'feature-implemented',
    context: {
      userMessage: 'Implement CSV export for the roadmap.',
      assistantMessage:
        'Done. I added exportRoadmapCsv() in roadmap-export.ts and a "Export CSV" menu entry that calls it.',
      toolNames: ['write_file', 'edit_file'],
    },
    required: ['run-tests'],
    allowed: ['explain'],
  },
  {
    id: 'thanks',
    context: {
      userMessage: 'Thanks, that is all for now!',
      assistantMessage: 'You’re welcome.',
      toolNames: [],
    },
    required: [],
  },
  {
    id: 'large-refactor',
    context: {
      userMessage: 'Refactor the agent loop so tool execution is its own module.',
      assistantMessage:
        'I extracted tool execution into tool-executor.ts and updated 14 call sites across the agent loop, hooks and subagents.',
      toolNames: ['read_file', 'edit_file', 'write_file'],
    },
    required: ['run-tests'],
    allowed: ['explain'],
  },
  {
    id: 'tests-already-run',
    context: {
      userMessage: 'Run the tests.',
      assistantMessage: 'All 312 tests passed in 41 seconds.',
      toolNames: ['run_shell'],
    },
    required: [],
    note: 'Running the tests again is not a next step.',
  },
  {
    id: 'plan-step-done',
    context: {
      userMessage: 'Start on step 1 of the migration plan.',
      assistantMessage:
        'Step 1 is done: the new schema and its types are in place. Steps 2 to 4 (backfill, switch reads, remove the old table) remain.',
      toolNames: ['write_file', 'edit_file'],
    },
    required: ['continue'],
    allowed: ['run-tests'],
  },
  {
    id: 'diagnosed-ci',
    context: {
      userMessage: 'Why is CI red?',
      assistantMessage: 'The lint job fails on an unused import of `join` in src/main/foo.ts.',
      toolNames: ['read_file'],
    },
    required: [],
    allowed: ['continue'],
    note: 'Fixing the import is a reasonable next step but not one of the presets’ meanings.',
  },
  {
    id: 'readme-section',
    context: {
      userMessage: 'Add an "Installing" section to the README.',
      assistantMessage: 'Added an "Installing" section to README.md covering pnpm and Node 24.',
      toolNames: ['edit_file'],
    },
    required: [],
  },
  {
    id: 'typo-fix',
    context: {
      userMessage: 'Fix the typo in the error message.',
      assistantMessage: 'Changed "recieve" to "receive" in src/shared/errors.ts.',
      toolNames: ['edit_file'],
    },
    required: [],
    allowed: ['run-tests'],
  },
  {
    id: 'performance-rewrite',
    context: {
      userMessage: 'Speed up the file search.',
      assistantMessage:
        'I rewrote the index builder to use a trie and changed six files. Results should be the same, about 4x faster.',
      toolNames: ['read_file', 'edit_file'],
    },
    required: ['run-tests'],
    allowed: ['explain'],
  },
  {
    id: 'plan-drafted',
    context: {
      userMessage: 'Draft a plan for offline mode.',
      assistantMessage:
        'Here is a five-step plan: 1. queue requests, 2. persist the queue, 3. detect reconnection, 4. replay, 5. surface conflicts. Shall I start on step 1?',
      toolNames: [],
    },
    required: ['continue'],
  },
  {
    id: 'dead-code-removed',
    context: {
      userMessage: 'Delete the unused helpers in utils.ts.',
      assistantMessage: 'Removed three unused functions from src/shared/utils.ts.',
      toolNames: ['edit_file'],
    },
    required: [],
    allowed: ['run-tests'],
  },
]

export interface FitCase {
  id: string
  issue: { number: number; title: string; body: string }
  prompt: string
  expected: RoadmapFit
  note?: string
}

export const FIT_CASES: readonly FitCase[] = [
  {
    id: 'worktree-focus',
    issue: {
      number: 201,
      title: 'Terminal loses focus after switching worktrees on Linux',
      body: 'Switch worktree, then type: keystrokes go nowhere until I click the terminal.',
    },
    prompt:
      'After switching worktrees, restore keyboard focus to the terminal pane on Linux. Add an e2e test that switches worktrees and types into the terminal.',
    expected: 'likely',
  },
  {
    id: 'roadmap-csv',
    issue: {
      number: 202,
      title: 'Add CSV export for the roadmap',
      body: 'A CSV with title, status and category would let me paste the roadmap into a sheet.',
    },
    prompt:
      'Add a CSV export of all roadmap items with title, status, complexity and category, available from the roadmap menu.',
    expected: 'likely',
  },
  {
    id: 'settings-search',
    issue: {
      number: 203,
      title: 'Settings search does not match section descriptions',
      body: 'Searching "redact" finds nothing, although the Classifiers description mentions redaction.',
    },
    prompt:
      'Make the Settings search match section description text as well as titles, and add a unit test.',
    expected: 'likely',
  },
  {
    id: 'classifier-key',
    issue: {
      number: 204,
      title: 'Classifier key survives a base URL change',
      body: 'Changing a connection to another vendor kept the old vendor’s key attached.',
    },
    prompt:
      'When a classifier connection’s base URL, protocol or authentication changes, delete its saved key before saving the new settings. Add a test.',
    expected: 'likely',
  },
  {
    id: 'csv-and-json',
    issue: {
      number: 205,
      title: 'Export the roadmap as CSV and JSON',
      body: 'I need CSV for spreadsheets and JSON for scripts.',
    },
    prompt: 'Add a CSV export of roadmap items.',
    expected: 'partial',
  },
  {
    id: 'toggle-and-dismissals',
    issue: {
      number: 206,
      title: 'Follow-up bubbles: add an off switch and remember dismissals',
      body: 'Let me turn the bubbles off, and when I dismiss one in a thread it should stay dismissed.',
    },
    prompt: 'Add a Settings toggle that turns off follow-up bubbles.',
    expected: 'partial',
  },
  {
    id: 'retry-and-rate-limit',
    issue: {
      number: 207,
      title: 'Import picker: retry transient errors and show the rate-limit reset time',
      body: 'Retry 5xx errors, and on a 403 rate limit tell me when it resets.',
    },
    prompt: 'Retry a failed GitHub issue fetch once before showing the error.',
    expected: 'partial',
  },
  {
    id: 'pin-and-reorder',
    issue: {
      number: 208,
      title: 'Pin threads and reorder the pinned ones',
      body: 'Pinning is not enough: I want to drag pinned threads into my own order.',
    },
    prompt: 'Let users pin threads to the top of the sidebar.',
    expected: 'partial',
  },
  {
    id: 'theme-flash-vs-contrast',
    issue: {
      number: 209,
      title: 'Dark mode flashes white on startup',
      body: 'The window is white for half a second before the theme applies.',
    },
    prompt: 'Add a high-contrast theme option to Appearance settings.',
    expected: 'unlikely',
  },
  {
    id: 'offline-crash-vs-spinner',
    issue: {
      number: 210,
      title: 'Crash when opening Settings offline',
      body: 'Offline, Settings opens blank and the console shows a TypeError.',
    },
    prompt: 'Make the loading spinner in Settings animate more smoothly.',
    expected: 'unlikely',
  },
  {
    id: 'paste-newlines-vs-copy',
    issue: {
      number: 211,
      title: 'Terminal paste inserts extra newlines on Windows',
      body: 'Pasting a multi-line command doubles every line break.',
    },
    prompt: 'Add a copy button to terminal output blocks.',
    expected: 'unlikely',
  },
  {
    id: 'review-eager-vs-csv',
    issue: {
      number: 212,
      title: 'Roadmap review marks items resolved too eagerly',
      body: 'Items with only a closed issue and no commits get "resolved".',
    },
    prompt: 'Add a CSV export to the roadmap pane.',
    expected: 'unlikely',
  },
]

export interface ReviewCase {
  id: string
  item: { body: string; status: string | null; fields: Record<string, string> }
  pinned: { number: number; title: string; body: string; state: 'open' | 'closed' } | null
  linked: readonly { number: number; title: string; state: 'open' | 'closed' }[]
  /** `git log --oneline` for the review window. */
  commits: string
  expected: RoadmapReviewVerdict
  note?: string
}

export const REVIEW_CASES: readonly ReviewCase[] = [
  {
    id: 'csv-shipped',
    item: {
      body: 'Add a CSV export of roadmap items.',
      status: 'ready',
      fields: { issue: '#301' },
    },
    pinned: {
      number: 301,
      title: 'Roadmap CSV export',
      body: 'Export the roadmap as CSV.',
      state: 'closed',
    },
    linked: [],
    commits:
      'a1b2c3d feat(roadmap): add CSV export of roadmap items (#301)\ne4f5a6b test(roadmap): cover CSV export columns',
    expected: 'resolved',
  },
  {
    id: 'theme-flash-fixed',
    item: {
      body: 'Apply the saved theme before first paint so dark mode no longer flashes white.',
      status: 'in-progress',
      fields: { issue: '#302' },
    },
    pinned: { number: 302, title: 'Dark mode flashes white on startup', body: '', state: 'closed' },
    linked: [],
    commits: '9f8e7d6 fix(theme): apply the saved theme before first paint (closes #302)',
    expected: 'resolved',
  },
  {
    id: 'terminal-shortcut-shipped',
    item: {
      body: 'Add a keyboard shortcut that toggles the terminal pane and list it in the shortcuts dialog.',
      status: 'ready',
      fields: {},
    },
    pinned: null,
    linked: [],
    commits:
      '1a2b3c4 feat(terminal): add Ctrl+` to toggle the terminal pane\n5d6e7f8 docs(shortcuts): list the terminal toggle',
    expected: 'resolved',
    note: 'No issue, but the commits state both halves of the prompt.',
  },
  {
    id: 'retry-issue-open',
    item: {
      body: 'Retry a failed GitHub issue fetch once in the import picker.',
      status: 'ready',
      fields: { issue: '#304' },
    },
    pinned: { number: 304, title: 'Retry transient issue fetch errors', body: '', state: 'open' },
    linked: [],
    commits: '3c4d5e6 fix(import): retry the issue fetch on 5xx responses',
    expected: 'likely',
    note: 'The commit matches, but the issue is still open.',
  },
  {
    id: 'usage-tooltip',
    item: {
      body: 'Show the current thread’s token usage in the footer tooltip.',
      status: 'ready',
      fields: {},
    },
    pinned: null,
    linked: [],
    commits: '7a8b9c0 feat(footer): usage tooltip lists input and output tokens',
    expected: 'likely',
    note: 'Probably this item, but the commit does not say it is per thread.',
  },
  {
    id: 'clearer-import-errors',
    item: {
      body: 'Make the import picker’s error message name the repository that failed.',
      status: 'ready',
      fields: {},
    },
    pinned: null,
    linked: [],
    commits: '8c9d0e1 fix(import): clearer error messages in the picker',
    expected: 'likely',
    note: '"Clearer" suggests it, but naming the repository is not confirmed.',
  },
  {
    id: 'csv-without-json',
    item: {
      body: 'Export the roadmap as CSV and JSON.',
      status: 'ready',
      fields: { issue: '#307' },
    },
    pinned: { number: 307, title: 'CSV and JSON export', body: '', state: 'open' },
    linked: [],
    commits: 'a1b2c3d feat(roadmap): add CSV export',
    expected: 'partial',
  },
  {
    id: 'toggle-without-dismissals',
    item: {
      body: 'Add a Settings toggle for follow-up bubbles, and remember dismissed bubbles per thread.',
      status: 'in-progress',
      fields: {},
    },
    pinned: null,
    linked: [],
    commits: '6d7e8f9 feat(settings): toggle to hide follow-up bubbles',
    expected: 'partial',
  },
  {
    id: 'sqlite-behind-flag',
    item: {
      body: 'Move thread storage to SQLite with a migration for existing threads.',
      status: 'in-progress',
      fields: {},
    },
    pinned: null,
    linked: [{ number: 309, title: 'SQLite migration for existing threads', state: 'open' }],
    commits:
      'b2c3d4e feat(store): SQLite thread store behind a flag\nc3d4e5f wip: migration scaffolding',
    expected: 'partial',
  },
  {
    id: 'vim-untouched',
    item: {
      body: 'Add Vim keybindings to the file editor.',
      status: 'ready',
      fields: { issue: '#310' },
    },
    pinned: { number: 310, title: 'Vim mode', body: 'Please add Vim keybindings.', state: 'open' },
    linked: [],
    commits: 'f1e2d3c fix(ci): pin Node to 24.20.0\n0a9b8c7 chore(deps): bump esbuild',
    expected: 'open',
  },
  {
    id: 'no-commits',
    item: { body: 'Support pasting images into the composer.', status: 'ready', fields: {} },
    pinned: null,
    linked: [],
    commits: '(no commits in this window)',
    expected: 'open',
  },
  {
    id: 'design-notes-only',
    item: { body: 'Add end-to-end encryption for synced threads.', status: 'ready', fields: {} },
    pinned: null,
    linked: [],
    commits: 'd4c3b2a docs: design notes for end-to-end encryption',
    expected: 'open',
    note: 'Design notes are not the work.',
  },
]
