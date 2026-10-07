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
 * method removed or renamed, an argument added in a non-trailing position or
 * made required, a result shape narrowed. Purely additive changes (a new
 * channel, a new optional trailing argument, a new optional result field) keep
 * the version and only regenerate the schema. `scripts/gen-api-protocol.mts
 * --compare-ref <git-ref>` classifies a diff against a committed schema.
 *
 * A transport that connects a client and server built separately — today the
 * sidecar WebSocket bridge, later a daemon — exchanges this number in its
 * handshake and refuses a peer that speaks a different one rather than letting
 * mismatched shapes reach the handler table.
 *
 * v3 is a conservative bump, not an accurate one. `lm-studio:model-info` gained
 * an optional `embedding` field on each row (#2487) — additive by the paragraph
 * above — but `compareApiProtocol` compares whole resolved shapes and has no way
 * to say "only optional result fields were added", so it classified it breaking
 * and the gate demanded a bump. Teaching the differ that distinction is worth
 * doing on its own; until then a bump is the safe side of the disagreement,
 * since it can only refuse peers that would otherwise have been allowed.
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
// v52 conservatively versions the optional `conciseThreadsDefaultMigrated` settings marker.
export const API_PROTOCOL_VERSION = 52 as const
