const IMAGE_MIME_BY_EXT: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

export function imageMimeType(path: string): string | null {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  const ext = name.split('.').pop() ?? ''
  return IMAGE_MIME_BY_EXT[ext] ?? null
}

export function isImagePath(path: string): boolean {
  return imageMimeType(path) !== null
}
