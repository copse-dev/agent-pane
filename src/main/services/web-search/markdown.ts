import Turndown from 'turndown'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'

const turndown = new Turndown({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '*',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  linkReferenceStyle: 'full',
  preformattedCode: true,
})

turndown.remove([
  'script',
  'style',
  'iframe',
  'noscript',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'object',
  'embed',
  'nav',
  'footer',
  'header',
  'aside',
  'link',
  'meta',
  'base',
  'img',
  'picture',
])

const FETCH_USER_AGENT = 'Copse/0.1 (+https://github.com/jonathankingston/agent-pane)'

export function htmlToMarkdown(html: string): string {
  let content = html

  try {
    const dom = new JSDOM(html)
    const reader = new Readability(dom.window.document)
    const article = reader.parse()
    if (article?.content) content = article.content
  } catch {
    // Fall back to raw HTML when readability extraction fails.
  }

  let markdown = turndown.turndown(content)
  markdown = markdown
    .replace(/\[\s*\]\([^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return markdown
}

export async function fetchUrlMarkdown(url: string, signal?: AbortSignal): Promise<string> {
  const init: RequestInit = { headers: { 'User-Agent': FETCH_USER_AGENT } }
  if (signal) init.signal = signal
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`)
  const html = await res.text()
  return htmlToMarkdown(html)
}
