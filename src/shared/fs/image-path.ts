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

function extensionOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  // No dot means no extension: a file literally named `png` is not an image.
  return dot < 0 ? null : name.slice(dot + 1)
}

export function imageMimeType(path: string): string | null {
  const ext = extensionOf(path)
  return ext === null ? null : (IMAGE_MIME_BY_EXT.get(ext) ?? null)
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

// The same formats by extension, for a file the browser gave no MIME type or a
// workspace path, neither of which carries one.
const UNRENDERABLE_IMAGE_EXT = new Set(['heic', 'heif', 'tif', 'tiff'])

export function isUnrenderableImagePath(path: string): boolean {
  const ext = extensionOf(path)
  return ext !== null && UNRENDERABLE_IMAGE_EXT.has(ext)
}
