import { createHash } from 'node:crypto'
import type { StoredThreadPlan } from '@copse/thread-store/plan-schema.ts'

function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('Plan authority contains an unsupported value')
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Opaque receipt for every plan field that can change inference authority. */
export function mobilePlanAuthorityHash(plan: StoredThreadPlan): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        meta: plan.meta,
        body: plan.body,
        contentHash: plan.contentHash,
        comments: plan.comments,
        approval: plan.approval,
        completion: plan.completion,
      }),
    )
    .digest('hex')
}
