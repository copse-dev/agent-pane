import { z } from 'zod'
import type { BrowserImageShare, BrowserTextShare } from '@shared/types/browser-share.ts'

interface BrowserPageTextContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

interface BrowserScreenshotContents {
  capturePage(): Promise<{ toDataURL(): string }>
}

interface BrowserSelectionContents {
  getTitle(): string
  getURL(): string
}

const MAX_PAGE_TEXT_CHARS = 64_000

const zPageText = z.strictObject({
  title: z.string(),
  url: z.string(),
  text: z.string(),
  omittedChars: z.number().int().nonnegative(),
})

const PAGE_TEXT_SCRIPT = `(() => {
  const fullText = document.body?.innerText ?? '';
  const limit = ${String(MAX_PAGE_TEXT_CHARS)};
  return {
    title: document.title,
    url: location.href,
    text: fullText.slice(0, limit),
    omittedChars: Math.max(0, fullText.length - limit),
  };
})()`

function cleanLabelPart(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function pageIdentity(title: string, url: string): string {
  const cleanTitle = cleanLabelPart(title)
  if (cleanTitle) return cleanTitle
  try {
    return new URL(url).hostname || 'Browser page'
  } catch {
    return 'Browser page'
  }
}

function textShare(
  kind: 'Browser page' | 'Browser selection',
  title: string,
  url: string,
  text: string,
): BrowserTextShare {
  const source = url ? `Source: ${url}\n\n` : ''
  return {
    label: `${kind} — ${pageIdentity(title, url)}`,
    content: `${source}${text}`,
  }
}

/** Extract the visible text of an interactive browser page for explicit sharing. */
export async function captureBrowserPageText(
  contents: BrowserPageTextContents,
): Promise<BrowserTextShare> {
  const result = zPageText.parse(await contents.executeJavaScript(PAGE_TEXT_SCRIPT, true))
  const clipped =
    result.omittedChars > 0
      ? `${result.text}\n\n… [Copse omitted ${result.omittedChars.toLocaleString()} additional page characters.] …`
      : result.text
  return textShare('Browser page', result.title, result.url, clipped)
}

/** Capture only the visible browser viewport, matching what the user is sharing. */
export async function captureBrowserScreenshot(
  contents: BrowserScreenshotContents,
): Promise<BrowserImageShare> {
  const image = await contents.capturePage()
  return { dataUrl: image.toDataURL(), mimeType: 'image/png' }
}

/** Build a source-labelled attachment from the native guest context-menu selection. */
export function browserSelectionShare(
  contents: BrowserSelectionContents,
  selectionText: string,
  pageUrl?: string,
): BrowserTextShare {
  return textShare(
    'Browser selection',
    contents.getTitle(),
    pageUrl ?? contents.getURL(),
    selectionText,
  )
}
