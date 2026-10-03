import { renderMarkdown } from '@copse/streaming-markdown'
import { dompurifyBackend } from '@copse/streaming-markdown/sanitizers/dompurify'

export function renderMessageContent(target, message, index) {
  const markdown = message.content && (message.role === 'user' || message.role === 'assistant')
  target.classList.toggle('message-content-plain', !markdown)
  if (!markdown) {
    target.textContent = message.content || (message.summary ? 'Tool activity' : 'No saved text')
    return
  }
  target.innerHTML = renderMarkdown(message.content, {
    htmlPolicy: 'escape-all',
    sanitizerBackend: {
      // The companion has no artifact routes. Do not fetch images from transcript URLs.
      sanitize: (html, config) =>
        dompurifyBackend.sanitize(html, {
          ...config,
          allowedTags: config.allowedTags.filter((tag) => tag !== 'img'),
        }),
    },
    footnoteIdPrefix: `mobile-${index}-`,
  })
  for (const link of target.querySelectorAll('a[href]')) {
    if (link.getAttribute('href').startsWith('#')) continue
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
  }
}
