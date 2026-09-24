import { z } from 'zod'
import { isRecord } from '@copse/std/unknown-value.ts'

/**
 * Salvage near-miss tool-call arguments instead of bouncing them.
 *
 * GPT-family models read `max_results` as "how much can I ask for" and call
 * `find_files` with 500 or 2000 — past every `.max(N)` the schema declares.
 * The schema error is accurate but useless to the model's *intent*: a display
 * cap like this survives clamping perfectly, while a hard failure costs a
 * failed tool round trip plus a retry that gets the cap wrong all over again.
 *
 * The repair is deliberately narrower than the schemas it repairs. It only
 * fires when the parse failed purely on numeric range: every issue is
 * `too_big`/`too_small` with `origin: 'number'`, and the arguments actually
 * hold a finite number at each failing path. Anything else — wrong types,
 * missing fields, enum misses, a string too long — returns `null` and the
 * plain schema error is reported, because that shape of call needs a real
 * retry.
 */

/** Read the member `segment` names on an array or plain object, else `undefined`. */
function readMember(container: unknown, segment: PropertyKey): unknown {
  if (Array.isArray(container)) {
    if (typeof segment !== 'number' || segment < 0 || segment >= container.length) return undefined
    return container[segment]
  }
  if (!isRecord(container) || !Object.hasOwn(container, segment)) return undefined
  return container[String(segment)]
}

/** Walk `path` through the arguments, returning the value it names. */
function valueAtPath(args: Record<string, unknown>, path: readonly PropertyKey[]): unknown {
  let current: unknown = args
  for (const segment of path) current = readMember(current, segment)
  return current
}

/**
 * `container` with `value` set at `path`, copying every array and object the
 * path crosses — the caller's arguments are never mutated in place, so a
 * failed re-parse can't leave a half-repaired object behind.
 */
function withValueAtPath(container: unknown, path: readonly PropertyKey[], value: number): unknown {
  const [head, ...rest] = path
  if (head === undefined) return container
  const inner = rest.length ? withValueAtPath(readMember(container, head), rest, value) : value
  if (Array.isArray(container)) {
    const copy = container.slice()
    if (typeof head === 'number') copy[head] = inner
    return copy
  }
  if (typeof container === 'object' && container !== null) {
    const record: Record<string, unknown> = { ...container }
    record[String(head)] = inner
    return record
  }
  // Not a container: a path through a scalar cannot name a clamped value, and
  // clampNumericRangeArgs has already read a number at this path, so drop the
  // write rather than inventing structure the caller never passed.
  return container
}

/**
 * Clamp the numeric-range misses a `ZodError` describes. Returns `null` when
 * the error carries any issue this repair does not recognise, so a genuinely
 * wrong call keeps its real schema error.
 */
export function clampNumericRangeArgs(
  err: z.ZodError,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; notes: string[] } | null {
  if (err.issues.length === 0) return null
  const notes: string[] = []
  let repaired: Record<string, unknown> = args
  for (const issue of err.issues) {
    // Only the numeric too-big/too-small union has the bounds this repair
    // needs. The clamped value is read from the arguments at `path`, not from
    // the issue's captured `value`, so only a number the caller passed can be
    // rewritten.
    if ((issue.code !== 'too_big' && issue.code !== 'too_small') || issue.origin !== 'number') {
      return null
    }
    // `Number` flattens the per-code bound fields into one number; a missing
    // bound becomes NaN and is refused, keeping the repair all-or-nothing.
    const bound = issue.code === 'too_big' ? Number(issue.maximum) : Number(issue.minimum)
    if (!Number.isFinite(bound)) return null
    const current = valueAtPath(repaired, issue.path)
    if (typeof current !== 'number' || !Number.isFinite(current)) return null
    const clamped = issue.inclusive ? bound : issue.code === 'too_big' ? bound - 1 : bound + 1
    if (current === clamped) continue
    const written = withValueAtPath(repaired, issue.path, clamped)
    if (!isRecord(written)) return null
    repaired = written
    notes.push(`${formatArgPath(issue.path)} — clamped to ${String(clamped)}`)
  }
  if (notes.length === 0) return null
  return { args: repaired, notes }
}

/**
 * Clamp notes are Copse-authored context, so they enter the tool result as a
 * system-reminder block the same way hook-injected context does (see
 * inject-context.ts). The list mirrors the schema-error report's cap: past a
 * handful of fields the model needs to re-read the schema rather than work
 * through a longer list.
 */
const MAX_REPORTED_CLAMPED_FIELDS = 5

/** One sentence naming every clamped field, capped like the schema error list. */
export function describeClampRepair(notes: readonly string[]): string {
  const listed = notes.slice(0, MAX_REPORTED_CLAMPED_FIELDS)
  const remaining = notes.length - listed.length
  if (remaining > 0) listed.push(`and ${String(remaining)} more`)
  return `Arguments were clamped to schema bounds: ${listed.join('; ')}.`
}

/**
 * `['todos', 0, 'content']` → `todos[0].content`, the bracket/dot form the
 * model sees in its own arguments. Local to this module so the repair note
 * cannot drift from the issue formatting in tool-arg-error.ts.
 */
function formatArgPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`
    else out += out ? `.${String(segment)}` : String(segment)
  }
  return out
}
