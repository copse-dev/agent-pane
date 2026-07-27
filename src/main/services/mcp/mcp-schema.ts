import { firstNonEmptyString, isRecord } from '@shared/unknown-value.ts'

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
  if (!isRecord(value)) return value

  const out: Record<string, unknown> = {}
  let propCount = 0
  for (const [key, v] of Object.entries(value)) {
    if (STRIPPED_KEYS.has(key)) continue
    if (propCount >= MAX_PROPERTIES) break
    propCount++
    if (key === 'enum' && Array.isArray(v)) {
      out['enum'] = v.slice(0, MAX_ENUM_ENTRIES)
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
  if (!isRecord(inputSchema)) {
    return { ...EMPTY_OBJECT_SCHEMA }
  }
  const sanitized = sanitizeNode(inputSchema, 0)
  const out = isRecord(sanitized) ? sanitized : { ...EMPTY_OBJECT_SCHEMA }

  if (out['type'] !== 'object') out['type'] = 'object'
  if (!out['properties'] || typeof out['properties'] !== 'object') out['properties'] = {}

  return out
}

// Embedded `resource` blocks the MCP-UI / "MCP Apps" convention uses to ship
// renderable UI. `text/html` carries a self-contained document; `text/uri-list`
// carries an external URL the host loads itself. By convention these use a
// `ui://` URI, but we key off the mime type so servers that omit the scheme
// still work. See the canvas exploration issue for the rendering plan.
const UI_RESOURCE_MIME_TYPES = new Set(['text/html', 'text/uri-list'])

// Cap how much artefact payload we accept so a hostile/oversized resource can't
// blow up the renderer or the model transcript. Larger payloads are still
// announced to the model but their body is dropped from the side-channel.
const MAX_UI_RESOURCE_BYTES = 512 * 1024

export interface McpUiResource {
  /** Resource URI (e.g. `ui://component/dashboard`), or '' when absent. */
  uri: string
  mimeType: string
  /** Inline payload: an HTML document, or a URL list for `text/uri-list`. */
  text: string
}

function uiResourceMimeType(resource: unknown): string | null {
  const mime =
    isRecord(resource) && typeof resource['mimeType'] === 'string'
      ? resource['mimeType'].toLowerCase()
      : ''
  return UI_RESOURCE_MIME_TYPES.has(mime) ? mime : null
}

/**
 * Pull MCP-UI resources out of a tool-call result so the host can render them as
 * sandboxed artefacts. Defensive against untrusted servers: skips non-objects,
 * requires a recognised mime type, and drops oversized payloads. Returns [] when
 * the content carries no renderable UI.
 */
export function extractUiResources(content: unknown): McpUiResource[] {
  if (!Array.isArray(content)) return []
  const out: McpUiResource[] = []
  const blocks: unknown[] = content
  for (const raw of blocks) {
    if (!isRecord(raw) || raw['type'] !== 'resource') continue
    const resource = raw['resource']
    const mime = uiResourceMimeType(resource)
    if (!mime) continue
    if (!isRecord(resource)) continue
    const text = typeof resource['text'] === 'string' ? resource['text'] : ''
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_UI_RESOURCE_BYTES) continue
    out.push({
      uri: typeof resource['uri'] === 'string' ? resource['uri'] : '',
      mimeType: mime,
      text,
    })
  }
  return out
}

/** Short, model-facing descriptor for a UI resource rendered in the canvas. */
function describeUiResource(resource: Record<string, unknown>): string {
  const uri = typeof resource['uri'] === 'string' ? resource['uri'] : undefined
  const mimeType = typeof resource['mimeType'] === 'string' ? resource['mimeType'] : undefined
  const text = typeof resource['text'] === 'string' ? resource['text'] : undefined
  const label = firstNonEmptyString(uri, mimeType) ?? 'ui resource'
  const bytes = text === undefined ? 0 : Buffer.byteLength(text, 'utf8')
  const size = bytes ? ` (${mimeType ?? 'unknown'}, ${(bytes / 1024).toFixed(1)} KB)` : ''
  return `[ui resource: ${label}${size} — rendered in the canvas]`
}

export interface FlattenOptions {
  /**
   * When set, embedded UI resources (`text/html` / `text/uri-list`) are replaced
   * with a compact descriptor instead of having their full body inlined, so the
   * raw artefact payload stays out of the model's context window. Off by default
   * to preserve the legacy transcript shape.
   */
  summarizeUiResources?: boolean
}

/** Flatten an MCP tool-call result `content` array into a single string for the model. */
export function flattenMcpContent(content: unknown, options: FlattenOptions = {}): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : ''
  }

  const parts: string[] = []
  const blocks: unknown[] = content
  for (const raw of blocks) {
    if (!isRecord(raw)) continue
    switch (raw['type']) {
      case 'text':
        if (typeof raw['text'] === 'string') parts.push(raw['text'])
        break
      case 'image':
        parts.push(
          `[image${typeof raw['mimeType'] === 'string' ? ` ${raw['mimeType']}` : ''} omitted]`,
        )
        break
      case 'audio':
        parts.push(
          `[audio${typeof raw['mimeType'] === 'string' ? ` ${raw['mimeType']}` : ''} omitted]`,
        )
        break
      case 'resource_link': {
        const uri = typeof raw['uri'] === 'string' ? raw['uri'] : ''
        parts.push(`[resource link: ${uri}]`)
        break
      }
      case 'resource': {
        const resource = raw['resource']
        if (!isRecord(resource)) break
        if (options.summarizeUiResources && uiResourceMimeType(resource)) {
          parts.push(describeUiResource(resource))
        } else if (typeof resource['text'] === 'string' && resource['text']) {
          parts.push(resource['text'])
        } else if (typeof resource['uri'] === 'string' && resource['uri']) {
          parts.push(`[resource: ${resource['uri']}]`)
        }
        break
      }
      default:
        if (typeof raw['text'] === 'string') parts.push(raw['text'])
    }
  }

  return parts.join('\n')
}
