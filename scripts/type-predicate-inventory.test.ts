import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertedPredicateInventory } from './lib/type-predicates.mts'

/**
 * The standing inventory of hand-written type predicates, and the ratchet that
 * keeps it shrinking.
 *
 * A type predicate is an `as` cast wearing nicer syntax: TypeScript does not
 * check that `x is T` follows from the body, and `no-unsafe-type-assertion`
 * does not flag it, so with `any`, `!` and the suppression baseline all at zero
 * these are the widest unverified claims left in the codebase (#1330). #1330's
 * own follow-up recorded the failure mode this file exists to stop — the
 * population grew from 161 to 212 while the contract tests covered 15 — so
 * counting them once was never going to be enough.
 *
 * Only the ASSERTED form is listed. Three shapes are not, because none of them
 * leaves an unverified claim at the site where it is written:
 *
 *   const isFoo: (v: unknown) => v is Foo = (v) => typeof v === 'string'
 *   const isTheme = memberOf(THEME_PREFERENCES)
 *   xs.filter((x) => typeof x === 'string')
 *
 * The first is checked by `tsc`: it infers the arrow's own predicate and
 * reports TS2677 when the body stops proving the claim. The second has no
 * assertion of its own — the single one it is built from lives in `@copse/std`
 * and is property-tested there. The third asserts nothing at all; the compiler
 * derived the predicate, and if the body stops narrowing the call site quietly
 * gets a wider type rather than a lie.
 *
 * See `docs/type-safety.md` for which body shapes TypeScript can actually infer
 * from — it is a narrower set than it sounds, which is why this list is long.
 *
 * ## Adding a predicate
 *
 * Reach for a checked form first; none of them appear here. If the predicate
 * genuinely has to be asserted (a structural boundary parser usually does),
 * add it to the list and give it a contract test in the same PR, as
 * `docs/type-safety.md` requires.
 *
 * ## Removing one
 *
 * The second test fails on a stale entry, so converting a predicate forces its
 * line out of this list in the same change — the list can only shrink.
 * `main` carried 230 of these in 137 files before this ratchet landed.
 */
const ASSERTED_PREDICATES: Readonly<Record<string, readonly string[]>> = {
  'packages/agent/src/hooks/inject-context.ts': ['(anonymous)'],
  'packages/agent/src/plugins/agent-plugin-manifest.ts': ['isRecord'],
  'packages/agent/src/run-subagent.ts': ['hasLastUsage'],
  'packages/hooks-dialects/src/command-hook-runner.ts': [
    'isAfterDiffApplyPayload',
    'isAfterFileEditPayload',
    'isAfterToolUsePayload',
    'isBeforeDiffApplyPayload',
    'isBeforeSubmitPromptPayload',
    'isPermissionDecisionPayload',
    'isPostTurnReviewPayload',
    'isSessionStartPayload',
    'isStopPayload',
    'isSubagentStartPayload',
    'isSubagentStopPayload',
    'isToolGatePayload',
  ],
  'packages/hooks-dialects/src/copse-adapter.ts': ['(anonymous)'],
  'packages/hooks-dialects/src/cursor-adapter.ts': ['(anonymous)', '(anonymous)', '(anonymous)'],
  'packages/llm/src/agent-model-identity.ts': ['(anonymous)'],
  'packages/llm/src/create-provider.ts': ['isServerSideTool'],
  'packages/llm/src/lm-studio-provider.ts': ['isRecord'],
  'packages/llm/src/model-pricing.ts': ['isRecord'],
  'packages/llm/src/stream-retry.ts': ['isRecord'],
  'packages/plugin-sdk/src/plugin-model-turn.ts': ['(anonymous)', '(anonymous)'],
  'packages/std/src/member-of.ts': ['(anonymous)'],
  'packages/std/src/unknown-value.ts': ['(anonymous)', 'isRecord', 'matchesFallbackType'],
  'packages/thread-store/src/decision-log.ts': ['isRecord'],
  'packages/thread-store/src/deferred-approval.ts': ['isDeferredApproval', 'isRecord'],
  'packages/thread-store/src/export-jsonl.ts': ['threadHasExportableContent'],
  'packages/thread-store/src/fold.ts': ['isToolArgsBlobRef'],
  'packages/thread-store/src/hook-card.ts': ['(anonymous)'],
  'packages/thread-store/src/spine-schema.ts': [
    'isContentRef',
    'isRecord',
    'isSpineDecisionLine',
    'isSpineHookRunLine',
    'isSpineMachineContinuationLine',
    'isSpineMessageLine',
    'isSpineModelSelectedLine',
    'isSpinePermissionDecisionLine',
    'isSpinePlanLine',
    'isTurnOutcome',
  ],
  'packages/thread-store/src/thread-boundary.ts': ['(anonymous)', '(anonymous)'],
  'packages/thread-store/src/thread-proposal.ts': ['(anonymous)'],
  'packages/thread-store/src/thread-store.ts': [
    '(anonymous)',
    '(anonymous)',
    'isAgentHistoryMessage',
  ],
  'scripts/gen-headless-schema.mts': ['isSchemaModule'],
  'scripts/hook-file-check.mts': ['(anonymous)'],
  'scripts/lib/api-protocol.mts': [
    '(anonymous)',
    'isObjectType',
    'isTupleTarget',
    'isTypeReference',
  ],
  'scripts/lib/benchmark-catalog.mts': ['(anonymous)'],
  'scripts/lib/cloud-hosts.mts': ['isRecord'],
  'scripts/lib/edited-file-check.mts': ['(anonymous)', 'isRecord'],
  'scripts/lib/skillsbench-profiles.mts': ['isSkillsBenchProfileId'],
  'scripts/lib/terminal-bench-profiles.mts': ['isVersionedProfileId'],
  'scripts/lib/terminal-bench-steering.mts': ['nonEmptyString'],
  'scripts/lib/terminal-bench-task-image.mts': ['(anonymous)', 'isRecord'],
  'scripts/lib/terminal-bench-tasks.mts': ['isRecord'],
  'scripts/perf-report.mts': ['isRecord'],
  'scripts/skillsbench-agent-lib.mts': ['isInputMessage', 'isRecord'],
  'scripts/sync-intellect.mts': ['(anonymous)', '(anonymous)', 'isIsoDate'],
  'scripts/sync-local-models.mts': ['isIsoDate'],
  'scripts/terminal-bench-agent-lib.mts': ['isInputMessage'],
  'src/main/services/acp/acp-approval-presentation.ts': ['(anonymous)', 'isRecord'],
  'src/main/services/acp/session-update-adapter.ts': [
    '(anonymous)',
    '(anonymous)',
    'isUnknownRecord',
  ],
  'src/main/services/agent-errors.ts': ['(anonymous)', '(anonymous)', 'isJsonRpcError'],
  'src/main/services/agent-service.ts': ['(anonymous)', '(anonymous)'],
  'src/main/services/automations/automation-service.ts': ['isSchedule'],
  'src/main/services/diagnostics/perf-ipc.ts': ['isDetail'],
  'src/main/services/discovery/yaml-frontmatter.ts': ['(anonymous)'],
  'src/main/services/github/backend/gh-cli-backend.ts': [
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
  ],
  'src/main/services/github/backend/github-api-backend.ts': [
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
  ],
  'src/main/services/github/backend/github-graphql-prs.ts': ['(anonymous)'],
  'src/main/services/github/git-service.ts': ['(anonymous)', '(anonymous)', '(anonymous)'],
  'src/main/services/github/github-ci-service.ts': ['(anonymous)'],
  'src/main/services/mcp/custom-tools-config.ts': ['isRawExecute'],
  'src/main/services/mcp/custom-tools-registry.ts': ['isDynamicImport', 'isToolFactory'],
  'src/main/services/plan-usage-bridge.ts': ['isRecord'],
  'src/main/services/plugins/plugin-service.ts': ['isRecord'],
  'src/main/services/plugins/plugin-thread-session-store.ts': ['isRecord'],
  'src/main/services/providers/aa-live-intellect.ts': ['(anonymous)', '(anonymous)'],
  'src/main/services/providers/env-key-detection.ts': ['(anonymous)'],
  'src/main/services/providers/llm-complete-text.ts': ['hasLastUsage'],
  'src/main/services/providers/provider-usage.ts': ['hasLastUsage'],
  'src/main/services/remote/cursor-agent-discovery.ts': ['isUnknownRecord'],
  'src/main/services/remote/remote-agent-client.ts': ['(anonymous)'],
  'src/main/services/search/semantic-index.ts': [
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
    '(anonymous)',
  ],
  'src/main/services/search/worktree-semantic-overlay.ts': ['(anonymous)'],
  'src/main/services/security/pii-redactor.ts': ['isCreateGuard'],
  'src/main/services/security/workspace-trust.ts': ['(anonymous)'],
  'src/main/services/ssh-workspace/execution-target.ts': ['(anonymous)'],
  'src/main/services/storage/knowledge-store.ts': ['isIndexRecord'],
  'src/main/services/storage/settings-writable.ts': ['isRendererWritableSettingKey'],
  'src/main/services/storage/settings.test-shim.ts': ['schemaAccepts'],
  'src/main/services/storage/settings.ts': ['isStoredKey', 'schemaAccepts'],
  'src/main/services/thread-checkout-transaction.ts': ['(anonymous)'],
  'src/main/services/todo-worker-runner.ts': ['hasLastUsage'],
  'src/main/services/vnc/vnc-username-store.ts': ['isStoredVncUsername'],
  'src/main/services/workspace.ts': ['(anonymous)', '(anonymous)'],
  'src/main/services/worktree-inventory.ts': ['(anonymous)'],
  'src/main/services/worktree-manager.ts': ['assertWorktreeMetadata'],
  'src/main/tools/file-tools.ts': ['(anonymous)', '(anonymous)'],
  'src/renderer/popout/pane-popout-seed.ts': ['isPopoutSeedEnvelope'],
  'src/renderer/ui/actions.ts': ['isUiActionsOptions'],
  'src/renderer/ui/cx.ts': ['(anonymous)'],
  'src/renderer/views/approval-dialog.ts': ['(anonymous)'],
  'src/renderer/views/ask-user-dialog.ts': ['(anonymous)'],
  'src/renderer/views/browser-pane.ts': ['isBrowserPopoutSeed'],
  'src/renderer/views/composer-editor.ts': ['(anonymous)'],
  'src/renderer/views/conversation.ts': ['(anonymous)'],
  'src/renderer/views/git-changes-pane.ts': ['isChangeSelection'],
  'src/renderer/views/model-options.ts': ['(anonymous)'],
  'src/renderer/views/model-picker.ts': ['(anonymous)'],
  'src/renderer/views/panel-mode-controls.ts': ['(anonymous)'],
  'src/renderer/views/roadmap-pane.ts': ['(anonymous)'],
  'src/renderer/views/settings-dialog.ts': ['(anonymous)'],
  'src/renderer/views/tool-args-format.ts': ['isRecord'],
  'src/shared/diff/staged-diff-ui.ts': ['shouldJumpToProposed'],
  'src/shared/git/sync-thread-branch.ts': ['threadGitBranchNeedsSync'],
  'src/shared/knowledge/attachments.ts': ['isAttachment'],
  'src/shared/managed-agents-stream.ts': ['(anonymous)'],
  'src/shared/todos/todo-context.ts': ['isRecord'],
  'src/shared/todos/todo-logic.ts': ['(anonymous)'],
  'src/shared/usage/plan-window-history.ts': ['isRecord'],
}

/** Flat `file#name` labels, sorted, for a readable assert diff. */
function labels(inventory: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(inventory)
    .flatMap(([file, names]) => names.map((name) => `${file}#${name}`))
    .sort()
}

function scanned(): Record<string, readonly string[]> {
  return Object.fromEntries(assertedPredicateInventory())
}

describe('type predicate inventory', () => {
  it('has no hand-written predicate that is not on the list', () => {
    const expected = labels(ASSERTED_PREDICATES)
    const added = labels(scanned()).filter((label) => !expected.includes(label))
    assert.deepEqual(
      added,
      [],
      'A new hand-written type predicate appeared. TypeScript does not check that ' +
        'its body proves `x is T`, so it is an unaudited `as`. Prefer a form the ' +
        'compiler checks — `memberOf(TUPLE)` for a membership test, ' +
        '`const isX: (v: A) => v is B = (v) => …` for a narrowing one, or no ' +
        'annotation at all inside `.filter(…)`. If it genuinely has to be asserted, ' +
        'add it to ASSERTED_PREDICATES above and give it a contract test in the same ' +
        'PR (docs/type-safety.md).',
    )
  })

  it('drops an entry as soon as its predicate is gone', () => {
    const live = labels(scanned())
    const stale = labels(ASSERTED_PREDICATES).filter((label) => !live.includes(label))
    assert.deepEqual(
      stale,
      [],
      'These entries no longer match a hand-written predicate — delete them. The ' +
        'list is a shrink-only ratchet: leaving a stale line behind makes the ' +
        'unverified surface look bigger than it is, and lets a later PR re-add a ' +
        'predicate under cover of an entry that was already spent.',
    )
  })
})
