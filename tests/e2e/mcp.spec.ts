import { _electron as electron, test, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedProjectConfig } from './helpers.ts'

interface McpStatus {
  name: string
  state: string
  toolCount: number
  tools: string[]
}

test('discovers and connects a stdio MCP server from project config', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-pane-mcp-'))
  await mkdir(join(workspaceRoot, '.cursor'), { recursive: true })

  const mockServer = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mock-mcp-server.mts')
  await writeFile(
    join(workspaceRoot, '.cursor', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        mock: {
          command: 'node',
          args: ['--experimental-strip-types', mockServer],
        },
      },
    }),
    'utf8',
  )

  await seedProjectConfig(workspaceRoot, {
    projectId: 'mcp-e2e-project',
    threadId: 'mcp-e2e-thread',
  })

  const app = await electron.launch({
    args: ['dist/main/index.js', '--disable-gpu'],
    env: { ...process.env, AGENT_WINDOW_MOCK_LLM: '1' },
  })

  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.prompt-input', { timeout: 15_000 })

    // Reload through the real IPC surface, then assert the server connected and
    // both tools were registered.
    const statuses = (await win.evaluate(async () => {
      // @ts-expect-error injected preload API
      return window.api.mcp.reload()
    })) as McpStatus[]

    const mock = statuses.find((s) => s.name === 'mock')
    expect(mock, 'mock server should be discovered').toBeTruthy()
    expect(mock!.state).toBe('connected')
    expect(mock!.toolCount).toBe(2)
    expect(mock!.tools.sort()).toEqual(['danger', 'echo'])
  } finally {
    await app.close()
  }
})
