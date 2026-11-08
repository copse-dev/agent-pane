import assert from 'node:assert/strict'
import { $, browser, expect } from '@wdio/globals'
import { ResponsesProvider } from '@copse/llm/responses-provider.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

describe('Responses cache-write accounting in Usage', function () {
  this.timeout(60_000)

  before(async () => {
    resetUserData()
    // Inject only the HTTP boundary. The production adapter must extract these
    // counts before the ordinary ledger fixture can display them.
    const provider = new ResponsesProvider('gpt-6.1-sol', {
      apiKey: 'fixture-only',
      fetch: async (): Promise<Response> =>
        new Response(
          `data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'cache-accounting-fixture',
              status: 'completed',
              output: [],
              usage: {
                input_tokens: 1_000_000,
                output_tokens: 10_000,
                input_tokens_details: { cached_tokens: 600_000, cache_write_tokens: 300_000 },
              },
            },
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    let usage
    for await (const chunk of provider.stream([{ role: 'user', content: 'fixture' }], [])) {
      if (chunk.type === 'usage') usage = chunk
    }
    assert.ok(usage)
    assert.equal(usage.cacheReadTokens, 600_000)
    assert.equal(usage.cacheCreationTokens, 300_000)
    seedEmptyProject(process.cwd(), 'responses-cache-accounting', {
      usageEvents: [
        {
          at: Date.now(),
          model: 'gpt-6.1-sol',
          source: 'agent',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
        },
      ],
    })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('shows cache reads, writes and the cache-write premium from the Responses adapter', async () => {
    const summary = await browser.execute(() => window.api.usage.getSummary())
    const row = summary.day.cloudModels.find((entry) => entry.model === 'gpt-6.1-sol')
    assert.ok(row)
    assert.equal(row.inputTokens, 1_000_000)
    assert.equal(row.cacheReadTokens, 600_000)
    assert.equal(row.cacheCreationTokens, 300_000)
    assert.ok(Math.abs(row.estimatedCostUsd - 1.11) < 1e-9)
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="usage"]').click()
    const table = $('.usage-model-group .usage-table')
    await expect(table).toBeDisplayed()
    await expect(table.$('tbody tr td:nth-child(4)')).toHaveText(expect.stringContaining('600'))
    await expect(table.$('tbody tr td:nth-child(5)')).toHaveText(expect.stringContaining('300'))
    await expect(table.$('tbody tr td:nth-child(6)')).toHaveText('~$1.11')
    await saveElementScreenshot('.usage-model-group', 'settings-usage-responses-cache.png')
  })
})
