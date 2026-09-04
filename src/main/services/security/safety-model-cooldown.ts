import { isStreamAbortError } from '@copse/llm/stream-retry.ts'
import { safetyModelDisplayId, type SafetyModelProblem } from './safety-model-availability.ts'

/**
 * Which safety models have proved too slow to answer inside the screening
 * budget (`FETCH_TIMEOUTS.safetyClassification`), and how long to route around
 * them.
 *
 * A model can clear the intelligence bar and still be useless here. On the
 * reporting machine `google/gemma-4-12b` scores 22.2 — over
 * `SAFETY_MODEL_MIN_INTELLECT` — and takes ~13.6s to screen a full
 * 6000-character snapshot, so it missed the 8s budget on essentially every
 * call. Screening stayed fail-closed, which is correct; what it was not is
 * cheap. The user paid 8s per `read_terminal` for a foregone conclusion and got
 * an approval prompt at the end of each one.
 *
 * Deliberately in memory and per app session. Slowness is a fact about this
 * machine right now — what else is resident, whether the laptop is on battery,
 * whether the weights are loaded — so a judgement made this afternoon has no
 * business outliving the app, and none of it belongs in settings.
 */

/**
 * Timeouts needed inside {@link STRIKE_WINDOW_MS} before a model is skipped.
 *
 * One is not evidence. LM Studio just-in-time loads weights, so the first
 * request to an unloaded model pays the load as well as the inference; a
 * perfectly fast model that happened to be cold would be condemned on its first
 * use. A second timeout is much harder to explain that way — the first request
 * already asked the server for the model.
 */
const STRIKES_TO_COOL_DOWN = 2

/**
 * How close together those strikes have to fall.
 *
 * A second strike only rules out a cold start while the model is plausibly
 * still resident; servers evict idle models, so two timeouts an hour apart are
 * two cold starts rather than one slow model. A strike older than this window
 * is dropped and counting starts again.
 */
const STRIKE_WINDOW_MS = 5 * 60_000

/**
 * How long a model that struck out is routed around.
 *
 * Long enough to be worth the detour — screening runs on every `read_terminal`
 * and every shell command the rules don't settle — and short enough that a
 * model which was slow for a passing reason (a download saturating the disk,
 * another model holding the GPU) gets tried again in the same sitting instead
 * of being written off. It expires on its own: there is no permanent list.
 */
export const SAFETY_MODEL_COOLDOWN_MS = 10 * 60_000

interface TimeoutRecord {
  /** Timeouts counted so far, within {@link STRIKE_WINDOW_MS} of each other. */
  strikes: number
  at: number
  /** Epoch ms this model becomes routable again; 0 while it still is. */
  coolingUntil: number
}

const records = new Map<string, TimeoutRecord>()

// Overridable so the expiry tests can step past a ten-minute cooldown without
// waiting out ten minutes.
let clock: () => number = () => Date.now()

function seconds(ms: number): string {
  return `${String(Math.round(ms / 1000))}s`
}

function minutes(ms: number): string {
  const value = Math.round(ms / 60_000)
  return `${String(value)} ${value === 1 ? 'minute' : 'minutes'}`
}

/**
 * Whether a screening failure was the budget running out rather than something
 * else going wrong.
 *
 * `completeMessagesWithUsage` aborts one controller from two places: the
 * caller's signal, and its own timer. So an abort-shaped throw with the
 * caller's signal still un-aborted can only be the timer — no elapsed-time
 * guesswork needed. Everything else (a 404 for a model that vanished, a refused
 * connection, a malformed response) is a different fault and must not count
 * against the model's speed.
 *
 * Abort shapes are recognised by {@link isStreamAbortError} rather than by
 * `name`, because a cloud safety model aborts through its SDK's own error class
 * — whose `name` is a plain `Error` — and a name check would quietly never fire
 * for the exact models most likely to be slow. `TimeoutError` covers a deadline
 * a provider set for itself with `AbortSignal.timeout`.
 */
export function isScreeningTimeout(err: unknown, callerSignal?: AbortSignal): boolean {
  if (callerSignal?.aborted) return false
  if (isStreamAbortError(err)) return true
  if (typeof err !== 'object' || err === null) return false
  return (err as { name?: unknown }).name === 'TimeoutError'
}

function prune(model: string, now: number): TimeoutRecord | undefined {
  const record = records.get(model)
  if (!record) return undefined
  if (record.coolingUntil > now) return record
  // The cooldown has run out, or the last strike is too old to still be part of
  // a run: forget the model entirely so it gets a clean first strike next time.
  if (record.coolingUntil > 0 || now - record.at > STRIKE_WINDOW_MS) {
    records.delete(model)
    return undefined
  }
  return record
}

/** True while `model` is being routed around after striking out. */
export function isSafetyModelCoolingDown(model: string): boolean {
  const now = clock()
  return (prune(model, now)?.coolingUntil ?? 0) > now
}

/** Every model currently being routed around — the `exclude` list for re-picking. */
export function coolingDownSafetyModels(): string[] {
  const now = clock()
  const out: string[] = []
  for (const model of [...records.keys()]) {
    if ((prune(model, now)?.coolingUntil ?? 0) > now) out.push(model)
  }
  return out
}

/**
 * Record a screening attempt that ran out of budget, and describe it.
 *
 * A problem comes back for the first strike too: the user waited the full
 * budget and got an approval prompt out of it, so saying why is the whole point
 * of this seam. Only the message differs — the first one says the model may
 * simply have been loading, because on the evidence available it may well have
 * been.
 */
export function noteSafetyModelTimeout(model: string, budgetMs: number): SafetyModelProblem {
  const now = clock()
  const previous = prune(model, now)
  const strikes = (previous?.strikes ?? 0) + 1
  const coolingUntil = strikes >= STRIKES_TO_COOL_DOWN ? now + SAFETY_MODEL_COOLDOWN_MS : 0
  records.set(model, { strikes, at: now, coolingUntil })

  const id = safetyModelDisplayId(model)
  return {
    model,
    reason: 'timed-out',
    message: coolingUntil
      ? `The safety model "${id}" keeps missing the ${seconds(budgetMs)} screening budget, so screening is skipping it for ${minutes(SAFETY_MODEL_COOLDOWN_MS)} and using the next model down. Choose a faster safety model in Settings → Models.`
      : `The safety model "${id}" did not answer within ${seconds(budgetMs)}. That can be a model still loading, so it will be tried again.`,
  }
}

/**
 * The model is cooling down and nothing else can screen in its place.
 *
 * Fail-closed, and worth saying out loud: with no classifier at all every read
 * falls to the user, which is exactly the run of prompts this whole seam exists
 * to explain.
 */
export function safetyModelCoolingDownProblem(model: string, budgetMs: number): SafetyModelProblem {
  const id = safetyModelDisplayId(model)
  return {
    model,
    reason: 'timed-out',
    message: `The safety model "${id}" is being skipped after missing the ${seconds(budgetMs)} screening budget, and no other model is available to screen in its place. Choose a faster safety model in Settings → Models.`,
  }
}

/**
 * Forget a model's strikes after it answers in time.
 *
 * Strikes are evidence of a *run* of slowness. A model that answers has just
 * disproved the run, whatever it then said — a reply that fails to parse is a
 * different complaint, and the intelligence floor is what covers it.
 */
export function noteSafetyModelAnswered(model: string): void {
  records.delete(model)
}

/** Clear all timeout state (tests only). */
export function resetSafetyModelCooldownsForTest(): void {
  records.clear()
}

/** Replace the clock in tests; pass `null` to restore the real one. */
export function setSafetyModelClockForTest(next: (() => number) | null): void {
  clock = next ?? ((): number => Date.now())
}
