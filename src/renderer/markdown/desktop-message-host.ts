import type { ApiClient } from '../../preload/api.d.ts'
import { annotateFileReferences } from './file-links.ts'
import type { MessageMarkdownHost } from './message-markdown.ts'
import { hydrateRemoteArtifactImages } from './remote-artifact-images.ts'

const hosts = new WeakMap<
  ApiClient,
  { plain: MessageMarkdownHost; runnable: MessageMarkdownHost }
>()

/**
 * The desktop app's message host: workspace file links and artifact images, which
 * need the preload API. Every desktop chat surface uses this so a side chat renders
 * a reply exactly as the main conversation does. Clicks on the decorated links are
 * bound once per surface root (`bindFileReferenceClicks` and friends).
 *
 * `runCommands` adds Run to shell blocks. Only the main conversation passes it: a
 * run executes in the open thread and reports into that transcript.
 */
export function desktopMessageHost(
  api: ApiClient,
  options: { runCommands?: boolean } = {},
): MessageMarkdownHost {
  let cached = hosts.get(api)
  if (!cached) {
    const decorate = (el: HTMLElement): void => {
      void annotateFileReferences(el, api)
      hydrateRemoteArtifactImages(el, api)
    }
    cached = { plain: { decorate }, runnable: { decorate, runCommands: true } }
    hosts.set(api, cached)
  }
  return options.runCommands === true ? cached.runnable : cached.plain
}
