import { randomInt } from 'node:crypto'
import type { UserContent } from '@shared/types/llm.ts'
import { getDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { PII_REDACTION_PLUGIN_ID } from '@copse/agent/plugins/pii-redaction-plugin.ts'
import { isRecord } from '@shared/unknown-value.ts'
import { isNonNull } from '@shared/nullish.ts'
import { z } from 'zod'

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

const heuristicSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  label: z.enum(PII_LABELS),
  score: z.number().min(0).max(1),
  source: z.literal('heuristic'),
  text: z.string(),
})

type HeuristicSpan = z.infer<typeof heuristicSpanSchema>

/**
 * Labels Rampart classifies but Copse leaves in the text.
 *
 * Rampart is default-deny and only keeps CITY / STATE / ZIP_CODE. In a coding
 * assistant that also rewrote every `https://` URL, `www.` host, IPv4/IPv6
 * address (including `127.0.0.1` and four-part version numbers like `1.2.3.4`)
 * and MAC address — Rampart files IPs and MACs under `IP_ADDRESS` — which breaks
 * ordinary requests about code, docs and local servers. Those are kept.
 *
 * Rampart merges overlapping spans before applying this list, so its guard alone
 * would keep PII embedded inside a URL. Copse performs a second heuristic pass
 * over the protected text and replaces nested email, SSN and card spans while
 * leaving the surrounding URL intact.
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
  readonly detectHeuristics: (text: string) => unknown
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
    if (!isRecord(mod) || !isCreateGuard(mod['createGuard'])) {
      return null
    }
    const detectHeuristics = mod['detectHeuristics']
    if (typeof detectHeuristics !== 'function') return null
    return {
      createGuard: mod['createGuard'],
      detectHeuristics: (text): unknown => {
        const detected: unknown = Reflect.apply(detectHeuristics, undefined, [text])
        return detected
      },
    }
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
  pendingGuards.clear()
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
// A thread's guard while it is being created. Overlapping first redactions for
// one thread share it; each minting its own guard would leave the placeholders
// of every guard but the one stored last impossible to reveal.
const pendingGuards = new Map<string, Promise<PiiGuard | null>>()

const PII_KEEP_LABEL_SET: ReadonlySet<PiiLabel> = new Set(PII_KEEP_LABELS)

function readHeuristicSpans(
  detectHeuristics: RampartModule['detectHeuristics'],
  text: string,
): readonly HeuristicSpan[] {
  const result = z.array(heuristicSpanSchema).safeParse(detectHeuristics(text))
  if (!result.success) {
    throw new Error('Rampart returned malformed heuristic spans')
  }
  for (const span of result.data) {
    if (
      span.end <= span.start ||
      span.end > text.length ||
      span.text !== text.slice(span.start, span.end)
    ) {
      throw new Error('Rampart returned an invalid heuristic span range')
    }
  }
  return result.data
}

interface NestedSpan {
  readonly span: HeuristicSpan
  readonly url: HeuristicSpan
}

function findNestedSensitiveSpans(
  detectHeuristics: RampartModule['detectHeuristics'],
  text: string,
): readonly NestedSpan[] {
  const spans = readHeuristicSpans(detectHeuristics, text)
  const urls = spans.filter((span) => span.label === 'URL')
  const nested = spans
    .filter((span) => !PII_KEEP_LABEL_SET.has(span.label))
    .map((span) => {
      const url = urls.find(
        (candidate) => candidate.start <= span.start && candidate.end >= span.end,
      )
      return url ? { span, url } : null
    })
    .filter(isNonNull)
    .sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end)

  // Heuristic spans can contain one another (for example, a digit identifier
  // inside an email-shaped URL userinfo). Keep the widest span so replacements
  // are disjoint; Rampart uses the same longer-span tie-break for heuristics.
  const disjoint: NestedSpan[] = []
  for (const entry of nested) {
    const previous = disjoint.at(-1)
    if (!previous || entry.span.start >= previous.span.end) {
      disjoint.push(entry)
      continue
    }
    if (entry.span.end > previous.span.end) {
      throw new Error('Rampart returned partially overlapping heuristic spans')
    }
  }
  return disjoint
}

function replacementInsideUrl(entry: NestedSpan, placeholder: string): string {
  if (entry.span.label !== 'EMAIL') return placeholder

  const urlText = entry.url.text
  const schemeEnd = urlText.indexOf('://')
  if (schemeEnd < 0) return placeholder
  const authorityStart = entry.url.start + schemeEnd + 3
  const suffix = urlText.slice(schemeEnd + 3)
  const boundary = suffix.search(/[/?#]/)
  const authorityEnd = boundary < 0 ? entry.url.end : authorityStart + boundary
  if (entry.span.start < authorityStart || entry.span.end > authorityEnd) return placeholder

  // `https://jane@example.com/path` is URL userinfo plus a public host. Rampart's
  // email detector covers both halves. Keep the host that the URL policy meant
  // to preserve, while replacing the identifying userinfo with a token.
  const at = entry.span.text.lastIndexOf('@')
  return at < 0 ? placeholder : `${placeholder}@${entry.span.text.slice(at + 1)}`
}

async function protectUrlNestedPii(
  guard: PiiGuard,
  detectHeuristics: RampartModule['detectHeuristics'],
  text: string,
): Promise<ScrubResult> {
  const protectedResult = await guard.protect(text)
  const nested = findNestedSensitiveSpans(detectHeuristics, protectedResult.text)
  if (nested.length === 0) return protectedResult

  // A single call keeps the contextual guard from running one model inference
  // per URL. Heuristic spans cannot contain newlines, so the separator is
  // unambiguous and preserves one replacement per detected value.
  const nestedResult = await guard.protect(nested.map((entry) => entry.span.text).join('\n'))
  const replacements = nestedResult.text.split('\n')
  if (replacements.length !== nested.length) {
    throw new Error('Rampart returned an unexpected nested redaction result')
  }

  let safeText = protectedResult.text
  const placeholders = new Set(protectedResult.placeholders)
  for (const token of nestedResult.placeholders) placeholders.add(token)
  for (let index = nested.length - 1; index >= 0; index -= 1) {
    const entry = nested[index]
    const replacement = replacements[index]
    if (!entry || replacement === undefined) {
      throw new Error('Rampart returned an incomplete nested redaction result')
    }
    if (replacement === entry.span.text || nestedResult.placeholders.length === 0) {
      throw new Error(`Rampart did not redact nested ${entry.span.label} span`)
    }
    const urlReplacement = replacementInsideUrl(entry, replacement)
    safeText = `${safeText.slice(0, entry.span.start)}${urlReplacement}${safeText.slice(entry.span.end)}`
  }
  return { text: safeText, placeholders: [...placeholders] }
}

function wrapGuard(guard: PiiGuard, mod: RampartModule): PiiGuard {
  // Rampart's guard owns the mutable forward/reverse placeholder maps. A
  // thread can submit overlapping redactions (for example, two queued turns),
  // but the library does not promise that concurrent protect calls update
  // those maps atomically. Keep the complete operation — including the second
  // pass for PII nested in a preserved URL — ordered per guard. A failed call
  // must not poison the queue for later messages.
  let tail = Promise.resolve()
  return {
    protect: (text): Promise<ScrubResult> => {
      const operation = tail.then(() => protectUrlNestedPii(guard, mod.detectHeuristics, text))
      tail = operation.then(
        () => undefined,
        () => undefined,
      )
      return operation
    },
    reveal: (reply) => guard.reveal(reply),
  }
}

function getGuard(threadId: string): Promise<PiiGuard | null> {
  const existing = guards.get(threadId)
  if (existing) return Promise.resolve(existing)
  const pending = pendingGuards.get(threadId)
  if (pending) return pending

  const creating: Promise<PiiGuard | null> = createGuardForThread().then((guard) => {
    // Cleared (thread deleted) while this was in flight: hand the guard to the
    // callers already waiting, but do not store it for the thread.
    if (pendingGuards.get(threadId) === creating) {
      pendingGuards.delete(threadId)
      if (guard) guards.set(threadId, guard)
    }
    return guard
  })
  pendingGuards.set(threadId, creating)
  return creating
}

async function createGuardForThread(): Promise<PiiGuard | null> {
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
    return wrapGuard(await mod.createGuard(shared), mod)
  } catch (err) {
    console.warn('[pii] Rampart NER unavailable; falling back to heuristics only.', err)
  }
  try {
    return wrapGuard(await mod.createGuard({ ...shared, heuristicsOnly: true }), mod)
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
  pendingGuards.delete(threadId)
}
