import { $, browser, expect } from '@wdio/globals'
import { resetUserData, writeSeedConfig } from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'

// Regression fixture for issue #2461: `.streaming-markdown` sets
// `text-wrap: pretty` so a wrapped prose paragraph or list item does not
// strand a single short "orphan" word on its own last line, while `pre`,
// `code`, and `table` are reset back to the initial `wrap` value because
// `pretty`'s look-ahead is wrong for monospace/tabular content. Kept
// spec-local (not in helpers/seed-config.ts) since no exported fixture
// already seeds a plain multi-paragraph-plus-list assistant message.
function seedMarkdownTextWrapPrettyFixture(workspaceRoot: string): void {
  const projectId = 'e2e-markdown-text-wrap-pretty-project'
  const threadId = 'e2e-markdown-text-wrap-pretty-thread'
  const content = [
    '### Rollout notes',
    '',
    'The migration moved every long-running background worker off the shared connection pool and onto its own dedicated pool, which removed the head-of-line blocking that made unrelated jobs stall whenever a single slow report query held a connection open for several minutes at a time.',
    '',
    'Rollback stays simple because the old pool configuration is still read from the same settings file, so reverting is just a matter of flipping the feature flag back off and restarting the affected worker processes one at a time during the next maintenance window.',
    '',
    '- Dedicated pool sizing is now driven by the worker concurrency setting instead of a single shared constant that every deployment had to tune by hand',
    '- Slow queries are logged with the worker name attached so an operator can tell at a glance which pool needs more headroom',
    '- The old shared pool metric was renamed rather than removed, so existing dashboards keep working without any changes',
    '',
    '```ts',
    'const pool = createWorkerPool({ name: workerName, size: concurrency })',
    'await pool.run(job)',
    '```',
  ].join('\n')
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: threadId,
        title: 'Connection pool rollout',
        status: 'idle',
        messages: [
          {
            id: 'msg-assistant-text-wrap-pretty',
            role: 'assistant',
            content,
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
}

describe('markdown prose text-wrap: pretty', () => {
  before(async () => {
    resetUserData()
    seedMarkdownTextWrapPrettyFixture(process.cwd())
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('balances prose wrapping while leaving code blocks literal', async () => {
    await $('.message-text p').waitForExist({ timeout: 30_000 })
    await $('.message-text pre code').waitForExist({ timeout: 30_000 })

    const style = await browser.execute(() => {
      const messageText = document.querySelector('.message-text')
      const paragraphs = [...document.querySelectorAll('.message-text p')]
      const listItem = document.querySelector('.message-text li')
      const pre = document.querySelector('.message-text pre')
      const code = document.querySelector('.message-text pre code')
      if (!messageText || paragraphs.length < 2 || !listItem || !pre || !code) {
        return { error: 'missing fixture element' }
      }
      return {
        hostTextWrap: getComputedStyle(messageText).textWrap,
        paragraphTextWrap: paragraphs.map((p) => getComputedStyle(p).textWrap),
        listItemTextWrap: getComputedStyle(listItem).textWrap,
        preTextWrap: getComputedStyle(pre).textWrap,
        codeTextWrap: getComputedStyle(code).textWrap,
      }
    })

    expect(style).not.toHaveProperty('error')
    expect(style.hostTextWrap).toBe('pretty')
    for (const value of style.paragraphTextWrap) {
      expect(value).toBe('pretty')
    }
    expect(style.listItemTextWrap).toBe('pretty')
    expect(style.preTextWrap).not.toBe('pretty')
    expect(style.codeTextWrap).not.toBe('pretty')

    await saveAppScreenshot('markdown-text-wrap-pretty.png')
  })
})
