/**
 * The renderer ↔ main API protocol version (issue #2312, step 1).
 *
 * The renderer only ever talks to the main process through `ApiClient`
 * (`src/preload/api.d.ts`); the preload binds each method to an IPC channel and
 * the sidecar's WebSocket bridge carries the same channels over a socket. That
 * surface is frozen as a generated protocol: a committed channel manifest
 * (`schemas/api-protocol.manifest.json`, `pnpm run gen:api-protocol`) and the
 * full JSON Schema the build emits; this is the version stamped into both.
 *
 * Bump it only for a backward-incompatible change to the surface: a channel or
 * method removed or renamed, an argument added or made required (hosts validate
 * their arguments as a closed tuple), a result shape narrowed. Purely additive
 * changes (a new channel, a new optional result field) keep the version and only
 * regenerate the schema. `scripts/gen-api-protocol.mts
 * --compare-ref <git-ref>` classifies a diff against a committed schema.
 *
 * A version names a released surface, so a breaking change needs a version
 * above the latest release (or a pending promotion that carries an untagged
 * version), and every breaking change between two releases shares one bump.
 * When trunk already carries an unreleased bump, leave this alone; otherwise set
 * it to one more than the release's. Describe the change in the pull request
 * rather than on a line below, so concurrent pull requests make the same
 * one-line edit (or none) and merge cleanly instead of each claiming the next
 * number and renumbering whenever another lands. The per-version lines below
 * predate that rule.
 *
 * A transport that connects a client and server built separately — today the
 * sidecar WebSocket bridge, later a daemon — exchanges this number in its
 * handshake and refuses a peer that speaks a different one rather than letting
 * mismatched shapes reach the handler table.
 *
 * Before `compareApiProtocol` compared each shape in the direction its data
 * travels (docs/api-protocol.md), it compared whole resolved shapes and could
 * not tell an added optional result field from a breaking change. So the bumps
 * below marked "conservatively" (starting with v3, `lm-studio:model-info`'s
 * optional `embedding`, #2487) versioned additive changes, which no longer need
 * one.
 */
// v4 adds bounded PR activity results; v5 adds nested-instruction metadata.
// Both conservatively version optional result fields for the whole-shape gate.
// v6 conservatively versions the optional file-reference task owner shape.
// v7 versions task ownership in browser session and canvas payloads.
// v8 versions the expanded supervisor task summaries and recovery API.
// v9 versions Android device kinds and input in the simulator desktop API.
// v10 conservatively versions optional local-device presentation intent.
// v11 versions the instruction-source contributions exposed in plugin summaries.
// v12 conservatively versions optional tier-pricing fallback metadata in usage summaries.
// v13 retires the model-comparison channels (`agent:comparison-models`,
// `agent:retry-comparison`), drops the comparison models from `approval:respond`,
// and replaces the `model_comparison` chunk with `review_report` (copse.review).
// v14 versions ACP rich-content blocks on streamed agent chunks.
// v15 conservatively versions the optional macOS trustd grant in ACP agent discovery.
// v16 conservatively versions the optional post-turn review follow-up note on agent chunks.
// v17 conservatively versions the optional release changelog on update prompts.
// v20 conservatively versions the optional appended system-reminder lengths on tool
// results (`tool_result` chunks and thread tool calls). v18 and v19 are claimed by
// open PRs, so this skips them to avoid a collision whichever lands first.
// v21 conservatively versions the optional Copse Reviewer report initiator on
// thread payloads and `review_report` chunks.
// v22 versions mobile-device decision actors and the resulting decisions:list shape.
// v27 conservatively versions schedule-scoped automation permissions in list/upsert
// payloads. v22–v26 are claimed by open PRs, so this skips them to avoid collisions.
// v28 versions the orphan-store sample titles and last-updated time on `threads:list-orphans`.
// v29 versions persisted reviewer-input answers on thread payloads.
// v30 conservatively versions the optional `userAbort` cause on cancelled turn
// outcomes and the optional folded-subagent token counts on usage deltas.
// v31 conservatively versions the optional API format on custom provider records.
// v32 versions automation worktree-limit status in list/upsert payloads.
// v33 versions machine-turn dispatch and its chunk metadata.
// v34 versions the per-model availability shape returned by `usage:get-plan-usage`.
// v35 conservatively versions optional malformed-tool-call metadata on streamed chunks.
// v36 versions the Apple container attestation (engine, isolation, process limit, and the
// `none` security profile) on container runs.
// v37 conservatively versions the optional `verbosity` field on turn model parameters.
// v38 conservatively versions interrupted-turn recovery metadata.
// v39 versions the automation lastProblem ledger and startFailedAt provenance.
// v40 versions the queued-message model snapshot in thread payloads.
// v41 versions container-run consent fields and terminal state.
// v42 conservatively versions the persisted sidebar grouping in settings payloads.
// v43 versions the optional OAuth `auth` state on MCP server statuses.
// v45 conservatively versions deferred thread worktrees: the optional `deferredWorktree` on
// threads and prepared checkouts, the `on-write` project mode, and the `thread_checkout`
// agent chunk.
// v46 versions the removal of `activeRunThreadIds` from the process-manager snapshot.
// v47 conservatively versions optional PR/commit production evidence on thread payloads.
// v48 conservatively versions retained-worktree blockers on automation schedules and triggers.
// v49 versions saved-model invalidation reports and guarded recovery IPC.
// v50 versions skill-source diagnostics and validated extra-root updates.
// v51 versions the context_compacted agent chunk (OpenAI server-side compaction).
// v52 versions the OpenAI remote-agent provider in thread and agent-PR-link payloads.
// v53 versions agentBusy on worktree attachment status.
// v54 versions event automation shapes.
// v55 versions host-owned container authentication.
// v56 versions threads:archive stopProcesses and blocked-running live-work reports.
// v57 versions approval effect, boundary, and grant-scope details.
export const API_PROTOCOL_VERSION = 57 as const
