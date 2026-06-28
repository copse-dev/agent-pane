import { z } from 'zod'
import { type ToolDefinition, defineTool } from '@shared/types'
import { getBrowserSession } from '../services/browser/session-manager.ts'

export const browserNavigateTool = defineTool({
  name: 'browser_navigate',
  description:
    'Open a URL in the built-in headless browser. Loopback (localhost) targets run automatically; other origins prompt for approval. Returns the resolved title and URL.',
  parameters: z.object({
    url: z.string().url().describe('http/https URL to open'),
    newTab: z.boolean().optional().describe('Open in a new tab instead of reusing the active one'),
    viewId: z.string().optional().describe('Target tab id (defaults to the last used tab)'),
  }),
  async execute({ url, newTab, viewId }) {
    const result = await getBrowserSession().navigate(url, { newTab, viewId })
    return `Opened ${result.viewId}: ${result.title || '(untitled)'}\n${result.url}`
  },
})

export const browserSnapshotTool = defineTool({
  name: 'browser_snapshot',
  description:
    'Capture an accessibility snapshot of the current page as an indented outline. Interactive elements carry [ref=…] handles for browser_click / browser_type. Prefer this over a screenshot for reading or interacting with a page.',
  parameters: z.object({
    viewId: z.string().optional().describe('Target tab id (defaults to the last used tab)'),
  }),
  async execute({ viewId }) {
    return getBrowserSession().snapshot(viewId)
  },
})

export const browserScreenshotTool = defineTool({
  name: 'browser_screenshot',
  description:
    'Capture a PNG screenshot of the current page. Returns the saved file path (useful for visual/layout checks).',
  parameters: z.object({
    viewId: z.string().optional().describe('Target tab id (defaults to the last used tab)'),
  }),
  async execute({ viewId }) {
    const { path, viewId: id } = await getBrowserSession().screenshot(viewId)
    return `Saved screenshot of ${id} to ${path}`
  },
})

export const browserClickTool = defineTool({
  name: 'browser_click',
  description:
    'Click an element by its snapshot ref (e.g. e7). Run browser_snapshot first to obtain refs.',
  parameters: z.object({
    ref: z.string().describe('Element ref from a snapshot, e.g. e7'),
    viewId: z.string().optional().describe('Target tab id (defaults to the last used tab)'),
  }),
  async execute({ ref, viewId }) {
    return getBrowserSession().click(ref, viewId)
  },
})

export const browserTypeTool = defineTool({
  name: 'browser_type',
  description: 'Type text into an input/textarea identified by its snapshot ref.',
  parameters: z.object({
    ref: z.string().describe('Element ref from a snapshot, e.g. e5'),
    text: z.string().describe('Text to enter'),
    viewId: z.string().optional().describe('Target tab id (defaults to the last used tab)'),
  }),
  async execute({ ref, text, viewId }) {
    return getBrowserSession().type(ref, text, viewId)
  },
})

export const browserTabsTool = defineTool({
  name: 'browser_tabs',
  description: 'List open browser tabs, or close one with action "close" and a viewId.',
  parameters: z.object({
    action: z.enum(['list', 'close']).optional().default('list'),
    viewId: z.string().optional().describe('Tab id to close when action is "close"'),
  }),
  async execute({ action, viewId }) {
    const session = getBrowserSession()
    if (action === 'close') {
      if (!viewId) throw new Error('viewId is required to close a tab')
      return session.closeTab(viewId)
    }
    const tabs = session.listTabs()
    if (tabs.length === 0) return 'No open browser tabs.'
    return tabs
      .map((t) => `${t.active ? '* ' : '  '}${t.viewId}: ${t.title || '(untitled)'} — ${t.url}`)
      .join('\n')
  },
})

// Each tool carries its own arg type; the registry validates args at runtime,
// so erase to the common ToolDefinition shape for bulk registration.
export const browserTools: ToolDefinition[] = [
  browserNavigateTool,
  browserSnapshotTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserTabsTool,
] as ToolDefinition[]
