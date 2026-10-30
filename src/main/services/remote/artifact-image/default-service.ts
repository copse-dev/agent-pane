import type { RemoteAgentLink } from '@shared/remote-agent-link.ts'
import { getThreadMeta } from '../../thread-store.ts'
import {
  cursorArtifactCredentials,
  resolveRemoteArtifactDownloadUrl,
} from '../remote-agent-client.ts'
import { runArtifactImageHost } from './host-process.ts'
import { ArtifactImageService } from './service.ts'

let service: ArtifactImageService | null = null

/** The app's artifact-image service, wired to the real thread store, provider and host. */
export function artifactImageService(): ArtifactImageService {
  service ??= new ArtifactImageService({
    async readThreadLink(projectId, threadId): Promise<RemoteAgentLink | null> {
      const meta = await getThreadMeta(projectId, threadId)
      if (!meta) throw new Error('unknown thread')
      return meta.remoteAgentLink ?? null
    },
    credentials: cursorArtifactCredentials,
    resolveDownloadUrl: resolveRemoteArtifactDownloadUrl,
    // ASRT confines on macOS and Linux only; elsewhere hydration stays off.
    sandboxPlatform: (): boolean => process.platform === 'darwin' || process.platform === 'linux',
    runHost: runArtifactImageHost,
    log: (line): void => {
      console.log(line)
    },
  })
  return service
}
