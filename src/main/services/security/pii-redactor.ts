import { randomInt } from 'node:crypto'
import type { UserContent } from '@shared/types/llm.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { PII_REDACTION_PLUGIN_ID } from '@copse/agent/plugins/pii-redaction-plugin.ts'
import { isRecord } from '@shared/unknown-value.ts'

/**
 * Experimental, opt-in client-side PII redaction (off by default).
 *
 * Wraps National Design Studio's Rampart (`@nationaldesignstudio/rampart`, CC BY
 * 4.0) — a local-first PII filter: synchronous heuristics + validators for
 * structured identifiers, plus an optional small ONNX token-classifier for
 * contextual PII. When enabled, the personal data a user types is replaced with
 * placeholders (`[EMAIL_QJXKT_1]`, …) *before* the prompt leaves the device for
 * any provider. The reverse map lives only here, in memory, keyed per thread,
 * and never crosses the wire.
 *
 * Rampart is an *optional* dependency: the import is indirected so neither the
 * bundler nor the typechecker hard-requires it. The contextual classifier needs
 * `@huggingface/transformers`, which packaged releases do not ship, so releases
 * run Rampart's heuristic layer only. When Rampart itself cannot load or run, the
 * original text is sent unchanged (fail-open) and the caller receives a notice to
 * show the user — this is a privacy best-effort, not a guarantee. See
 * docs/pii-redaction.md.
 *
 * Enablement is the `copse.pii-redaction` first-party plugin (Settings >
 * Plugins), which ships disabled: the same flag that registers the `reveal_pii`
 * tool and appends the steering prompt block also arms this input rewrite.
 */

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

/**
 * Every entity label Rampart 0.1.x can emit (its `PiiLabel` union). Listed here
 * so each label gets a session-tagged placeholder alias; a label Rampart adds
 * later would still be redacted, just without the tag.
 */
const PII_LABELS = [
  'SSN',
  'CREDIT_CARD',
  'IP_ADDRESS',
  'GIVEN_NAME',
  'SURNAME',
  'EMAIL',
  'PHONE',
  'URL',
  'TAX_ID',
  'BANK_ACCOUNT',
  'ROUTING_NUMBER',
  'GOVERNMENT_ID',
  'PASSPORT',
  'DRIVERS_LICENSE',
  'BUILDING_NUMBER',
  'STREET_NAME',
  'SECONDARY_ADDRESS',
  'CITY',
  'STATE',
  'ZIP_CODE',
] as const

type PiiLabel = (typeof PII_LABELS)[number]

/**
 * Labels Rampart classifies but Copse leaves in the text.
 *
 * Rampart is default-deny and only keeps CITY / STATE / ZIP_CODE. In a coding
 * assistant that also rewrote every `https://` URL, `www.` host, IPv4/IPv6
 * address (including `127.0.0.1` and four-part version numbers like `1.2.3.4`)
 * and MAC address — Rampart files IPs and MACs under `IP_ADDRESS` — which breaks
 * ordinary requests about code, docs and local servers. Those are kept.
 *
 * Trade-off: Rampart merges overlapping spans before applying this list, so PII
 * embedded *inside* a URL (e.g. an email in a query string) is kept with it.
 */
export const PII_KEEP_LABELS: readonly PiiLabel[] = [
  'CITY',
  'STATE',
  'ZIP_CODE',
  'URL',
  'IP_ADDRESS',
]

interface GuardOptions {
  readonly device?: 'cpu' | 'wasm' | 'webgpu'
  readonly heuristicsOnly?: boolean
  readonly keepLabels?: readonly PiiLabel[]
  readonly aliases?: Partial<Record<PiiLabel, string>>
}

/** The slice of the Rampart module we call. */
export interface RampartModule {
  createGuard(options?: GuardOptions): Promise<PiiGuard>
}

export type RampartLoader = () => Promise<RampartModule | null>

/**
 * Shown to the user (as a turn notice) whenever redaction is on but could not
 * run for a message, so the message went to the provider unredacted.
 */
export const PII_REDACTION_FAILED_NOTICE =
  '_PII redaction is on but could not run, so this message was sent to the model provider without redaction. ' +
  'The cause is in the Copse log._\n\n'

// Indirected specifier: a computed import keeps esbuild from bundling the
// optional dependency (it stays a runtime import resolved from node_modules) and
// keeps `tsc` from erroring when the package isn't installed.
/** Load the installed Rampart package, or `null` when it is unavailable. */
export const loadRampart: RampartLoader = async () => {
  const specifier = '@nationaldesignstudio/rampart'
  try {
    // The computed specifier keeps esbuild/tsc from resolving the optional dep,
    // so the import is typed `any`; shape it as the slice we call. Every call site
    // is still guarded (try/catch + null fallback).
    const mod: unknown = await import(specifier)
    if (!isRecord(mod) || !isCreateGuard(mod['createGuard'])) return null
    return { createGuard: mod['createGuard'] }
  } catch (err) {
    console.warn('[pii] Rampart is unavailable; PII redaction disabled for this run.', err)
    return null
  }
}

function isCreateGuard(value: unknown): value is RampartModule['createGuard'] {
  return typeof value === 'function'
}

let loader: RampartLoader = loadRampart
let modulePromise: Promise<RampartModule | null> | null = null

/** Test seam: swap the Rampart loader (and reset cached module/guards). */
export function setRampartLoaderForTest(next: RampartLoader | null): void {
  loader = next ?? loadRampart
  modulePromise = null
  guards.clear()
}

function isEnabled(): boolean {
  return getDefaultPluginRegistry().isEnabled(PII_REDACTION_PLUGIN_ID)
}

function loadModule(): Promise<RampartModule | null> {
  modulePromise ??= loader()
  return modulePromise
}

const TAG_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const TAG_LENGTH = 5

/**
 * A random tag stamped into every placeholder one guard mints.
 *
 * Rampart numbers placeholders per guard (`[EMAIL_1]`, `[EMAIL_2]`, …), and the
 * guard — with its reverse map — lives only in memory. Without a tag, a thread
 * reopened after a restart would mint a fresh `[EMAIL_1]` for a *different*
 * value while history still holds the old `[EMAIL_1]`, and `reveal_pii` would
 * hand back the new value for the old token. Tagging each guard's tokens
 * (`[EMAIL_QJXKT_1]`) makes tokens from an earlier session unknown to the new
 * guard, so they are refused rather than silently resolved to the wrong value.
 * Letters only: Rampart's placeholder grammar is `[A-Z][A-Z_]*_\d+`. Five letters
 * make a repeat within one thread roughly a one-in-twelve-million event.
 */
function mintSessionTag(): string {
  let tag = ''
  for (let i = 0; i < TAG_LENGTH; i += 1) tag += TAG_ALPHABET.charAt(randomInt(TAG_ALPHABET.length))
  return tag
}

function sessionAliases(tag: string): Partial<Record<PiiLabel, string>> {
  const aliases: Partial<Record<PiiLabel, string>> = {}
  for (const label of PII_LABELS) aliases[label] = `${label}_${tag}`
  return aliases
}

// One guard per thread per app session. A Rampart guard keeps placeholder
// identity stable across every turn it sees, which maps onto a thread for as
// long as the process lives.
const guards = new Map<string, PiiGuard>()

async function getGuard(threadId: string): Promise<PiiGuard | null> {
  const existing = guards.get(threadId)
  if (existing) return existing

  const mod = await loadModule()
  if (!mod) return null

  const shared = {
    device: 'cpu',
    keepLabels: PII_KEEP_LABELS,
    aliases: sessionAliases(mintSessionTag()),
  } satisfies GuardOptions

  // Prefer the full guard (heuristics + contextual NER). If the model can't load
  // (packaged releases don't ship its runtime; a first-run download can fail
  // offline), fall back to heuristics-only so structured PII — emails, SSNs,
  // card numbers — is still redacted with no network. Only when both fail do we
  // give up and pass text through unchanged.
  try {
    const guard = await mod.createGuard(shared)
    guards.set(threadId, guard)
    return guard
  } catch (err) {
    console.warn('[pii] Rampart NER unavailable; falling back to heuristics only.', err)
  }
  try {
    const guard = await mod.createGuard({ ...shared, heuristicsOnly: true })
    guards.set(threadId, guard)
    return guard
  } catch (err) {
    console.warn('[pii] Rampart guard could not be created; PII redaction skipped.', err)
    return null
  }
}

/** A user message after redaction, plus a notice when redaction failed open. */
export interface RedactionResult {
  readonly content: UserContent
  /** Set when redaction is on but the message went out unredacted. */
  readonly notice?: string
}

/**
 * Redact PII in a user message before it is sent to any provider. Text blocks are
 * scrubbed sequentially so the same value yields the same placeholder; image
 * blocks pass through untouched. Returns the input unchanged when the feature is
 * off; when it is on but Rampart cannot run, returns the input unchanged with a
 * {@link PII_REDACTION_FAILED_NOTICE} for the caller to show.
 */
export async function redactUserContent(
  threadId: string,
  content: UserContent,
): Promise<RedactionResult> {
  if (!isEnabled()) return { content }

  const guard = await getGuard(threadId)
  if (!guard) return { content, notice: PII_REDACTION_FAILED_NOTICE }

  try {
    if (typeof content === 'string') {
      return { content: (await guard.protect(content)).text }
    }
    const blocks: UserContent = []
    for (const block of content) {
      if (block.type === 'text') {
        blocks.push({ type: 'text', text: (await guard.protect(block.text)).text })
      } else {
        blocks.push(block)
      }
    }
    return { content: blocks }
  } catch (err) {
    console.warn('[pii] redaction failed; sending text unchanged.', err)
    return { content, notice: PII_REDACTION_FAILED_NOTICE }
  }
}

/**
 * Resolve the real value behind a placeholder for a thread, or `null` if the
 * token is unknown (no guard, never redacted, minted before an app restart, or
 * already a real value). Used by the `reveal_pii` tool — which gates the result
 * behind user approval.
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
