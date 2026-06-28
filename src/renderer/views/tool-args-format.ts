function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function displayValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function parseJsonString(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed || !/^[{[]/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return parseJsonString(value)
  return value
}

function normalizeDeep(value: unknown): unknown {
  const normalized = normalizeValue(value)
  if (Array.isArray(normalized)) return normalized.map(normalizeDeep)
  if (!isRecord(normalized)) return normalized
  return Object.fromEntries(
    Object.entries(normalized).map(([key, entry]) => [key, normalizeDeep(entry)]),
  )
}

function indentLines(value: string, indent: number): string {
  const pad = ' '.repeat(indent)
  return value
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n')
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function terminalPayloadFrom(value: unknown): {
  status: 'success' | 'error' | null
  payload: Record<string, unknown>
  meta: Record<string, unknown>
} | null {
  const normalized = normalizeDeep(value)
  if (!isRecord(normalized)) return null

  const success = normalizeValue(normalized['success'])
  if (isRecord(success)) {
    const { success: _success, error: _error, ...meta } = normalized
    return { status: 'success', payload: success, meta }
  }

  const error = normalizeValue(normalized['error'])
  if (isRecord(error)) {
    const { success: _success, error: _error, ...meta } = normalized
    return { status: 'error', payload: error, meta }
  }

  if (isTerminalPayload(normalized)) return { status: null, payload: normalized, meta: {} }
  return null
}

function isTerminalPayload(value: Record<string, unknown>): boolean {
  return (
    typeof value['command'] === 'string' ||
    typeof value['stdout'] === 'string' ||
    typeof value['stderr'] === 'string' ||
    typeof value['interleavedOutput'] === 'string' ||
    typeof value['exitCode'] === 'number' ||
    typeof value['localExecutionTimeMs'] === 'number'
  )
}

function firstPresent(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null)
}

function appendMultiline(lines: string[], label: string, value: unknown): void {
  const text = optionalString(value)
  if (!text) return
  lines.push(`${label}:`)
  lines.push(indentLines(text.replace(/\n+$/, ''), 2))
}

function appendScalar(lines: string[], label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return
  lines.push(`${label}: ${displayValue(value)}`)
}

function formatTerminalPayload(value: unknown): string | null {
  const terminal = terminalPayloadFrom(value)
  if (!terminal) return null

  const { status, payload, meta } = terminal
  const lines: string[] = []
  appendMultiline(lines, 'Command', firstPresent(payload['command'], meta['command']))

  const stdout = firstPresent(payload['stdout'], payload['output'])
  appendMultiline(lines, 'Output', stdout)

  const stderr = firstPresent(payload['stderr'], payload['errorOutput'])
  appendMultiline(lines, 'Error output', stderr)

  const interleaved = optionalString(payload['interleavedOutput'])
  if (interleaved && interleaved !== stdout && interleaved !== stderr) {
    appendMultiline(lines, 'Interleaved output', interleaved)
  }

  appendScalar(lines, 'Exit code', payload['exitCode'])
  appendScalar(lines, 'Local execution time', payload['localExecutionTimeMs'])
  appendScalar(lines, 'Timeout', meta['timeout'])
  appendScalar(lines, 'Background', firstPresent(payload['isBackground'], meta['isBackground']))
  appendScalar(lines, 'Status', status)

  return lines.join('\n')
}

function entriesForDisplay(value: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(value).filter(([key, entry]) => {
    if (key === 'interleavedOutput' && entry === value['stdout']) return false
    return true
  })
}

function unwrapResultEnvelope(value: unknown): unknown {
  value = normalizeValue(value)
  if (!isRecord(value)) return value
  const entries = Object.entries(value)
  if (entries.length !== 1) return value
  const [key, rawEntry] = entries[0]!
  const entry = normalizeValue(rawEntry)
  if ((key === 'success' || key === 'error') && isRecord(entry)) return entry
  return value
}

function formatReadableValue(value: unknown, indent = 0): string {
  const unwrapped = unwrapResultEnvelope(value)
  if (Array.isArray(unwrapped)) {
    return unwrapped
      .map((entry, index) => {
        const rendered = formatReadableValue(entry, indent + 2)
        return `${' '.repeat(indent)}- ${index}:${
          rendered.includes('\n') ? `\n${rendered}` : ` ${rendered.trim()}`
        }`
      })
      .join('\n')
  }
  if (!isRecord(unwrapped)) return `${' '.repeat(indent)}${displayValue(unwrapped)}`

  return entriesForDisplay(unwrapped)
    .map(([key, rawEntry]) => {
      const entry = normalizeValue(rawEntry)
      const pad = ' '.repeat(indent)
      if (typeof entry === 'string' && entry.includes('\n')) {
        return `${pad}${key}:\n${indentLines(entry.replace(/\n+$/, ''), indent + 2)}`
      }
      if (isRecord(entry) || Array.isArray(entry)) {
        return `${pad}${key}:\n${formatReadableValue(entry, indent + 2)}`
      }
      return `${pad}${key}: ${displayValue(entry)}`
    })
    .join('\n')
}

export function renderToolArgs(args: unknown): string {
  if (args === undefined) return ''
  try {
    return formatTerminalPayload(args) ?? formatReadableValue(args)
  } catch {
    return JSON.stringify(args, null, 2)
  }
}
