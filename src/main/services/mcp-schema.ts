/**
 * Pure helpers for turning an MCP tool's `inputSchema` into the JSON Schema
 * object copse-panel hands to LLM providers, plus result flattening.
 */

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} } as const

// MCP servers are untrusted: a hostile server can ship an input schema crafted
// to blow up the provider request (deep recursion, `$ref` cycles, enormous
// `enum`s / property maps). These bounds keep the schema we forward sane.
const MAX_DEPTH = 8
const MAX_ENUM_ENTRIES = 100
const MAX_PROPERTIES = 200
const MAX_ARRAY_ENTRIES = 200
// Reference/expansion keywords are the recursion vector — drop them outright
// rather than try to resolve attacker-controlled pointers.
const STRIPPED_KEYS = new Set([
  '$ref',
  '$defs',
  '$dynamicRef',
  '$dynamicAnchor',
  '$recursiveRef',
  '$recursiveAnchor',
  'definitions',
])

function sanitizeNode(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH) return {}
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ENTRIES).map((v) => sanitizeNode(v, depth + 1))
  }
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  let propCount = 0
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (STRIPPED_KEYS.has(key)) continue
    if (propCount >= MAX_PROPERTIES) break
    propCount++
    if (key === 'enum' && Array.isArray(v)) {
      out.enum = v.slice(0, MAX_ENUM_ENTRIES)
    } else {
      out[key] = sanitizeNode(v, depth + 1)
    }
  }
  return out
}

/**
 * MCP tool input schemas are JSON Schema objects. Most providers expect a
 * top-level `{ type: "object", properties: {...} }`. We sanitize the schema —
 * bounding depth/size and stripping reference keywords so an untrusted server
 * can't inject recursion or oversized payloads — and guarantee that shape so
 * providers never reject the tool.
 */
export function sanitizeMcpInputSchema(inputSchema: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { ...EMPTY_OBJECT_SCHEMA }
  }
  const out = sanitizeNode(inputSchema, 0) as Record<string, unknown>

  if (out.type !== 'object') out.type = 'object'
  if (!out.properties || typeof out.properties !== 'object') out.properties = {}

  return out
}

interface McpContentBlock {
  type?: string
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
  [key: string]: unknown
}

/** Flatten an MCP tool-call result `content` array into a single string for the model. */
export function flattenMcpContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : ''
  }

  const parts: string[] = []
  for (const raw of content as McpContentBlock[]) {
    if (!raw || typeof raw !== 'object') continue
    switch (raw.type) {
      case 'text':
        if (typeof raw.text === 'string') parts.push(raw.text)
        break
      case 'image':
        parts.push(`[image${raw.mimeType ? ` ${raw.mimeType}` : ''} omitted]`)
        break
      case 'audio':
        parts.push(`[audio${raw.mimeType ? ` ${raw.mimeType}` : ''} omitted]`)
        break
      case 'resource_link': {
        const uri = typeof raw.uri === 'string' ? raw.uri : ''
        parts.push(`[resource link: ${uri}]`)
        break
      }
      case 'resource':
        if (raw.resource?.text) {
          parts.push(raw.resource.text)
        } else if (raw.resource?.uri) {
          parts.push(`[resource: ${raw.resource.uri}]`)
        }
        break
      default:
        if (typeof raw.text === 'string') parts.push(raw.text)
    }
  }

  return parts.join('\n')
}
