import type { RemoteAgentLink } from '@shared/remote-agent-link.ts'
import type { RemoteArtifactDownloadRequest } from '@shared/remote-artifact-download.ts'
import { z } from 'zod'
import { zArtifactImageRequest } from './artifact-image/service.ts'
import {
  checkDownloadUrl,
  CURSOR_ARTIFACT_DOWNLOAD_ORIGINS,
  validateArtifactPath,
} from './artifact-image/policy.ts'

export const zArtifactDownloadRequest = zArtifactImageRequest.extend({
  agentId: z.string().min(1).max(128),
})

export interface ArtifactDownloadDependencies {
  readThreadLink(projectId: string, threadId: string): Promise<RemoteAgentLink | null>
  readOpenAiArtifact(projectId: string, threadId: string, path: string): Promise<Buffer>
  chooseSavePath(defaultPath: string): Promise<string | null>
  writeFile(path: string, data: Buffer): Promise<void>
  resolveCursorUrl(agentId: string, path: string): Promise<string>
  openExternal(url: string): Promise<void>
}

/** Explicit artifact downloads are user-initiated, but transcript links confer no authority. */
export function createArtifactDownloader(dependencies: ArtifactDownloadDependencies) {
  return async (request: RemoteArtifactDownloadRequest): Promise<void> => {
    let link: RemoteAgentLink | null
    try {
      link = await dependencies.readThreadLink(request.projectId, request.threadId)
    } catch {
      throw new Error('This artifact is not linked to the chat.')
    }
    if (request.agentId.startsWith('openai:')) {
      // OpenAI artifacts are cached under their owning thread. The local owner
      // record survives later remote-agent runs, so old downloads still work.
      if (request.agentId !== `openai:${request.threadId}`)
        throw new Error('This artifact is not linked to the chat.')
      const data = await dependencies.readOpenAiArtifact(
        request.projectId,
        request.threadId,
        request.path,
      )
      const extension = request.path.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? ''
      const destination = await dependencies.chooseSavePath(`agent-artifact${extension}`)
      if (destination) await dependencies.writeFile(destination, data)
      return
    }
    if (!link || link.provider !== 'cursor' || link.agentId !== request.agentId) {
      throw new Error('This artifact is not linked to the chat.')
    }
    const path = validateArtifactPath(request.path)
    const signedUrl = await dependencies.resolveCursorUrl(link.agentId, path)
    const approved = checkDownloadUrl(signedUrl, CURSOR_ARTIFACT_DOWNLOAD_ORIGINS)
    // The URL is a bearer secret. Only main hands it to the system browser;
    // neither the URL nor a thrown platform error may enter renderer state.
    try {
      await dependencies.openExternal(approved.href)
    } catch {
      throw new Error('Could not open the artifact download.')
    }
  }
}
