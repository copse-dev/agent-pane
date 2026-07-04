import type { UserContent } from '@shared/types/llm.ts'
import { getSetting } from '../settings.ts'

/**
 * Experimental, opt-in client-side PII redaction (off by default).
 *
 * Wraps National Design Studio's Rampart (`@nationaldesignstudio/rampart`, CC BY
 * 4.0) — a local-first PII filter: synchronous heuristics + validators for
 * structured identifiers, plus an optional small ONNX token-classifier for
 * contextual PII. When enabled, the personal data a user types is replaced with
 * stable placeholders (`[EMAIL_1]`, `[GIVEN_NAME_2]`, …) *before* the prompt
 * leaves the device for any provider. The reverse map lives only here, in memory,
 * keyed per thread, and never crosses the wire.
 *
 * Rampart is an *optional* dependency: the import is indirected so neither the
 * bundler nor the typechecker hard-requires it, and every entry point degrades to
 * a no-op (the original text is sent unchanged) when the feature is off or the
 * package/model is unavailable. Because this fails open, it is a privacy
 * best-effort, not a guarantee — see docs/pii-redaction.md.
 */

export const PII_REDACTION_ENABLED_SETTING = 'piiRedactionEnabled'

/** The subset of Rampart's `ScrubResult` we consume. */
interface ScrubResult {
  readonly text: string
  readonly placeholders: readonly string[]
}

/** The subset of Rampart's `ChatGuard` we consume. */
export interface PiiGuard {
  /** Replace PII in user text with stable placeholders. */
  protect(text: string): Promise<ScrubResult>
  /** Restore real values for any known placeholder; unknown tokens pass through. */
  reveal(reply: string): string
}

interface GuardOptions {
  readonly device?: 'cpu' | 'wasm' | 'webgpu'
  readonly heuristicsOnly?: boolean
}

/** The slice of the Rampart module we call. */
export interface RampartModule {
  createGuard(options?: GuardOptions): Promise<PiiGuard>
}

export type RampartLoader = () => Promise<RampartModule | null>

// Indirected specifier: a computed import keeps esbuild from bundling the
// optional dependency (it stays a runtime import resolved from node_modules) and
// keeps `tsc` from erroring when the package isn't installed.
const defaultLoader: RampartLoader = async () => {
  const specifier = '@nationaldesignstudio/rampart'
  try {
    // The computed specifier keeps esbuild/tsc from resolving the optional dep,
    // so the import is typed `any`; shape it as the slice we call. Every call site
    // is still guarded (try/catch + null fallback).
    const mod = (await import(specifier)) as RampartModule
    return mod
  } catch (err) {
    console.warn('[pii] Rampart is unavailable; PII redaction disabled for this run.', err)
    return null
  }
}

let loader: RampartLoader = defaultLoader
let modulePromise: Promise<RampartModule | null> | null = null

/** Test seam: swap the Rampart loader (and reset cached module/guards). */
export function setRampartLoaderForTest(next: RampartLoader | null): void {
  loader = next ?? defaultLoader
  modulePromise = null
  guards.clear()
}

function isEnabled(): boolean {
  return getSetting<boolean>(PII_REDACTION_ENABLED_SETTING, false)
}

function loadModule(): Promise<RampartModule | null> {
  modulePromise ??= loader()
  return modulePromise
}

// One guard per thread. A Rampart guard keeps placeholder identity stable across
// every turn of a conversation, which maps exactly onto a thread.
const guards = new Map<string, PiiGuard>()

async function getGuard(threadId: string): Promise<PiiGuard | null> {
  const existing = guards.get(threadId)
  if (existing) return existing

  const mod = await loadModule()
  if (!mod) return null

  // Prefer the full guard (heuristics + contextual NER). If the model can't load
  // (e.g. first-run download fails offline), fall back to heuristics-only so
  // structured PII — emails, phones, SSNs, cards, IPs — is still redacted with no
  // network. Only when both fail do we give up and pass text through unchanged.
  try {
    const guard = await mod.createGuard({ device: 'cpu' })
    guards.set(threadId, guard)
    return guard
  } catch (err) {
    console.warn('[pii] Rampart NER unavailable; falling back to heuristics only.', err)
  }
  try {
    const guard = await mod.createGuard({ device: 'cpu', heuristicsOnly: true })
    guards.set(threadId, guard)
    return guard
  } catch (err) {
    console.warn('[pii] Rampart guard could not be created; PII redaction skipped.', err)
    return null
  }
}

/**
 * Redact PII in a user message before it is sent to any provider. Text blocks are
 * scrubbed sequentially so the same value yields the same placeholder; image
 * blocks pass through untouched. Returns the input unchanged when the feature is
 * off or Rampart is unavailable.
 */
export async function redactUserContent(
  threadId: string,
  content: UserContent,
): Promise<UserContent> {
  if (!isEnabled()) return content

  const guard = await getGuard(threadId)
  if (!guard) return content

  try {
    if (typeof content === 'string') {
      return (await guard.protect(content)).text
    }
    const blocks: UserContent = []
    for (const block of content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: (await guard.protect(block.text)).text })
      } else {
        blocks.push(block)
      }
    }
    return blocks
  } catch (err) {
    console.warn('[pii] redaction failed; sending text unchanged.', err)
    return content
  }
}

/**
 * Resolve the real value behind a placeholder for a thread, or `null` if the
 * token is unknown (no guard, never redacted, or already a real value). Used by
 * the `reveal_pii` tool — which gates the result behind user approval.
 */
export function revealPlaceholder(threadId: string, token: string): string | null {
  const guard = guards.get(threadId)
  if (!guard) return null
  const revealed = guard.reveal(token)
  return revealed === token ? null : revealed
}

/** Drop a thread's reverse map (e.g. when the thread is deleted). */
export function clearThreadRedaction(threadId: string): void {
  guards.delete(threadId)
}
