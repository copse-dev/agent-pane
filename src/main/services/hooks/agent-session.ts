// Agent-session identity for hook wire payloads (B4).
//
// Cursor stamps the real conversation / generation ids and the running model
// onto every agent-session hook payload (`conversation_id` / `generation_id` /
// `model` / `model_id` / `model_params`). This host-side helper assembles that
// identity from the run context Copse already tracks and hands it to the dialect
// adapters through `HookContext.agentSession` (opaque to `packages/agent`):
//
//   - conversation_id ← the thread id of the active run (`getActiveRunThread`);
//   - generation_id   ← the current turn id (`getCurrentHookRunTurnId`), so a
//                        hook's wire payload and its spine `hook_run` line agree;
//   - model / model_id / model_params ← the resolved model actually running
//                        (`getActiveRunModel`), with params sourced from the
//                        model catalog (context window / max output tokens).
//
// The fire sites capture this **by value** before dispatching, so a detached
// `stop` hook still marshals the finished turn's identity after the run's
// recording context is torn down (decision 3).
import { getModelInfo } from '@copse/llm/model-catalog.ts'
import type {
  AgentSessionInfo,
  HookAgentSessionModel,
  HookModelParam,
} from '@copse/agent/hooks/canonical-events.ts'
import { getActiveRunModel, getActiveRunThread } from '../thread-models.ts'
import { getCurrentHookRunTurnId } from '../hook-run-recorder.ts'

/**
 * Build the Cursor `model` / `model_id` / `model_params` identity for a resolved
 * model id. The slug and structured id are both the Copse model string (our ids
 * are the slugs); `model_params` reports the real running-model attributes we
 * know from the catalog as `{ id, value }` pairs (the Cursor array shape). A
 * model with no catalog entry (e.g. a local LM Studio id) still yields a valid
 * identity with an empty params array.
 */
export function buildHookModelIdentity(modelId: string): HookAgentSessionModel {
  const info = getModelInfo(modelId)
  const modelParams: HookModelParam[] = []
  if (info) {
    modelParams.push({ id: 'context_window', value: String(info.contextWindow) })
    modelParams.push({ id: 'max_output_tokens', value: String(info.maxOutputTokens) })
  }
  return { model: modelId, modelId, modelParams }
}

/** Overrides for values not resolvable from ambient run state at the fire site. */
export interface AgentSessionOverrides {
  /** Conversation id (thread id); defaults to the active run thread. */
  conversationId?: string
  /** Generation id (turn id); defaults to the current recording turn id. */
  generationId?: string
  /**
   * Resolved model id actually running. `undefined` falls back to the active-run
   * model; pass `null` to omit model identity entirely (e.g. no model resolved).
   */
  model?: string | null
}

/**
 * Snapshot the current agent-session identity for a hook wire payload (B4).
 * Reads ambient run state unless overridden; returns a plain value safe to hand
 * to a detached hook. When nothing is known the ids are empty strings and
 * `model` is omitted — the pre-B4 wire shape, so a fire outside an active run is
 * still well-formed.
 */
export function currentAgentSessionInfo(overrides: AgentSessionOverrides = {}): AgentSessionInfo {
  const conversationId = overrides.conversationId ?? getActiveRunThread() ?? ''
  const generationId = overrides.generationId ?? getCurrentHookRunTurnId() ?? ''
  const modelId = overrides.model !== undefined ? overrides.model : getActiveRunModel()
  return {
    conversationId,
    generationId,
    ...(modelId ? { model: buildHookModelIdentity(modelId) } : {}),
  }
}
