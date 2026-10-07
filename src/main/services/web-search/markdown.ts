import Turndown from 'turndown'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { getSetting } from '../storage/settings.ts'
import {
  WEB_ALLOWED_ORIGINS_SETTING,
  clearWebOriginGrant,
  fetchWithWebOriginPolicy,
  parseFetchUrl,
  readWebResponseText,
  webAllowedOriginsWithDefaults,
  webOriginKey,
} from '../security/web-origin-policy.ts'
import { COMMAND_OUTPUT_MAX_BYTES, truncateToolOutput } from '../exec/subprocess-output-cap.ts'

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

/**
 * Cap on the Markdown `fetch_url` hands the model. The 2 MiB response limit
 * bounds the download, not the converted page, so this is the same 100 KiB
 * head + tail cap run_shell output gets. Pages are prose, so no evidence lines.
 */
export const FETCH_URL_OUTPUT_MAX_BYTES = COMMAND_OUTPUT_MAX_BYTES

const FETCH_USER_AGENT = 'Copse/0.1 (+https://github.com/copse-dev/agent-pane)'

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
  const parsed = parseFetchUrl(url)
  const origin = webOriginKey(parsed)
  const allowedOrigins = webAllowedOriginsWithDefaults(
    getSetting<string[] | null>(WEB_ALLOWED_ORIGINS_SETTING, null),
  )
  const init: RequestInit = { headers: { 'User-Agent': FETCH_USER_AGENT } }
  if (signal) init.signal = signal
  try {
    const res = await fetchWithWebOriginPolicy(parsed, init, allowedOrigins)
    if (!res.ok) throw new Error(`Fetch failed (${String(res.status)}): ${url}`)
    const html = await readWebResponseText(res)
    return truncateToolOutput(htmlToMarkdown(html), FETCH_URL_OUTPUT_MAX_BYTES)
  } finally {
    clearWebOriginGrant(origin)
  }
}
