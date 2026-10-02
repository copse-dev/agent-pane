/**
 * Request fields that never take part in OpenAI's prefix cache match: the
 * transport flag and the output ceiling. Everything else (model, tools,
 * reasoning, `prompt_cache_key`, ...) must be byte-identical between turns of
 * one thread for the cached prefix to survive.
 */
const NON_PREFIX_FIELDS: ReadonlySet<string> = new Set(['stream', 'max_output_tokens'])

export interface PrefixDivergence {
  /** Where the requests first differ: a request field, or an `input` item. */
  field: string
  /** Index of the first differing `input` item, when `field` is `input`. */
  index?: number
  previous: string
  next: string
}

export interface PrefixComparison {
  divergence: PrefixDivergence | null
  /** Characters of the previous request's serialized `input` that the next one reproduces. */
  sharedInputChars: number
  /** Characters of the previous request's serialized `input`. */
  previousInputChars: number
}

function serialize(value: unknown): string {
  // Wrapped so a missing field (`undefined`, which `JSON.stringify` alone maps
  // to `undefined`) still serializes to a string.
  return JSON.stringify([value])
}

function inputItems(body: Record<string, unknown>): unknown[] {
  return Array.isArray(body['input']) ? body['input'] : []
}

/**
 * Compare two consecutive request bodies of one thread. The next request may
 * only differ from the previous one by items appended to `input`; the first
 * thing that breaks that is reported. Diagnostic and test support: it reads
 * bodies, it never changes what is sent.
 */
export function compareRequestPrefix(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): PrefixComparison {
  const previousItems = inputItems(previous)
  const nextItems = inputItems(next)
  const previousInputChars = previousItems.reduce<number>(
    (sum, item) => sum + serialize(item).length,
    0,
  )

  const fields = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const field of [...fields].sort()) {
    if (field === 'input' || NON_PREFIX_FIELDS.has(field)) continue
    const before = serialize(previous[field])
    const after = serialize(next[field])
    if (before !== after) {
      return {
        divergence: { field, previous: before, next: after },
        sharedInputChars: 0,
        previousInputChars,
      }
    }
  }

  let sharedInputChars = 0
  for (let index = 0; index < previousItems.length; index++) {
    const before = serialize(previousItems[index])
    const after = index < nextItems.length ? serialize(nextItems[index]) : 'missing'
    if (before !== after) {
      return {
        divergence: { field: 'input', index, previous: before, next: after },
        sharedInputChars,
        previousInputChars,
      }
    }
    sharedInputChars += before.length
  }
  return { divergence: null, sharedInputChars, previousInputChars }
}

/** Human-readable one-liner for assertion messages and reports. */
export function describeDivergence(divergence: PrefixDivergence | null): string {
  if (!divergence) return 'prefix stable'
  const where =
    divergence.field === 'input' ? `input[${String(divergence.index)}]` : divergence.field
  const clip = (text: string): string => (text.length > 160 ? `${text.slice(0, 160)}…` : text)
  return `${where} changed: ${clip(divergence.previous)} -> ${clip(divergence.next)}`
}
