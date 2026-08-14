// Regenerates packages/llm/src/model-cards.generated.ts from the curated link
// file scripts/data/model-cards.json. Companion to sync-model-catalog.mts
// (pricing), sync-intellect.mts (Intelligence Index) and sync-local-models.mts
// (local benchmarks); this one carries the *documentation* axis — where a model's
// own vendor published its model card / system card.
//
// Design notes:
//   - The JSON is the reviewed source of truth. A card link is a cited fact: a
//     real URL the vendor publishes, with a `source` and an `asOf`. This script
//     never invents one from a slug pattern — a dead link in the UI is worse
//     than no link, so an unsourced model simply has no card.
//   - Discovery (`--discover`) is the scalable channel, adapted from the
//     model-card collector: vendor sitemaps plus the card hubs that link their
//     siblings. It only ever fills a model listed in `wanted` or upgrades an
//     `index` placeholder to the exact card — matched on the `match` tokens in
//     the data file, never fuzzy-matched on the model name — so the set of
//     linked models stays a reviewed decision.
//   - Verification (`--verify`) GETs every card URL and fails on anything that
//     is not reachable, so link rot breaks the sync workflow rather than
//     shipping quietly.
//   - Hugging Face weights are deliberately absent: the README *is* the model
//     card, and `model-cards.ts` derives that URL from the router id, whose
//     org/model casing comes from the HF API itself.
//
// Run locally:  npm run sync:model-cards                    (validate + emit)
//               npm run sync:model-cards -- --verify        (also check links)
//               npm run sync:model-cards -- --discover      (also fetch vendors)
//
// Network note: discovery and verification talk to vendor sites, which sit
// behind bot protection and are commonly blocked from sandboxes. Both flags are
// opt-in for exactly that reason — a plain run is offline and deterministic.

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { formatGenerated, writeGeneratedFile } from './lib/generated-file.mts'

const DATA_PATH = resolve('scripts/data/model-cards.json')
const GENERATED_PATH = resolve('packages/llm/src/model-cards.generated.ts')

const TIMEOUT_MS = 45_000
const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi
const HREF_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi

const USER_AGENT = process.env['CONTACT_EMAIL']
  ? `copse-model-card-sync/1.0 (${process.env['CONTACT_EMAIL']})`
  : 'copse-model-card-sync/1.0 (+https://github.com/copse-dev/agent-pane)'

// ---------------------------------------------------------------------------
// data file
// ---------------------------------------------------------------------------

/** What a link is: a card about this model, or a hub that lists cards. */
export type CardKind = 'system-card' | 'model-card' | 'index'

export interface CardEntry {
  modelId: string
  publisher: string
  kind: CardKind
  title: string
  url: string
  source: string
  asOf: string
}

/** A model we want a card for but have not sourced one for yet. */
export interface WantedCard {
  modelId: string
  /** Discovery config key (see PUBLISHERS). */
  publisher: string
  /** Slug fragments that identify this model in a card URL. */
  match: string[]
}

export interface CardDataFile {
  /** The sourcing rules, carried through a rewrite so reviewers keep seeing them. */
  $comment?: string | undefined
  cards: CardEntry[]
  wanted?: WantedCard[] | undefined
}

const cardKindSchema = z.enum(['system-card', 'model-card', 'index'])
const cardEntrySchema: z.ZodType<CardEntry> = z.object({
  modelId: z.string().min(1),
  publisher: z.string().min(1),
  kind: cardKindSchema,
  title: z.string().min(1),
  url: z.url(),
  source: z.string().min(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOf must be an ISO date (YYYY-MM-DD)'),
})
const wantedCardSchema: z.ZodType<WantedCard> = z.object({
  modelId: z.string().min(1),
  publisher: z.string().min(1),
  match: z.array(z.string().min(1)).min(1),
})
const dataFileSchema: z.ZodType<CardDataFile> = z.object({
  $comment: z.string().optional(),
  cards: z.array(cardEntrySchema),
  wanted: z.array(wantedCardSchema).optional(),
})

// ---------------------------------------------------------------------------
// discovery configuration
// ---------------------------------------------------------------------------

interface PublisherConfig {
  label: string
  sitemaps: string[]
  /** A sitemap URL is a card candidate when it matches one of these. */
  sitemapPatterns: RegExp[]
  /** Hub pages whose links are card candidates (they are hubs, not cards). */
  seedPages: string[]
  linkPatterns: RegExp[]
  allowHosts: string[]
  /** Cards we already know the address of, seeding sibling-link discovery. */
  knownCards?: string[]
  kind: CardKind
}

/**
 * Where each vendor publishes. Anthropic and DeepMind have real hubs; OpenAI
 * has none, so a known card page seeds the rest through its "System Cards /
 * View all" block; Meta's docs sidebar links siblings the same way.
 */
export const PUBLISHERS: Record<string, PublisherConfig> = {
  anthropic: {
    label: 'Anthropic',
    sitemaps: ['https://www.anthropic.com/sitemap.xml'],
    sitemapPatterns: [/system-card/],
    seedPages: ['https://www.anthropic.com/transparency'],
    linkPatterns: [/system-card/, /system[-_ ]?card.*\.pdf$/i],
    allowHosts: [
      'www.anthropic.com',
      'anthropic.com',
      'assets.anthropic.com',
      'www-cdn.anthropic.com',
    ],
    kind: 'system-card',
  },
  openai: {
    label: 'OpenAI',
    sitemaps: ['https://openai.com/sitemap.xml', 'https://openai.com/sitemap_index.xml'],
    sitemapPatterns: [/system-card/],
    seedPages: [],
    linkPatterns: [/system-card/],
    allowHosts: ['openai.com', 'www.openai.com', 'cdn.openai.com'],
    knownCards: [
      'https://openai.com/index/gpt-4o-system-card/',
      'https://openai.com/index/gpt-4-5-system-card/',
      'https://openai.com/index/openai-o1-system-card/',
      'https://openai.com/index/o3-o4-mini-system-card/',
      'https://openai.com/index/gpt-5-3-codex-system-card/',
    ],
    kind: 'system-card',
  },
  deepmind: {
    label: 'Google DeepMind',
    sitemaps: ['https://deepmind.google/sitemap.xml'],
    sitemapPatterns: [/\/models\/model-cards\/[^/]+/],
    seedPages: ['https://deepmind.google/models/model-cards/'],
    linkPatterns: [/\/models\/model-cards\/[^/]+/, /\/Model-Cards\/.*\.pdf$/i],
    allowHosts: ['deepmind.google', 'storage.googleapis.com'],
    kind: 'model-card',
  },
  meta: {
    label: 'Meta',
    sitemaps: ['https://www.llama.com/sitemap.xml', 'https://developer.meta.com/ai/sitemap.xml'],
    sitemapPatterns: [/model-cards-and-prompt-formats\/[^/]+/],
    seedPages: ['https://www.llama.com/docs/model-cards-and-prompt-formats/'],
    linkPatterns: [/model-cards-and-prompt-formats\/[^/]+/],
    allowHosts: ['www.llama.com', 'llama.com', 'developer.meta.com'],
    kind: 'model-card',
  },
}

/**
 * Reject a data file that would ship a broken or ambiguous link: one card per
 * model id, https only, and every `wanted` publisher known to discovery.
 */
export function validateCards(data: CardDataFile): void {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const card of data.cards) {
    if (seen.has(card.modelId)) {
      problems.push(`${card.modelId}: more than one card — the UI shows exactly one link per model`)
    }
    seen.add(card.modelId)
    if (!card.url.startsWith('https://')) {
      problems.push(`${card.modelId}: card URL must be https (got '${card.url}')`)
    }
  }
  for (const want of data.wanted ?? []) {
    if (!(want.publisher in PUBLISHERS)) {
      problems.push(
        `${want.modelId}: unknown publisher '${want.publisher}' — add it to PUBLISHERS in scripts/sync-model-cards.mts`,
      )
    }
  }
  if (problems.length > 0) {
    throw new Error(`[sync-model-cards] Refusing to write cards:\n  - ${problems.join('\n  - ')}`)
  }
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

const trimUrl = (url: string): string => url.split('#')[0]?.replace(/\/+$/, '') ?? url

/**
 * The best card URL for a model, or null. A candidate qualifies only when its
 * path contains one of the model's `match` tokens delimited by a non-alphanumeric
 * character on both sides, so `gpt-5` never claims `gpt-5-mini`'s card. Ties go
 * to the longest matched token, then the shortest URL (the least-qualified page
 * for that model — the card itself rather than a sub-page).
 */
export function pickCardUrl(
  candidates: readonly string[],
  match: readonly string[],
): string | null {
  let best: { url: string; tokenLength: number } | null = null
  for (const url of candidates) {
    let path: string
    try {
      path = new URL(url).pathname.toLowerCase()
    } catch {
      continue
    }
    for (const token of match) {
      const needle = token.toLowerCase()
      const re = new RegExp(
        `(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`,
      )
      if (!re.test(path)) continue
      const better =
        best === null ||
        needle.length > best.tokenLength ||
        (needle.length === best.tokenLength && url.length < best.url.length)
      if (better) best = { url, tokenLength: needle.length }
    }
  }
  return best?.url ?? null
}

/**
 * Human title for a discovered card, derived from its URL slug. Only the
 * trailing `-system-card` / `-model-card` is turned into words — the hyphens
 * inside a model name (`gpt-5`, `claude-opus-4-8`) are part of the name, and
 * nothing in a slug says which hyphens are separators. Discovered titles are
 * placeholder quality by design; a reviewer polishes them in the data file.
 */
export function titleFromUrl(url: string, publisherLabel: string): string {
  const slug =
    new URL(url).pathname
      .replace(/\.(pdf|html?)$/i, '')
      .split('/')
      .filter(Boolean)
      .pop() ?? ''
  const suffix = /[-_](system|model)[-_]card$/i.exec(slug)
  const kindWords = `${suffix?.[1]?.toLowerCase() ?? 'model'} card`
  const name = suffix ? slug.slice(0, suffix.index) : slug
  if (!name) return `${publisherLabel} ${kindWords}`
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${kindWords}`
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** GET a URL, returning its text, or null on any non-OK / network failure. */
async function getText(url: string, delayMs: number): Promise<string | null> {
  await sleep(delayMs)
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.log(`    unreachable: ${url} (HTTP ${String(res.status)})`)
      return null
    }
    return await res.text()
  } catch (err) {
    console.log(`    unreachable: ${url} (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
}

/** Every <loc> in a sitemap, following nested sitemap indexes. */
async function readSitemap(url: string, delayMs: number, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  const text = await getText(url, delayMs)
  if (text === null) return []
  const locs = [...text.matchAll(LOC_RE)].map(([, loc]) => (loc ?? '').trim()).filter(Boolean)
  const out: string[] = []
  for (const loc of locs) {
    if (/\.xml(\.gz)?$/i.test(loc) || /sitemap/i.test(loc)) {
      out.push(...(await readSitemap(loc, delayMs, depth + 1)))
    } else {
      out.push(loc)
    }
  }
  return out
}

/** Card-shaped links on a hub page, restricted to the publisher's own hosts. */
export function extractLinks(html: string, pageUrl: string, cfg: PublisherConfig): string[] {
  const out: string[] = []
  for (const [, href] of html.matchAll(HREF_RE)) {
    if (href === undefined) continue
    let absolute: string
    try {
      absolute = trimUrl(new URL(href, pageUrl).toString())
    } catch {
      continue
    }
    if (!absolute.startsWith('https://')) continue
    if (!cfg.allowHosts.includes(new URL(absolute).host)) continue
    if (!cfg.linkPatterns.some((re) => re.test(absolute))) continue
    out.push(absolute)
  }
  return out
}

/** Card URLs for one publisher: sitemap entries plus hub/sibling links. */
async function discoverPublisher(cfg: PublisherConfig, delayMs: number): Promise<string[]> {
  const urls = new Set<string>()
  for (const sitemap of cfg.sitemaps) {
    for (const loc of await readSitemap(sitemap, delayMs)) {
      if (cfg.sitemapPatterns.some((re) => re.test(loc))) urls.add(trimUrl(loc))
    }
  }
  // Hubs and known cards both link siblings; the pages themselves are only
  // candidates when they were listed as known cards.
  for (const page of [...cfg.seedPages, ...(cfg.knownCards ?? [])]) {
    const html = await getText(page, delayMs)
    if (html === null) continue
    for (const link of extractLinks(html, page, cfg)) urls.add(link)
  }
  for (const known of cfg.knownCards ?? []) urls.add(trimUrl(known))
  return [...urls].sort()
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

/**
 * A single-quoted TS string literal. Emitting prettier's own quote style keeps
 * `renderFile` output byte-identical to the formatted file, so a re-run with no
 * upstream change is a true no-op for the sync workflow's `git diff --quiet`.
 */
const ts = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

export function renderFile(cards: readonly CardEntry[], today: string): string {
  const sorted = [...cards].sort((a, b) => a.modelId.localeCompare(b.modelId))
  const body = sorted
    .map(
      (c) =>
        `  ${ts(c.modelId)}: {\n` +
        `    url: ${ts(c.url)},\n` +
        `    title: ${ts(c.title)},\n` +
        `    publisher: ${ts(c.publisher)},\n` +
        `    kind: ${ts(c.kind)},\n` +
        `    asOf: ${ts(c.asOf)},\n` +
        `  },`,
    )
    .join('\n')
  return `// AUTO-GENERATED by scripts/sync-model-cards.mts. Do not edit by hand.
// Vendor-published model cards / system cards, keyed by canonical model id.
// Source of truth: scripts/data/model-cards.json.
// Absent models mean "no sourced card yet", and the UI shows no link.
// Last synced: ${today}

/** Whether a link is a card about this model, or a vendor hub listing cards. */
export type ModelCardKind = 'system-card' | 'model-card' | 'index'

export interface ModelCard {
  /** The vendor's own published page or PDF. */
  url: string
  /** Human title for the link. */
  title: string
  /** Who published it, e.g. "Anthropic". */
  publisher: string
  kind: ModelCardKind
  /**
   * ISO date the link was last reviewed. Absent on a card derived at lookup
   * time from the model id itself (see \`huggingFaceCardUrl\`), which is as
   * current as the id is.
   */
  asOf?: string
}

export const MODEL_CARDS: Record<string, ModelCard> = {
${body}
}
`
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

async function discover(data: CardDataFile, delayMs: number): Promise<number> {
  const byModel = new Map(data.cards.map((c) => [c.modelId, c]))
  const wanted = data.wanted ?? []
  const publishers = [...new Set(wanted.map((w) => w.publisher))]
  let changed = 0
  const today = new Date().toISOString().slice(0, 10)

  for (const key of publishers) {
    const cfg = PUBLISHERS[key]
    if (!cfg) continue
    console.log(`\n[${key}] discovering`)
    const candidates = await discoverPublisher(cfg, delayMs)
    console.log(`[${key}] ${String(candidates.length)} card URLs`)
    for (const want of wanted.filter((w) => w.publisher === key)) {
      const url = pickCardUrl(candidates, want.match)
      if (url === null) continue
      const existing = byModel.get(want.modelId)
      // An exact card always beats the `index` placeholder; never overwrite a
      // reviewed per-model card with a differently-matched URL.
      if (existing && existing.kind !== 'index') continue
      if (existing?.url === url) continue
      const entry: CardEntry = {
        modelId: want.modelId,
        publisher: cfg.label,
        kind: cfg.kind,
        title: titleFromUrl(url, cfg.label),
        url,
        source: `Discovered by scripts/sync-model-cards.mts --discover from ${cfg.label}'s published card index on ${today}.`,
        asOf: today,
      }
      byModel.set(want.modelId, entry)
      changed += 1
      console.log(`    ${want.modelId} → ${url}`)
    }
  }
  data.cards = [...byModel.values()].sort((a, b) => a.modelId.localeCompare(b.modelId))
  data.wanted = graduateWanted(wanted, data.cards)
  return changed
}

/**
 * Drop a model from `wanted` once it holds a real per-model card. `wanted` is a
 * statement of outstanding intent — leaving a satisfied model there makes every
 * later run re-solicit a card it already has, and hides which models are still
 * missing one. A model whose only card is an `index` placeholder stays wanted,
 * because the exact card is still outstanding.
 */
export function graduateWanted(
  wanted: readonly WantedCard[],
  cards: readonly CardEntry[],
): WantedCard[] {
  const carded = new Set(cards.filter((c) => c.kind !== 'index').map((c) => c.modelId))
  return wanted.filter((w) => !carded.has(w.modelId))
}

async function verify(data: CardDataFile, delayMs: number): Promise<void> {
  const dead: string[] = []
  // One check per distinct URL: the Anthropic hub is shared by every Claude id.
  for (const url of [...new Set(data.cards.map((c) => c.url))]) {
    const text = await getText(url, delayMs)
    if (text === null) dead.push(url)
  }
  if (dead.length > 0) {
    throw new Error(
      `[sync-model-cards] Refusing to write cards — unreachable card URLs:\n  - ${dead.join('\n  - ')}\n` +
        `Re-check the vendor's card index and update scripts/data/model-cards.json (or drop the entry — no link beats a dead link).`,
    )
  }
  console.log(`[sync-model-cards] Verified ${String(data.cards.length)} card links.`)
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const wantDiscover = argv.includes('--discover')
  const wantVerify = argv.includes('--verify')
  const delayArg = argv.find((a) => a.startsWith('--delay='))
  const delayMs = delayArg ? Number(delayArg.slice('--delay='.length)) * 1000 : 1000

  const raw: unknown = JSON.parse(await readFile(DATA_PATH, 'utf8'))
  const data = dataFileSchema.parse(raw)

  let dataChanged = 0
  if (wantDiscover) dataChanged = await discover(data, delayMs)
  validateCards(data)
  if (wantVerify) await verify(data, delayMs)

  if (dataChanged > 0) {
    // Rewrite the reviewed file in place, keeping its `$comment` (the sourcing
    // rules) at the top where the next reviewer will read it.
    const json = await formatGenerated(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`)
    await writeFile(DATA_PATH, json, 'utf8')
    console.log(`[sync-model-cards] Discovery updated ${String(dataChanged)} card(s).`)
  }

  const today = new Date().toISOString().slice(0, 10)
  const content = renderFile(data.cards, today)
  // Ignore the header date when deciding whether anything changed, so a re-run
  // on a quiet day is a true no-op for the sync workflow's `git diff --quiet`.
  // Discovery may still have updated the reviewed JSON above without moving any
  // emitted field — that write already happened and already logged.
  if (!(await writeGeneratedFile(GENERATED_PATH, content))) {
    console.log(`[sync-model-cards] No changes for ${String(data.cards.length)} cards.`)
    return
  }
  console.log(
    `[sync-model-cards] Wrote ${String(data.cards.length)} cards to ${GENERATED_PATH} (synced ${today}).`,
  )
}

const invokedDirectly = process.argv[1]?.endsWith('sync-model-cards.mts') === true
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
