import { BEST_VALUE_MODEL_SELECTOR, minIntellectSelector } from '@copse/llm/dynamic-model.ts'
import { firstNonEmptyString } from './unknown-value.ts'

/**
 * Default LM Studio server URL (OpenAI-compatible /v1 endpoint).
 * Use `127.0.0.1` rather than `localhost` so probes skip macOS IPv6 (`::1`)
 * resolution — LM Studio binds IPv4, and a `localhost`→`::1` miss can stall
 * until the model-list timeout (looks like a spinner on Settings → Local models).
 */
export const DEFAULT_LM_STUDIO_URL = 'http://127.0.0.1:1234/v1'

/**
 * Rewrite bare `localhost` to `127.0.0.1` for outbound loopback HTTP.
 * Leaves `*.localhost`, IPv6 literals, and non-loopback hosts untouched.
 */
export function preferIpv4LoopbackUrl(url: string): string {
  return url.replace(/^(https?:\/\/)localhost(?=[:/?#]|$)/i, '$1127.0.0.1')
}

/** Default LM Studio model ids (OpenAI-compatible /v1/models ids). */
export const LM_STUDIO_MODEL_IDS = {
  chat: 'qwen/qwen3.6-35b-a3b',
  smallTasks: 'google/gemma-4-e4b',
  safety: 'qwen/qwen3-4b-2507',
} as const

/**
 * Settings / picker sentinel: each new chat window resolves the plan-aware
 * Pareto frontier and routes to the best-value model among configured providers.
 * The literal lives with the rest of the dynamic-selection vocabulary
 * (`@copse/llm/dynamic-model.ts`), of which this is one member; app code keeps
 * importing it from here because that is where every other chat-model default is.
 */
export const BEST_VALUE_CHAT_MODEL = BEST_VALUE_MODEL_SELECTOR

/** Human label for {@link BEST_VALUE_CHAT_MODEL} in pickers and Settings. */
export const BEST_VALUE_CHAT_MODEL_LABEL = 'Best value (plan / price)'

/** Concrete local fallback when best-value resolution finds no routable model. */
export const FALLBACK_APP_CHAT_MODEL = `lmstudio:${LM_STUDIO_MODEL_IDS.chat}`

/**
 * Intelligence floor for the instruct/safety role.
 *
 * Screening a shell command or a terminal snapshot is a small classification
 * job, but a model that cannot hold the output format is worse than useless
 * here: it fails to parse, the gate falls back to asking, and the user gets a
 * prompt on every call with no idea why. The bar exists to keep a model that
 * weak from being chosen automatically.
 *
 * 20 is the lowest rung the picker offers ({@link MIN_INTELLECT_THRESHOLDS}),
 * so a hand-set value can always be read against the same scale.
 */
export const SAFETY_MODEL_MIN_INTELLECT = 20

/**
 * Default for the instruct/safety role: the best model on this device that
 * clears {@link SAFETY_MODEL_MIN_INTELLECT}, or the cheapest cloud route that
 * clears it when no local model does.
 *
 * A relative rule rather than `LM_STUDIO_MODEL_IDS.safety`, for the same reason
 * every other role stores one: a fixed local id is wrong for the large number of
 * users who never set up a local server, and it fails *silently* there — the
 * classifier reports enabled while pointing at a model that will never exist.
 * `LM_STUDIO_MODEL_IDS.safety` stays the id we recommend downloading; it is no
 * longer what an unconfigured install pretends to be using.
 *
 * Two consequences worth knowing, both deliberate. Screening moves to a cloud
 * provider when nothing local clears the bar, so terminal scrollback and shell
 * commands are sent there — the picker's hint says so, and a qualifying local
 * model always wins, because `min-intellect` prefers routes that cost nothing
 * at the margin. And a model with no measured score cannot be chosen at all:
 * `localFrontierCandidates` only admits models the local catalog has scored, so
 * the bar is applied to a smaller pool than the machine may actually hold.
 */
export const DEFAULT_SAFETY_MODEL = minIntellectSelector(SAFETY_MODEL_MIN_INTELLECT)

/**
 * Default chat model setting for new installs / unset `model`. Resolves at
 * thread-open and agent-run time via the value frontier — not a fixed provider.
 */
export const DEFAULT_APP_CHAT_MODEL = BEST_VALUE_CHAT_MODEL

export function isBestValueChatModel(model: string | null | undefined): boolean {
  return model === BEST_VALUE_CHAT_MODEL
}

export function lmStudioChatModelValue(modelId: string): string {
  return `lmstudio:${modelId}`
}

/** Settings URL, then eval/tunnel env, then default localhost endpoint. */
export function resolveLocalServerUrl(
  storedUrl: string | undefined | null,
  env: { COPSE_EVAL_LM_STUDIO_URL?: string; LM_STUDIO_BASE_URL?: string } = {},
): string {
  const fromEnv = firstNonEmptyString(
    env.COPSE_EVAL_LM_STUDIO_URL?.trim(),
    env.LM_STUDIO_BASE_URL?.trim(),
  )
  if (fromEnv) return fromEnv
  const stored = storedUrl?.trim()
  if (stored) return stored
  return DEFAULT_LM_STUDIO_URL
}
