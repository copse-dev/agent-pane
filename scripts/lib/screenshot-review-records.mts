import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'
import { screenshotHash } from './screenshot-manifest.mts'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/)
export const reviewMode = z.enum(['pr', 'batch', 'release'])
export const classification = z.enum([
  'intentional',
  'drift',
  'instability',
  'breakage',
  'unresolved',
])
const image = z
  .object({
    sha256: hash,
    bytes: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict()
const item = z
  .object({
    id: z.string(),
    kind: z.enum(['committed', 'candidate']),
    name,
    before: image.nullable(),
    after: image.nullable(),
    key: hash,
  })
  .strict()
export const evidenceSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/),
    pr: z.number().int().positive(),
    mode: reviewMode,
    base: z.string().regex(/^[a-f0-9]{40}$/),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    compare: z.string().regex(/^[a-f0-9]{40}$/),
    run: z.string().regex(/^[1-9][0-9]*$/),
    context: z.string().trim().min(1).max(8000),
  })
  .strict()
const packetSchema = z
  .object({
    version: z.literal(1),
    evidence: evidenceSchema,
    fingerprint: hash,
    items: z.array(item),
  })
  .strict()
const receiptSchema = z
  .object({
    key: hash,
    fingerprint: hash,
    classification,
    note: z.string().trim().min(1).max(8000),
    reviewedAt: z.iso.datetime(),
  })
  .strict()
const ledgerSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema) }).strict()
export type ReviewEvidence = z.infer<typeof evidenceSchema>
export type ReviewImage = z.infer<typeof image>
export type ReviewItem = z.infer<typeof item>
export type ReviewPacket = z.infer<typeof packetSchema>
export type ReviewLedger = z.infer<typeof ledgerSchema>
export type ReviewClassification = z.infer<typeof classification>

function digest(value: unknown): string {
  return screenshotHash(Buffer.from(JSON.stringify(value)))
}

export function reviewItemKey(evidence: ReviewEvidence, entry: Omit<ReviewItem, 'key'>): string {
  return digest([
    evidence.repository,
    evidence.pr,
    evidence.mode,
    entry.kind,
    entry.name,
    entry.before,
    entry.after,
  ])
}

export function makeReviewPacket(
  evidence: ReviewEvidence,
  entries: Omit<ReviewItem, 'key'>[],
): ReviewPacket {
  const checked = evidenceSchema.parse(evidence)
  return packetSchema.parse({
    version: 1,
    evidence: checked,
    fingerprint: digest(checked),
    items: entries.map((entry) => ({ ...entry, key: reviewItemKey(checked, entry) })),
  })
}

export function parseReviewPacket(text: string): ReviewPacket {
  const parsed = safeJsonParse(text, decodeWithSchema(packetSchema))
  if (
    !parsed ||
    parsed.fingerprint !== digest(parsed.evidence) ||
    new Set(parsed.items.map((entry) => entry.id)).size !== parsed.items.length ||
    parsed.items.some(
      (entry) =>
        entry.key !== reviewItemKey(parsed.evidence, entry) ||
        entry.id !== `${entry.kind}/${entry.name}`,
    )
  )
    throw new Error('Invalid review packet')
  return parsed
}

export function parseReviewLedger(text: string): ReviewLedger {
  const parsed = safeJsonParse(text, decodeWithSchema(ledgerSchema))
  if (!parsed) throw new Error('Invalid review ledger; preserve it and repair explicitly')
  return parsed
}

/** Records are local working notes, never a CI attestation or a gate decision. */
export function recordReview(
  packet: ReviewPacket,
  ledger: ReviewLedger,
  id: string,
  verdict: ReviewClassification,
  note: string,
): ReviewLedger {
  const entry = packet.items.find((entry) => entry.id === id)
  if (!entry) throw new Error(`Unknown review item: ${id}`)
  const receipt = receiptSchema.parse({
    key: entry.key,
    fingerprint: packet.fingerprint,
    classification: verdict,
    note,
    reviewedAt: new Date().toISOString(),
  })
  return {
    version: 1,
    receipts: [
      ...ledger.receipts.filter(
        (old) => old.key !== receipt.key || old.fingerprint !== receipt.fingerprint,
      ),
      receipt,
    ],
  }
}

export function reviewProgress(
  packet: ReviewPacket,
  ledger: ReviewLedger,
): (ReviewItem & { state: string; receipt: z.infer<typeof receiptSchema> | null })[] {
  return packet.items.map((entry) => {
    const matching = ledger.receipts.filter((receipt) => receipt.key === entry.key)
    const current = matching.findLast((receipt) => receipt.fingerprint === packet.fingerprint)
    const previous = matching.at(-1)
    return {
      ...entry,
      state: current ? 'recorded' : previous ? 'revalidate' : 'unreviewed',
      receipt: current ?? previous ?? null,
    }
  })
}
