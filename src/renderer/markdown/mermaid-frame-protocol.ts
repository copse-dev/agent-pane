// The entire capability surface of a diagram frame: never return markup, URLs,
// or native-operation requests from an untrusted rendering context.
export const MAX_DIAGRAM_SOURCE_LENGTH = 50_000
export const MAX_DIAGRAM_DIMENSION = 4096

export interface DiagramSize {
  width: number
  height: number
}

export function parseDiagramSize(value: unknown): DiagramSize | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('type' in value) || value.type !== 'rendered') return null
  if (!('width' in value) || !('height' in value)) return null
  const { width, height } = value
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    return null
  return {
    width: Math.min(width, MAX_DIAGRAM_DIMENSION),
    height: Math.min(height, MAX_DIAGRAM_DIMENSION),
  }
}

export function parseDiagramSource(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('type' in value) || value.type !== 'render') return null
  if (!('source' in value) || typeof value.source !== 'string') return null
  return value.source.length <= MAX_DIAGRAM_SOURCE_LENGTH ? value.source : null
}
