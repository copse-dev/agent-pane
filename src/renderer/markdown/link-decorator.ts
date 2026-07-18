import { setDefaultConfig } from '@copse/streaming-markdown'
import { appLinkDecorator } from '@copse/streaming-markdown/host/workspace'

/**
 * Restore the app's workspace/browser link decoration on @copse/streaming-markdown.
 *
 * As of streaming-markdown 0.10.0 (#112) the built-in default `LinkDecorator` is
 * neutral: rendered `<a>` anchors carry only `href`/`title` and no longer emit
 * `target="_blank"`, `rel`, `class="workspace-markdown-link"`, `data-workspace-link`,
 * or `data-browser-link`. agent-pane's `workspace-links.ts` / `browser-links.ts`
 * click handlers bind those `data-*` hooks, so we opt back into the host decorator
 * once before any markdown sink renders. The decorator is an application default
 * in the package, so a single call is enough; it is idempotent.
 */
export function installAppLinkDecorator(): void {
  setDefaultConfig({ linkDecorator: appLinkDecorator })
}
