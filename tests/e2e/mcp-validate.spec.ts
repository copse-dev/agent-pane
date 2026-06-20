import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedProjectConfig } from './helpers.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests', 'e2e', 'screenshots')
const STDIO_SERVER = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mock-mcp-server.mts')
const HTTP_SERVER = join(process.cwd(), 'tests', 'e2e', 'fixtures', 'http-mcp-server.mts')

interface McpStatus {
  name: string
  state: string
  toolCount: number
  tools: string[]
  error?: string
}

async function makeWorkspace(mcpConfig: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copse-panel-mcp-'))
  await mkdir(join(root, '.cursor'), { recursive: true })
  await writeFile(join(root, '.cursor', 'mcp.json'), JSON.stringify(mcpConfig), 'utf8')
  return root
}

function stdioServerEntry(extra: Record<string, unknown> = {}) {
  return { command: 'node', args: ['--experimental-strip-types', STDIO_SERVER], ...extra }
}

async function launch(workspaceRoot: string, env: Record<string, string> = {}) {
  return electron.launch({
    args: ['dist/main/index.js', '--disable-gpu'],
    env: {
      ...process.env,
      COPSE_PANEL_MOCK_LLM: '1',
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
      ...env,
    },
  })
}

async function openMcpSettings(app: ElectronApplication) {
  const win = await app.firstWindow()
  await win.waitForSelector('.prompt-input', { timeout: 15_000 })
  await win.locator('[aria-label="Settings"]').click()
  await win.locator('.settings-nav-btn[data-section="mcp"]').click()
  return win
}

test.describe('MCP validation', () => {
  test.beforeAll(async () => {
    await mkdir(SCREENSHOT_DIR, { recursive: true })
  })

  test('settings panel shows a connected stdio server with its tools', async () => {
    const ws = await makeWorkspace({ mcpServers: { mock: stdioServerEntry() } })
    await seedProjectConfig(ws, { projectId: 'mcp-settings', threadId: 'mcp-settings-t' })
    const app = await launch(ws)
    try {
      const win = await openMcpSettings(app)
      const row = win.locator('.mcp-server-row.mcp-state-connected')
      await expect(row).toBeVisible({ timeout: 15_000 })
      await expect(row.locator('.mcp-server-summary')).toContainText('mock (stdio)')
      await expect(row.locator('.mcp-server-summary')).toContainText('connected')
      await expect(row.locator('.mcp-server-detail')).toContainText('echo')
      await expect(row.locator('.mcp-server-detail')).toContainText('danger')
      await win.screenshot({ path: join(SCREENSHOT_DIR, 'mcp-settings-connected.png') })
    } finally {
      await app.close()
    }
  })

  test('agent calls an MCP tool through chat and the result is shown', async () => {
    const ws = await makeWorkspace({
      mcpServers: { mock: stdioServerEntry({ trusted: true }) },
    })
    await seedProjectConfig(ws, { projectId: 'mcp-chat', threadId: 'mcp-chat-t' })
    const app = await launch(ws)
    try {
      const win = await app.firstWindow()
      await win.waitForSelector('.prompt-input', { timeout: 15_000 })

      await win
        .locator('.prompt-input')
        .fill('echo this for me [[mcp:mcp__mock__echo {"text":"hello from MCP"}]]')
      await win.locator('.submit-btn').click()

      const toolCard = win.locator('.tool-card').first()
      await expect(toolCard.locator('.tool-name')).toHaveText('mock: Echo', { timeout: 15_000 })
      await expect(toolCard).toHaveAttribute('data-status', 'done', { timeout: 15_000 })

      // Expand the card and confirm the MCP server's response made it into the UI.
      await toolCard.locator('.tool-card-header').click()
      await expect(toolCard.locator('.tool-result')).toContainText('echo: hello from MCP')

      // The agent continues the turn after the tool result with a final answer.
      await expect(
        win.locator('.msg-assistant .message-text', { hasText: 'Mock response to' }),
      ).toBeVisible({ timeout: 15_000 })

      await win.screenshot({
        path: join(SCREENSHOT_DIR, 'mcp-chat-toolcall.png'),
        fullPage: true,
      })
    } finally {
      await app.close()
    }
  })

  test('non-trusted MCP tool requires approval before running', async () => {
    const ws = await makeWorkspace({ mcpServers: { mock: stdioServerEntry() } })
    await seedProjectConfig(ws, { projectId: 'mcp-approval', threadId: 'mcp-approval-t' })
    const app = await launch(ws)
    try {
      const win = await app.firstWindow()
      await win.waitForSelector('.prompt-input', { timeout: 15_000 })

      await win
        .locator('.prompt-input')
        .fill('run it [[mcp:mcp__mock__echo {"text":"needs approval"}]]')
      await win.locator('.submit-btn').click()

      const dialog = win.locator('#approval-dialog')
      await expect(dialog).toBeVisible({ timeout: 15_000 })
      await expect(dialog.locator('.approval-title')).toContainText('MCP tool: mock/echo')
      await expect(dialog.locator('.approval-remember')).toBeVisible()
      await win.screenshot({ path: join(SCREENSHOT_DIR, 'mcp-approval-dialog.png') })

      await dialog.locator('.approval-approve').click()

      const toolCard = win.locator('.tool-card').first()
      await expect(toolCard).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
      await toolCard.locator('.tool-card-header').click()
      await expect(toolCard.locator('.tool-result')).toContainText('echo: needs approval')
    } finally {
      await app.close()
    }
  })
})

test.describe('MCP HTTP transport with auth', () => {
  let server: ChildProcess
  let port = 0
  const TOKEN = 'secret-test-token-123'

  test.beforeAll(async () => {
    await mkdir(SCREENSHOT_DIR, { recursive: true })
    server = spawn('node', ['--experimental-strip-types', HTTP_SERVER], {
      env: { ...process.env, MCP_HTTP_TOKEN: TOKEN, MCP_HTTP_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP MCP server did not start')), 10_000)
      server.stdout!.on('data', (chunk: Buffer) => {
        const m = chunk.toString().match(/PORT=(\d+)/)
        if (m) {
          clearTimeout(timer)
          resolve(Number(m[1]))
        }
      })
    })
  })

  test.afterAll(() => {
    server.kill()
  })

  test('connects when the bearer token is correct', async () => {
    const ws = await makeWorkspace({
      mcpServers: {
        remote: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: 'Bearer ${env:MCP_HTTP_TOKEN}' },
        },
      },
    })
    await seedProjectConfig(ws, { projectId: 'mcp-http-ok', threadId: 'mcp-http-ok-t' })
    const app = await launch(ws, { MCP_HTTP_TOKEN: TOKEN })
    try {
      const win = await openMcpSettings(app)
      const statuses = (await win.evaluate(async () => {
        // @ts-expect-error preload API
        return window.api.mcp.list()
      })) as McpStatus[]
      const remote = statuses.find((s) => s.name === 'remote')
      expect(remote, 'remote http server should be present').toBeTruthy()
      expect(
        remote!.state,
        `expected connected, got ${remote!.state} (${remote!.error ?? ''})`,
      ).toBe('connected')
      expect(remote!.tools.sort()).toEqual(['add', 'whoami'])

      const row = win.locator('.mcp-server-row.mcp-state-connected')
      await expect(row.locator('.mcp-server-summary')).toContainText('remote (http)')
      await win.screenshot({ path: join(SCREENSHOT_DIR, 'mcp-http-auth-connected.png') })
    } finally {
      await app.close()
    }
  })

  test('fails to connect when the bearer token is wrong', async () => {
    const ws = await makeWorkspace({
      mcpServers: {
        remote: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          headers: { Authorization: 'Bearer ${env:MCP_HTTP_TOKEN}' },
        },
      },
    })
    await seedProjectConfig(ws, { projectId: 'mcp-http-bad', threadId: 'mcp-http-bad-t' })
    const app = await launch(ws, { MCP_HTTP_TOKEN: 'wrong-token' })
    try {
      const win = await app.firstWindow()
      await win.waitForSelector('.prompt-input', { timeout: 15_000 })
      const statuses = (await win.evaluate(async () => {
        // @ts-expect-error preload API
        return window.api.mcp.list()
      })) as McpStatus[]
      const remote = statuses.find((s) => s.name === 'remote')
      expect(remote, 'remote http server should be present').toBeTruthy()
      expect(remote!.state).toBe('error')
    } finally {
      await app.close()
    }
  })
})
