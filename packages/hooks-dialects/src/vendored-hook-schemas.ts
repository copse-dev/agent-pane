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
 * Cursor events Copse **recognises as real** but does not wire — the Cursor
 * counterpart to {@link CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS}.
 *
 * Why this is separate from {@link CURSOR_INTENTIONALLY_UNSUPPORTED_EVENTS}:
 * that list is scoped to the *vendored community pin* (`cursor-hooks@1.1.5`),
 * which publishes only 6 events and lags Cursor's own docs badly. Without this
 * second tier the adapter had no way to tell "a real Cursor event we don't act
 * on" from "a typo", so **every** unwired Cursor event was reported to the user
 * as `Unknown hook event` — misleading for a config Cursor itself accepts. The
 * Claude side has had that distinction since G3 (`isPublishedClaudeEvent`);
 * this brings Cursor to parity.
 *
 * Provenance: read off Cursor's published hooks documentation (the "Hook
 * categories" and "Hook events" sections of https://cursor.com/docs/hooks),
 * which lists a substantially larger surface than the community pin. They are
 * **not** asserted against any vendored JSON — being on this list changes only
 * the *warning wording*, never whether a hook loads. Re-vendoring a Cursor
 * schema that publishes any of them should move it into the pin-backed lists
 * above.
 *
 * Grouped as Cursor groups them:
 *
 * **Agent hooks** (fire during an agent session, like every event Copse wires):
 * - `sessionEnd` — session teardown; Copse has no canonical session-end event.
 * - `preCompact` — the canonical `compaction` event is typed but has no fire
 *   site. Observational upstream too: it cannot block or alter compaction.
 * - `afterAgentResponse` / `afterAgentThought` — per-assistant-message and
 *   per-reasoning-block observation, neither of which Copse has a fire point
 *   for; `stop` fires once at turn end instead.
 *
 * **Tab hooks** (inline completions) — out of scope by construction, since Copse
 * has no inline-tab surface at all. This is the same reason its matcher table
 * already treats the `TabRead` / `TabWrite` tool types as never-matching:
 * - `beforeTabFileRead` / `afterTabFileEdit`
 *
 * **App lifecycle hooks** (fire outside any agent session):
 * - `workspaceOpen` — fires on workspace open and folder change, and returns
 *   extra plugin paths to load. It is an IDE-lifecycle event with no agent
 *   session attached (Cursor's own docs note its payload omits
 *   `conversation_id` / `generation_id` / `model` entirely), so it has no
 *   natural home in Copse's canonical-event taxonomy.
 */
export const CURSOR_RECOGNISED_UNWIRED_HOOK_EVENTS: readonly string[] = [
  'sessionEnd',
  'preCompact',
  'afterAgentResponse',
  'afterAgentThought',
  'beforeTabFileRead',
  'afterTabFileEdit',
  'workspaceOpen',
]

/**
 * Whether `event` is a Cursor event Copse recognises but does not wire — either
 * published by the vendored pin or listed in
 * {@link CURSOR_RECOGNISED_UNWIRED_HOOK_EVENTS}. Drives the "recognised by
 * Cursor but not supported by Copse yet" wording, distinguishing it from an
 * outright unknown event (likely a typo).
 */
export function isRecognisedCursorEvent(event: string): boolean {
  return (
    (CURSOR_PUBLISHED_HOOK_EVENTS as readonly string[]).includes(event) ||
    CURSOR_RECOGNISED_UNWIRED_HOOK_EVENTS.includes(event)
  )
}

/**
 * Every hook event the pinned **Claude Code** SchemaStore schema publishes (the
 * keys of its `hooks` object). Mirror of
 * `schemas/vendor/claude-code-settings.schema.json`. Copse wires the events whose
 * canonical fire point already exists (`PreToolUse`, `SessionStart`, `PostToolUse`,
 * `UserPromptSubmit`, `Stop`, `SubagentStop`); everything else is intentionally
 * unsupported — see {@link CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS}.
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
 * wire (decision: "Long-tail Claude events (Notification, TeammateIdle, …) —
 * Unsupported-and-reported + G3 drift detector"). Listed **explicitly** (not
 * computed) so the choice is reviewable: the drift detector asserts this list
 * equals the published set minus the wired set, so wiring a new event (or a
 * re-vendored schema dropping one) forces a matching edit here.
 *
 * The events removed from this list are the ones whose **canonical fire point
 * already existed** — Copse was firing `afterToolUse` / `stop` / `subagentStop` /
 * `beforeSubmitPrompt` for Cursor hooks while ignoring the Claude settings that
 * asked for the same moments. The remainder need new plumbing (a fire site, or a
 * canonical event that does not exist yet), which is why they stay here:
 * `PreCompact` has a typed `compaction` event but no fire site, and `SessionEnd`
 * / `Notification` have no canonical event at all.
 */
export const CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS: readonly string[] = [
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'StopFailure',
  'SubagentStart',
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
