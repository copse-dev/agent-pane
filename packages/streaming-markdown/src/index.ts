/**
 * Public surface of @copse/streaming-markdown.
 *
 * The renderer returns untrusted HTML strings; hosts must sanitize at their
 * `innerHTML` sinks (`sanitizeRenderedMarkdown` is the reference sanitizer).
 * See README.md for the design invariants and the streaming architecture.
 */
export { renderMarkdown } from './renderer.ts'
export {
  renderStreamingMarkdown,
  splitForStreaming,
  StreamingMarkdownRenderer,
} from './streaming.ts'
export { sanitizeRenderedMarkdown } from './sanitize.ts'
export { escapeHtml, escapeHtmlTextNodes, decodeSafeMarkdownEntities } from './escape.ts'
export { fenceCodeClass, highlightFenceCode, stripAppCodeDecorations } from './highlight.ts'
export { mermaidSourceCandidates, prepareMermaidSource } from './mermaid-source.ts'
export { stripAppImageAttributes, stripAppLinkAttributes } from './inline-links.ts'
export {
  isWorkspaceMarkdownLinkHref,
  workspaceLinkTargetFromHref,
  type WorkspaceLinkTarget,
} from './workspace-link-href.ts'
