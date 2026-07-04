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
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { ...EMPTY_OBJECT_SCHEMA }
  }
  const out = sanitizeNode(inputSchema, 0) as Record<string, unknown>

  if (out['type'] !== 'object') out['type'] = 'object'
  if (!out['properties'] || typeof out['properties'] !== 'object') out['properties'] = {}

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

function uiResourceMimeType(resource: { mimeType?: string } | undefined): string | null {
  const mime = typeof resource?.mimeType === 'string' ? resource.mimeType.toLowerCase() : ''
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
  for (const raw of content as McpContentBlock[]) {
    // raw comes from an untrusted MCP server via an `as`-cast, so it may be null/undefined at runtime.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!raw || typeof raw !== 'object' || raw.type !== 'resource') continue
    const mime = uiResourceMimeType(raw.resource)
    if (!mime) continue
    const text = typeof raw.resource?.text === 'string' ? raw.resource.text : ''
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_UI_RESOURCE_BYTES) continue
    out.push({
      uri: typeof raw.resource?.uri === 'string' ? raw.resource.uri : '',
      mimeType: mime,
      text,
    })
  }
  return out
}

/** Short, model-facing descriptor for a UI resource rendered in the canvas. */
function describeUiResource(resource: { uri?: string; mimeType?: string; text?: string }): string {
  const label = resource.uri || resource.mimeType || 'ui resource'
  const bytes = typeof resource.text === 'string' ? Buffer.byteLength(resource.text, 'utf8') : 0
  const size = bytes ? ` (${resource.mimeType ?? 'unknown'}, ${(bytes / 1024).toFixed(1)} KB)` : ''
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
  for (const raw of content as McpContentBlock[]) {
    // raw comes from an untrusted MCP server via an `as`-cast, so it may be null/undefined at runtime.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
        const uri = typeof raw['uri'] === 'string' ? raw['uri'] : ''
        parts.push(`[resource link: ${uri}]`)
        break
      }
      case 'resource':
        if (options.summarizeUiResources && raw.resource && uiResourceMimeType(raw.resource)) {
          parts.push(describeUiResource(raw.resource))
        } else if (raw.resource?.text) {
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
