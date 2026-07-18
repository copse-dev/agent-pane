// Vendored upstream hook-schema event lists (G3).
//
// Mirrors of the *published event lists* from the pinned, committed upstream
// schemas under `schemas/vendor/` (see `schemas/vendor/README.md` for provenance
// + pins). These TS constants are the runtime-usable form of those vendored
// JSON files: the warn-level authoring lint and the CI drift detector both read
// them, and **neither ever fetches anything over the network** (G3: never
// remote-fetched, warn-only, never a load gate).
//
// The vendored JSON is the source of truth for what upstream publishes; these
// constants are its mirror. `vendor-schema-drift.test.ts` binds the two together
// (asserting the JSON's `hooks` keys equal these lists) so a re-vendored pin that
// adds/removes an event fails CI until the mirror — and the adapter's
// supported/unsupported split — is reconciled.

/** Identifies which upstream schema a published-event list came from (for provenance). */
export interface VendoredSchemaPin {
  /** The dialect family the schema describes. */
  family: 'cursor' | 'claude'
  /** Human-readable upstream name. */
  upstream: string
  /** The committed vendored file, relative to the repo root. */
  vendoredPath: string
  /** The pinned upstream revision/version (documented in the vendor README). */
  pin: string
}

export const CLAUDE_SCHEMA_PIN: VendoredSchemaPin = {
  family: 'claude',
  upstream: 'Claude Code settings (SchemaStore)',
  vendoredPath: 'schemas/vendor/claude-code-settings.schema.json',
  pin: 'SchemaStore last-modified 2026-07-15',
}

export const CURSOR_SCHEMA_PIN: VendoredSchemaPin = {
  family: 'cursor',
  upstream: 'cursor-hooks npm package (community)',
  vendoredPath: 'schemas/vendor/cursor-hooks.schema.json',
  pin: 'cursor-hooks@1.1.5',
}

/**
 * Every hook event the pinned **Cursor** community schema publishes (the keys of
 * its `hooks` object). Mirror of `schemas/vendor/cursor-hooks.schema.json`.
 *
 * The community schema lags Cursor's docs (it lists these 6; Cursor documents
 * more), which is expected for a community pin — our Cursor adapter deliberately
 * knows a **superset** (`CURSOR_HOOK_EVENTS`). The drift detector only requires
 * that each event published *here* is wired or intentionally-unsupported.
 */
export const CURSOR_PUBLISHED_HOOK_EVENTS = [
  'beforeShellExecution',
  'beforeMCPExecution',
  'afterFileEdit',
  'beforeReadFile',
  'beforeSubmitPrompt',
  'stop',
] as const

/**
 * Cursor events the vendored schema publishes that Copse deliberately does **not**
 * wire. Empty today (the community pin publishes only events our adapter already
 * wires); kept as an explicit list so a future re-vendored Cursor schema that adds
 * an event we choose not to support has a documented home instead of tripping the
 * drift detector silently.
 */
export const CURSOR_INTENTIONALLY_UNSUPPORTED_EVENTS: readonly string[] = []

/**
 * Every hook event the pinned **Claude Code** SchemaStore schema publishes (the
 * keys of its `hooks` object). Mirror of
 * `schemas/vendor/claude-code-settings.schema.json`. Copse wires only `PreToolUse`
 * (tool gate) and `SessionStart` (H4); everything else is intentionally
 * unsupported v1 — see {@link CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS}.
 */
export const CLAUDE_PUBLISHED_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'TeammateIdle',
  'TaskCompleted',
  'Setup',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'SessionStart',
  'SessionEnd',
  'PostToolBatch',
  'TaskCreated',
  'PermissionDenied',
  'UserPromptExpansion',
  'MessageDisplay',
] as const

/**
 * Claude events the vendored schema publishes that Copse deliberately does **not**
 * wire in v1 (decision: "Long-tail Claude events (Notification, TeammateIdle, …) —
 * Unsupported-and-reported + G3 drift detector"). Listed **explicitly** (not
 * computed) so the choice is reviewable: the drift detector asserts this list
 * equals the published set minus the wired set, so wiring a new event (or a
 * re-vendored schema dropping one) forces a matching edit here.
 */
export const CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS: readonly string[] = [
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Elicitation',
  'ElicitationResult',
  'TeammateIdle',
  'TaskCompleted',
  'Setup',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'SessionEnd',
  'PostToolBatch',
  'TaskCreated',
  'PermissionDenied',
  'UserPromptExpansion',
  'MessageDisplay',
]

/** Whether `event` is an event the pinned Claude schema publishes (recognised upstream). */
export function isPublishedClaudeEvent(event: string): boolean {
  return (CLAUDE_PUBLISHED_HOOK_EVENTS as readonly string[]).includes(event)
}
