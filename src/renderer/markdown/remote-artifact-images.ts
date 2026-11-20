import type { ApiClient } from '../../preload/api.d.ts'
import type {
  RemoteArtifactImageErrorCode,
  RemoteArtifactImageRequest,
} from '@shared/remote-artifact-image.ts'
import { attachImageCopyMenu } from '../attachments/image-expand.ts'

/** The thread whose transcript is being hydrated, captured when the request starts. */
export interface ArtifactImageScope {
  projectId: string
  threadId: string
}

type HydrationApi = { remoteAgent: Pick<ApiClient['remoteAgent'], 'artifactImageDataUrl'> }

const UNAVAILABLE_CLASS = 'remote-artifact-unavailable'

/** One short line per failure; policy denials say why there is nothing to retry. */
function unavailableCopy(code: RemoteArtifactImageErrorCode): string {
  switch (code) {
    case 'sandbox-unavailable':
      return 'Image unavailable: it can only be downloaded inside the sandbox, which is not available here.'
    case 'unlinked-agent':
      return 'Image unavailable: this thread is not linked to the agent that made it.'
    case 'origin-denied':
    case 'redirect-denied':
    case 'too-many-redirects':
      return 'Image unavailable: it is hosted somewhere Copse does not download from.'
    case 'not-configured':
      return 'Image unavailable: add a Cursor API key in Settings.'
    case 'bad-type':
    case 'bad-image':
    case 'too-large':
    case 'bad-encoding':
      return 'Image unavailable: the file is not a supported image.'
    default:
      return 'Image could not be loaded.'
  }
}

function clearUnavailable(img: HTMLImageElement): void {
  const next = img.nextElementSibling
  if (next?.classList.contains(UNAVAILABLE_CLASS)) next.remove()
  img.hidden = false
}

function showUnavailable(
  img: HTMLImageElement,
  code: RemoteArtifactImageErrorCode,
  retry: (() => void) | null,
): void {
  clearUnavailable(img)
  img.hidden = true
  img.dataset['remoteArtifactState'] = 'unavailable'
  img.dataset['remoteArtifactError'] = code
  const notice = document.createElement('div')
  notice.className = UNAVAILABLE_CLASS
  notice.setAttribute('role', 'status')
  const label = document.createElement('span')
  label.className = 'remote-artifact-unavailable-label'
  label.textContent = unavailableCopy(code)
  notice.append(label)
  if (img.alt) {
    const alt = document.createElement('span')
    alt.className = 'remote-artifact-unavailable-alt'
    alt.textContent = img.alt
    notice.append(alt)
  }
  if (retry) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ui-btn ui-btn-secondary ui-btn-compact remote-artifact-retry'
    button.textContent = 'Retry'
    button.addEventListener('click', retry, { once: true })
    notice.append(button)
  }
  img.after(notice)
}

function requestImage(img: HTMLImageElement, api: HydrationApi, scope: ArtifactImageScope): void {
  const path = img.dataset['remoteArtifactPath']
  if (!path) return
  const agentId = img.dataset['remoteArtifactAgentId']
  const request: RemoteArtifactImageRequest = {
    projectId: scope.projectId,
    threadId: scope.threadId,
    path,
    ...(agentId ? { agentId } : {}),
  }
  clearUnavailable(img)
  img.dataset['remoteArtifactState'] = 'loading'
  delete img.dataset['remoteArtifactError']
  void api.remoteAgent.artifactImageDataUrl(request).then(
    (result) => {
      if (result.ok) {
        img.src = result.dataUrl
        attachImageCopyMenu(img)
        img.dataset['remoteArtifactState'] = 'loaded'
        return
      }
      // A user retry reruns authorization and gets a fresh signed URL in main.
      showUnavailable(
        img,
        result.code,
        result.retryable
          ? (): void => {
              requestImage(img, api, scope)
            }
          : null,
      )
    },
    () => {
      // IPC itself failed (for example a rejected request shape): not retryable.
      showUnavailable(img, 'invalid-request', null)
    },
  )
}

/**
 * Resolve the remote-artifact image placeholders in `container` for the thread
 * named by `scope`. Main authorizes against that thread's durable agent link;
 * a `cursor.com/agents/...` link in the transcript is never used as identity.
 * Without a scope the images stay unavailable.
 */
export function hydrateRemoteArtifactImages(
  container: HTMLElement,
  api: HydrationApi,
  scope: ArtifactImageScope | null,
): void {
  for (const img of container.querySelectorAll<HTMLImageElement>(
    'img[data-remote-artifact-path]',
  )) {
    const state = img.dataset['remoteArtifactState']
    if (state === 'loading' || state === 'loaded' || state === 'unavailable') continue
    if (!scope) {
      img.dataset['remoteArtifactState'] = 'missing-scope'
      continue
    }
    requestImage(img, api, scope)
  }
}
