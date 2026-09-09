import { imageMimeType, isRasterImagePath } from '@shared/fs/image-path.ts'
import type { WorkspaceFs } from './workspace-fs.ts'

function matchingImageDataUrl(path: string, content: string): string | null {
  const mime = imageMimeType(path)
  if (!mime) return null
  const prefix = `data:${mime};base64,`
  return content.startsWith(prefix) ? content.slice(prefix.length) : null
}

/**
 * Proposed raster payloads use a byte-preserving (latin-1) string because the
 * diff queue and Electron IPC are string-based. A matching data URL is also
 * accepted so image-producing tools can hand the queue an explicit encoding.
 */
export function proposedRasterBytes(path: string, content: string): Buffer {
  const base64 = matchingImageDataUrl(path, content)
  return base64 === null ? Buffer.from(content, 'latin1') : Buffer.from(base64, 'base64')
}

export async function readWorkspaceFileContent(
  fs: WorkspaceFs,
  absolutePath: string,
  displayPath: string,
): Promise<string> {
  if (isRasterImagePath(displayPath)) {
    return (await fs.readFileBytes(absolutePath)).toString('latin1')
  }
  return fs.readFile(absolutePath, 'utf-8')
}

export async function writeWorkspaceFileContent(
  fs: WorkspaceFs,
  absolutePath: string,
  displayPath: string,
  content: string,
): Promise<void> {
  if (isRasterImagePath(displayPath)) {
    await fs.writeFileBytes(absolutePath, proposedRasterBytes(displayPath, content))
    return
  }
  await fs.writeFile(absolutePath, content, 'utf-8')
}
