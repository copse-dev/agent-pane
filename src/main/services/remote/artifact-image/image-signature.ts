/**
 * Signature and bounded header inspection for the four hydratable image
 * formats. This is not a decoder: Chromium still decodes the image in the
 * renderer. It proves the bytes are the claimed format and that the declared
 * canvas stays inside the plan's dimension limits before any data URL exists.
 */
import { MAX_ARTIFACT_IMAGE_DIMENSION, MAX_ARTIFACT_IMAGE_PIXELS } from './policy.ts'

export const SUPPORTED_ARTIFACT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const
export type ArtifactImageMime = (typeof SUPPORTED_ARTIFACT_IMAGE_MIME_TYPES)[number]

export function parseArtifactImageMime(value: string | undefined | null): ArtifactImageMime | null {
  if (!value) return null
  const essence = value.split(';')[0]?.trim().toLowerCase() ?? ''
  for (const mime of SUPPORTED_ARTIFACT_IMAGE_MIME_TYPES) {
    if (mime === essence) return mime
  }
  return null
}

export interface ImageHeader {
  mime: ArtifactImageMime
  width: number
  height: number
}

type Inspection = { ok: true; header: ImageHeader } | { ok: false; reason: 'type' | 'dimensions' }

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false
  return prefix.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  return startsWith(bytes, Array.from(Buffer.from(text, 'latin1')), offset)
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function png(bytes: Uint8Array): { width: number; height: number } | null {
  if (!startsWith(bytes, PNG_SIGNATURE) || bytes.length < 24) return null
  // The first chunk must be a 13-byte IHDR.
  if (view(bytes).getUint32(8) !== 13 || !ascii(bytes, 12, 'IHDR')) return null
  return { width: view(bytes).getUint32(16), height: view(bytes).getUint32(20) }
}

function gif(bytes: Uint8Array): { width: number; height: number } | null {
  if (!(ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) || bytes.length < 10) return null
  return { width: view(bytes).getUint16(6, true), height: view(bytes).getUint16(8, true) }
}

function webp(bytes: Uint8Array): { width: number; height: number } | null {
  if (!ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP') || bytes.length < 30) return null
  const data = view(bytes)
  if (ascii(bytes, 12, 'VP8 ')) {
    // Key frame start code follows the 3-byte frame tag.
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return null
    return {
      width: data.getUint16(26, true) & 0x3fff,
      height: data.getUint16(28, true) & 0x3fff,
    }
  }
  if (ascii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null
    const bits = data.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (ascii(bytes, 12, 'VP8X')) {
    const width = (data.getUint32(24, true) & 0xffffff) + 1
    const height = (data.getUint32(26, true) >>> 8) + 1
    return { width, height }
  }
  return null
}

/** Start-of-frame markers that carry the frame dimensions (not DHT/JPG/DAC). */
function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpeg(bytes: Uint8Array): { width: number; height: number } | null {
  if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return null
  const data = view(bytes)
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    // Fill bytes may pad a marker.
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    const marker = bytes[offset]
    offset++
    if (marker === undefined) return null
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    // End of image or start of scan before any frame header: no dimensions.
    if (marker === 0xd9 || marker === 0xda) return null
    if (offset + 2 > bytes.length) return null
    const length = data.getUint16(offset)
    if (length < 2) return null
    if (isJpegStartOfFrame(marker)) {
      if (offset + 7 > bytes.length) return null
      return { height: data.getUint16(offset + 3), width: data.getUint16(offset + 5) }
    }
    offset += length
  }
  return null
}

function sniff(bytes: Uint8Array): ImageHeader | null {
  const pngSize = png(bytes)
  if (pngSize) return { mime: 'image/png', ...pngSize }
  const jpegSize = jpeg(bytes)
  if (jpegSize) return { mime: 'image/jpeg', ...jpegSize }
  const gifSize = gif(bytes)
  if (gifSize) return { mime: 'image/gif', ...gifSize }
  const webpSize = webp(bytes)
  if (webpSize) return { mime: 'image/webp', ...webpSize }
  return null
}

/**
 * Check the bytes are `claimed` and their canvas is inside the limits. A
 * mismatch between the declared Content-Type and the signature is a type error:
 * a PNG served as `image/jpeg` is refused, not silently relabelled.
 */
export function inspectArtifactImage(bytes: Uint8Array, claimed: ArtifactImageMime): Inspection {
  const header = sniff(bytes)
  if (header?.mime !== claimed) return { ok: false, reason: 'type' }
  if (
    header.width <= 0 ||
    header.height <= 0 ||
    header.width > MAX_ARTIFACT_IMAGE_DIMENSION ||
    header.height > MAX_ARTIFACT_IMAGE_DIMENSION ||
    header.width * header.height > MAX_ARTIFACT_IMAGE_PIXELS
  ) {
    return { ok: false, reason: 'dimensions' }
  }
  return { ok: true, header }
}
