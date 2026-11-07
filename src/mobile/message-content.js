import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'
import {
  paintAssistantMarkdown,
  renderUserPromptMarkdown,
} from '../renderer/markdown/message-markdown.ts'

// What each content node was last painted from, so a poll that brings the same
// message leaves its rendered diagrams and copy buttons alone.
const painted = new WeakMap()
const linkHandlers = new WeakSet()

// The companion has no artifact routes. Do not fetch images from transcript URLs.
const sanitizerBackend = {
  sanitize: (html, config) =>
    dompurifyBackend.sanitize(html, {
      ...config,
      allowedTags: config.allowedTags.filter((tag) => tag !== 'img'),
    }),
}

function isExternal(link) {
  return !link.getAttribute('href').startsWith('#')
}

function openLinksExternally(target) {
  for (const link of target.querySelectorAll('a[href]')) {
    if (!isExternal(link)) continue
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
}

// A reply still arriving is painted frame by frame, before its links are
// decorated; never let one navigate the companion itself away.
function bindExternalLinks(target) {
  if (linkHandlers.has(target)) return
  linkHandlers.add(target)
  target.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[href]')
    if (!link || !isExternal(link) || link.target === '_blank') return
    event.preventDefault()
    window.open(link.href, '_blank', 'noopener,noreferrer')
  })
}

/**
 * Render one saved message with the desktop's message markdown
 * (src/renderer/markdown/message-markdown.ts): the same code highlighting, copy
 * buttons, tables, Mermaid diagrams and streamed pacing as the main conversation.
 * `live` marks the newest reply of a running chat.
 */
export function renderMessageContent(target, message, index, live = false) {
  target.hidden = !message.content && message.imageCount > 0
  if (target.hidden) return
  const markdown = message.content && (message.role === 'user' || message.role === 'assistant')
  target.classList.toggle('message-content-plain', !markdown)
  target.classList.toggle('message-text', Boolean(markdown))
  target.classList.toggle('streaming-markdown', Boolean(markdown))
  if (!markdown) {
    painted.delete(target)
    target.textContent = message.content || (message.summary ? 'Tool activity' : 'No saved text')
    return
  }
  const key = `${message.role}\n${String(live)}\n${message.content}`
  if (painted.get(target) === key) return
  painted.set(target, key)
  bindExternalLinks(target)
  const renderOptions = {
    // Raw HTML in a transcript stays literal on the phone.
    htmlPolicy: 'escape-all',
    sanitizerBackend,
    footnoteIdPrefix: `mobile-${index}-`,
  }
  if (message.role === 'user') {
    renderUserPromptMarkdown(target, message.content, renderOptions)
    openLinksExternally(target)
    return
  }
  paintAssistantMarkdown(target, message.content, live, {
    renderOptions,
    decorate: openLinksExternally,
  })
}
