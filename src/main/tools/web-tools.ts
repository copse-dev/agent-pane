import { z } from 'zod'
import { defineTool } from '@shared/types'

async function loadWebSearch() {
  return import('../services/web-search/index.ts')
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Search the public web. Use for documentation, release notes, or facts outside the workspace.',
  parameters: z.object({
    query: z.string().describe('Search query'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .default(10)
      .describe('Maximum number of results (default 10)'),
  }),
  async execute({ query, limit }, _signal) {
    const { webSearch } = await loadWebSearch()
    const hits = await webSearch(query, limit)
    if (hits.length === 0) return `No web results for: ${query}`
    return JSON.stringify(hits, null, 2)
  },
})

export const fetchUrlTool = defineTool({
  name: 'fetch_url',
  description:
    'Fetch a public HTTP/HTTPS URL and return readable Markdown extracted from the page content.',
  parameters: z.object({
    url: z.string().url().describe('HTTP/HTTPS URL to fetch'),
  }),
  async execute({ url }, signal) {
    const { fetchUrlMarkdown } = await loadWebSearch()
    return fetchUrlMarkdown(url, signal)
  },
})
