const IMAGE_MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['gif', 'image/gif'],
  ['ico', 'image/x-icon'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['svg', 'image/svg+xml'],
  ['webp', 'image/webp'],
])

export function imageMimeType(path: string): string | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  // No dot means no extension: a file literally named `png` is not an image.
  if (dot < 0) return null
  return IMAGE_MIME_BY_EXT.get(name.slice(dot + 1)) ?? null
}

export function isImagePath(path: string): boolean {
  return imageMimeType(path) !== null
}

/** Raster images must travel through the proposed-diff queue as bytes, not UTF-8 text. */
export function isRasterImagePath(path: string): boolean {
  const mime = imageMimeType(path)
  return mime !== null && mime !== 'image/svg+xml'
}

// Chromium's <img> has no decoder for these, so a pasted/dropped blob of one
// of these types renders as a broken image — e.g. an iPhone photo pasted via
// Universal Clipboard, which arrives as HEIC/HEIF rather than PNG/JPEG.
const UNRENDERABLE_IMAGE_MIME = new Set([
  'image/heic',
  'image/heic-sequence',
  'image/heif',
  'image/heif-sequence',
  'image/tiff',
])

export function isUnrenderableImageMime(mime: string): boolean {
  return UNRENDERABLE_IMAGE_MIME.has(mime.toLowerCase())
}
