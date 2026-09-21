import { imageMimeType } from '@shared/fs/image-path.ts'
import { enforceWorkspaceFileSize, type WorkspaceFs } from './workspace-fs.ts'

/** Matches the remote artifact preview budget and stays within the fs worker's output cap. */
export const MAX_WORKSPACE_IMAGE_BYTES = 15 * 1024 * 1024

/** The caller resolves containment; the display path supplies the image format, including symlinks. */
export async function readWorkspaceImage(
  fs: WorkspaceFs,
  absolutePath: string,
  displayPath: string,
): Promise<string> {
  const mime = imageMimeType(displayPath)
  if (!mime) throw new Error('This file is not a supported image')
  const bytes = await fs.readFileBytes(absolutePath, { maxBytes: MAX_WORKSPACE_IMAGE_BYTES })
  // Also reject a file that grew between the filesystem's size check and read.
  enforceWorkspaceFileSize(bytes.byteLength, MAX_WORKSPACE_IMAGE_BYTES)
  return `data:${mime};base64,${bytes.toString('base64')}`
}
