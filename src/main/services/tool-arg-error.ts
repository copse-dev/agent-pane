import { z } from 'zod'

/**
 * Readable failures for tool arguments that don't match the tool's schema.
 *
 * A `ZodError`'s own `message` is the pretty-printed `issues` array, so letting
 * it reach the transcript prints a wall of JSON at the user — and gives the
 * model a payload to parse rather than a sentence to act on. A near-miss plan
 * from a smaller model (a todo whose `content` never made it into the call)
 * turned into forty lines of `{"expected": "string", "code": "invalid_type"…}`
 * in the chat, with the actual problem buried in it.
 *
 * The tool result is read by both audiences, so the text has to serve both:
 * short enough for a person to skim, specific enough that the model's retry
 * fixes the right field.
 */

/**
 * Field problems worth listing. Past a handful the model needs to re-read the
 * schema rather than work through a longer list, and the transcript is better
 * served by a count than by the rest.
 */
const MAX_REPORTED_ISSUES = 5

/**
 * `['todos', 0, 'content']` → `todos[0].content`. Zod paths interleave object
 * keys with array indices, and the bracket/dot form is what the model sees in
 * its own arguments, so it can find the field without translating.
 */
function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`
    else out += out ? `.${String(segment)}` : String(segment)
  }
  return out
}

/** One `path — problem` line; the path is dropped when the whole value is wrong. */
function formatIssue(issue: z.core.$ZodIssue): string {
  // "Invalid input: expected string, received undefined" — the prefix repeats
  // what the sentence around it already says, so keep only the specific half.
  const detail = issue.message.replace(/^invalid input:\s*/i, '')
  const path = formatPath(issue.path)
  return path ? `${path} — ${detail}` : detail
}

/**
 * A sentence naming the fields that failed validation, for a tool call whose
 * arguments did not match its schema. Returns `null` for anything that is not a
 * `ZodError`, so execution failures from inside a tool keep their own message.
 */
export function describeToolArgError(toolName: string, err: unknown): string | null {
  if (!(err instanceof z.ZodError) || err.issues.length === 0) return null
  const listed = err.issues.slice(0, MAX_REPORTED_ISSUES).map(formatIssue)
  const remaining = err.issues.length - listed.length
  if (remaining > 0) listed.push(`and ${String(remaining)} more`)
  return (
    `${toolName}: the arguments did not match the tool's schema. ` +
    `${listed.join('; ')}. Correct them and call the tool again.`
  )
}
