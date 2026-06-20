/**
 * Pure helpers for turning an MCP tool's `inputSchema` into the JSON Schema
 * object copse-panel hands to LLM providers, plus result flattening.
 */

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} } as const

/**
 * MCP tool input schemas are JSON Schema objects. Most providers expect a
 * top-level `{ type: "object", properties: {...} }`. We pass the schema through
 * largely untouched but guarantee that shape so providers never reject the tool.
 */
export function sanitizeMcpInputSchema(inputSchema: unknown): Record<string, unknown> {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return { ...EMPTY_OBJECT_SCHEMA }
  }
  const schema = inputSchema as Record<string, unknown>
  const out: Record<string, unknown> = { ...schema }

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
