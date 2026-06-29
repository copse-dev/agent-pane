// Shared parsing for streamed tool-call argument JSON. Both the Anthropic and
// OpenAI providers accumulate tool arguments as a JSON string across stream
// deltas, then parse it once the tool block completes. A malformed or truncated
// payload must NOT silently degrade to empty args (which would run the tool with
// no input); instead we surface an `error` so the agent loop can return an
// is_error tool result and let the model retry the call. See #114.

import { errorMessage } from '@shared/errors.ts'

export interface ParsedToolArgs {
  /** Parsed args on success; `{}` when there were no args; `{}` on failure. */
  args: unknown
  /** Human-readable parse error when the JSON could not be parsed. */
  error?: string
}

/** Cap the raw snippet we echo back so a huge truncated payload can't bloat history. */
const MAX_RAW_SNIPPET = 500

export function parseToolArgs(rawJson: string | undefined | null): ParsedToolArgs {
  const trimmed = (rawJson ?? '').trim()
  // No streamed arguments at all means a no-arg tool call — that is valid.
  if (trimmed === '') return { args: {} }
  try {
    return { args: JSON.parse(trimmed) }
  } catch (err) {
    const reason = errorMessage(err)
    const snippet =
      trimmed.length > MAX_RAW_SNIPPET ? `${trimmed.slice(0, MAX_RAW_SNIPPET)}…` : trimmed
    return {
      args: {},
      error: `Could not parse tool arguments as JSON (${reason}). Raw arguments: ${snippet}`,
    }
  }
}
