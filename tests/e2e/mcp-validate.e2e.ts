import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { setComposerValue } from './helpers/composer.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import {
  e2eWorkspaceDir,
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
} from './helpers/seed-config.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { waitForAgentIdle } from './helpers.ts'

const STDIO_SERVER = join(process.cwd(), 'tests/e2e/fixtures/mock-mcp-server.mts')
const HTTP_SERVER = join(process.cwd(), 'tests/e2e/fixtures/http-mcp-server.mts')
const HTTP_TOKEN = 'mcp-e2e-token'
const INITIAL_HTTP_TOKEN = process.env['MCP_HTTP_TOKEN']
const temporaryWorkspaces: string[] = []

function isolatedMcpConfigPath(): string {
  const root = process.env['COPSE_PANEL_USER_DATA']
  if (!root) throw new Error('MCP fixtures require an isolated WDIO user-data directory')
  return join(root, 'mcp.json')
}

function stdioServerEntry(): Record<string, unknown> {
  return { command: 'node', args: ['--experimental-strip-types', STDIO_SERVER] }
}

async function createWorkspace(id: string, mcpServers: Record<string, unknown>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `copse-mcp-${id}-`))
  temporaryWorkspaces.push(workspace)
  await mkdir(join(workspace, '.cursor'), { recursive: true })
  await writeFile(join(workspace, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers }), 'utf8')
  return workspace
}

async function startWorkspace(id: string, mcpServers: Record<string, unknown>): Promise<void> {
  // Stop the old app before replacing its profile. Its in-memory store can
  // otherwise flush the previous project over the new seed during shutdown.
  await browser.deleteSession({ shutdownDriver: false })
  await rm(e2eWorkspaceDir(), { recursive: true, force: true })
  const workspace = await createWorkspace(id, mcpServers)
  const projectId = `e2e-${id}`
  const trustedRoot = await realpath(workspace)
  resetUserData()
  seedEmptyProject(workspace, projectId, {
    subagentsEnabled: false,
    model: 'claude-sonnet-4-6',
  })
  // The project config is intentionally trusted to keep this fixture state
  // representative. Fixture activation reads only the isolated userData config,
  // so no project-defined server can escape the test boundary.
  writeSeedConfig({
    projects: [{ id: projectId, path: workspace, name: 'workspace' }],
    activeProjectId: projectId,
    trustedWorkspaceRoots: [trustedRoot],
    [`threads:${projectId}`]: [],
  })
  await writeFile(isolatedMcpConfigPath(), JSON.stringify({ mcpServers }), 'utf8')
  await browser.reloadSession()
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  await browser.waitUntil(
    async () => {
      const active = await browser.execute(() => window.api.workspace.get())
      return active === workspace || active === trustedRoot
    },
    { timeout: 10_000, timeoutMsg: `Expected the ${id} workspace to finish opening` },
  )
}

async function cleanupMcpFixtures(): Promise<void> {
  await rm(isolatedMcpConfigPath(), { force: true })
  await Promise.all(
    temporaryWorkspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  )
}

// Keep earlier workspaces alive while Electron shuts down between tests. Deleting
// the active root first lets its missing-project watcher overwrite the next seed.
after(async () => {
  await cleanupMcpFixtures()
  resetUserData()
})

async function openMcpSettings(): Promise<WebdriverIO.Element> {
  await $('[aria-label="Settings"]').click()
  const settings = await $('#settings-dialog')
  await settings.waitForDisplayed({ timeout: 15_000 })
  await settings.$('.settings-nav-btn[data-section="mcp"]').click()
  await settings.$('#mcp-reload-btn').click()
  await browser.waitUntil(
    async () => (await settings.$('#mcp-reload-status').getText()).includes('server(s) connected'),
    { timeout: 15_000, timeoutMsg: 'MCP server reload did not finish' },
  )
  return settings
}

describe('MCP validation', () => {
  afterEach(() => {
    resetUserData()
  })

  it('shows a connected stdio server and its tools in Settings', async function () {
    this.timeout(60_000)
    await startWorkspace('mcp-settings', { documentation: stdioServerEntry() })

    const settings = await openMcpSettings()
    const row = await $('.mcp-server-row.mcp-state-connected')
    await row.waitForDisplayed({ timeout: 30_000 })
    await expect(row.$('.mcp-server-summary')).toHaveText(
      expect.stringContaining('documentation (stdio)'),
    )
    await expect(row.$('.mcp-server-summary')).toHaveText(expect.stringContaining('connected'))
    await expect(row.$('.mcp-server-detail')).toHaveText(expect.stringContaining('echo'))
    await expect(row.$('.mcp-server-detail')).toHaveText(expect.stringContaining('danger'))
    await saveAppScreenshot('mcp-settings-connected.png')
    await settings.$('#settings-close').click()
  })

  it('runs an approved MCP tool and renders its real result before the reply', async function () {
    this.timeout(60_000)
    await startWorkspace('mcp-chat', { documentation: stdioServerEntry() })
    const settings = await openMcpSettings()
    await $('.mcp-server-row.mcp-state-connected').waitForDisplayed({ timeout: 30_000 })
    await settings.$('#settings-close').click()
    const scenario = await installMockScenario({
      title: 'Look up a documentation note',
      turns: [
        {
          user: 'Look up the note hello from MCP in the documentation service.',
          responses: [
            {
              toolCalls: [
                {
                  name: 'mcp__documentation__echo',
                  args: { text: 'hello from MCP' },
                },
              ],
            },
            {
              text: 'The documentation service returned: echo: hello from MCP.',
              expectToolResults: [{ name: 'mcp__documentation__echo', includes: 'hello from MCP' }],
            },
          ],
        },
      ],
    })

    await setComposerValue('Look up the note hello from MCP in the documentation service.')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await dialog.$('.approval-approve').click()
    await dialog.waitForDisplayed({ reverse: true, timeout: 15_000 })

    await waitForAgentIdle(30_000)
    const rollup = await $('.tool-card-rollup')
    if (!(await rollup.getProperty('open'))) await rollup.$('.tool-card-header').click()
    const toolCard = await $('.tool-card[data-tool-id]')
    await toolCard.waitForDisplayed({ timeout: 30_000 })
    await expect(toolCard.$('.tool-name')).toHaveText('Echo')
    await expect(toolCard).toHaveAttribute('data-status', 'done')
    await waitForAgentIdle(30_000)
    if (!(await toolCard.getProperty('open'))) {
      await toolCard.$('.tool-card-header').click()
    }
    await expect(toolCard.$('.tool-result')).toHaveText(
      expect.stringContaining('echo: hello from MCP'),
    )
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The documentation service returned: echo: hello from MCP.')
    await saveAppScreenshot('mcp-chat-toolcall.png')
    await scenario.assertComplete()
  })

  it('asks for approval before an untrusted MCP tool runs', async function () {
    this.timeout(60_000)
    await startWorkspace('mcp-approval', { documentation: stdioServerEntry() })
    const settings = await openMcpSettings()
    await $('.mcp-server-row.mcp-state-connected').waitForDisplayed({ timeout: 30_000 })
    await settings.$('#settings-close').click()
    const scenario = await installMockScenario({
      title: 'Confirm a documentation lookup',
      turns: [
        {
          user: 'Ask the documentation service to echo needs approval.',
          responses: [
            {
              toolCalls: [
                {
                  name: 'mcp__documentation__echo',
                  args: { text: 'needs approval' },
                },
              ],
            },
            {
              text: 'The documentation service returned: echo: needs approval.',
              expectToolResults: [{ name: 'mcp__documentation__echo', includes: 'needs approval' }],
            },
          ],
        },
      ],
    })

    await setComposerValue('Ask the documentation service to echo needs approval.')
    await $('.submit-btn').click()

    const dialog = await $('#approval-dialog')
    await dialog.waitForDisplayed({ timeout: 30_000 })
    await expect(dialog.$('.approval-heading')).toHaveText(
      expect.stringContaining('MCP tool: documentation/echo'),
    )
    await expect(dialog.$('.approval-approve')).toBeDisplayed()
    await expect(dialog.$('.approval-reject')).toBeDisplayed()
    await expect($('.tool-card[data-tool-id]')).toHaveAttribute('data-status', 'running')
    await expect($('.tool-card[data-tool-id] .tool-result')).not.toExist()
    await saveAppScreenshot('mcp-approval-dialog.png')

    await dialog.$('.approval-approve').click()
    await waitForAgentIdle(30_000)
    const rollup = await $('.tool-card-rollup')
    if (!(await rollup.getProperty('open'))) await rollup.$('.tool-card-header').click()
    const toolCard = await $('.tool-card[data-tool-id]')
    await toolCard.waitForDisplayed({ timeout: 30_000 })
    await expect(toolCard).toHaveAttribute('data-status', 'done')
    await waitForAgentIdle(30_000)
    if (!(await toolCard.getProperty('open'))) {
      await toolCard.$('.tool-card-header').click()
    }
    await expect(toolCard.$('.tool-result')).toHaveText(
      expect.stringContaining('echo: needs approval'),
    )
    await waitForAgentIdle(30_000)
    await expectAssistantReply('The documentation service returned: echo: needs approval.')
    await scenario.assertComplete()
  })
})

describe('MCP HTTP transport with auth', () => {
  let server: ChildProcess | undefined
  let port = 0

  before(async function () {
    this.timeout(30_000)
    server = spawn('node', ['--experimental-strip-types', HTTP_SERVER], {
      env: { ...process.env, MCP_HTTP_TOKEN: HTTP_TOKEN, MCP_HTTP_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    port = await new Promise<number>((resolve, reject) => {
      const child = server
      const stdout = child.stdout
      if (!stdout) {
        reject(new Error('HTTP MCP server did not expose stdout'))
        return
      }
      let settled = false
      const finish = (value: number | Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off('error', onError)
        child.off('exit', onExit)
        stdout.off('data', onData)
        if (value instanceof Error) reject(value)
        else resolve(value)
      }
      const onData = (chunk: Buffer) => {
        const match = chunk.toString().match(/PORT=(\d+)/)
        if (!match?.[1]) return
        finish(Number(match[1]))
      }
      const onError = (error: Error) => finish(error)
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          new Error(
            `HTTP MCP server exited before listening (code ${String(code)}, signal ${String(signal)})`,
          ),
        )
      }
      const timer = setTimeout(() => {
        finish(new Error('HTTP MCP server did not start'))
      }, 10_000)
      child.once('error', onError)
      child.once('exit', onExit)
      stdout.on('data', onData)
    })
  })

  after(async () => {
    server?.kill()
    writeE2eEnv({ MCP_HTTP_TOKEN: INITIAL_HTTP_TOKEN })
    resetUserData()
  })

  it('connects to an authenticated HTTP MCP server', async function () {
    this.timeout(60_000)
    writeE2eEnv({ MCP_HTTP_TOKEN: HTTP_TOKEN })
    await startWorkspace('mcp-http-ok', {
      remote: {
        type: 'http',
        url: `http://127.0.0.1:${String(port)}/mcp`,
        headers: { Authorization: 'Bearer ${env:MCP_HTTP_TOKEN}' },
      },
    })

    const settings = await openMcpSettings()
    const row = await $('.mcp-server-row.mcp-state-connected')
    await row.waitForDisplayed({ timeout: 30_000 })
    await expect(row.$('.mcp-server-summary')).toHaveText(expect.stringContaining('remote (http)'))
    await expect(row.$('.mcp-server-summary')).toHaveText(expect.stringContaining('connected'))
    await expect(row.$('.mcp-server-detail')).toHaveText(expect.stringContaining('add'))
    await expect(row.$('.mcp-server-detail')).toHaveText(expect.stringContaining('whoami'))
    await saveAppScreenshot('mcp-http-auth-connected.png')
    await settings.$('#settings-close').click()
  })

  it('reports an error when the HTTP MCP bearer token is wrong', async function () {
    this.timeout(60_000)
    writeE2eEnv({ MCP_HTTP_TOKEN: 'wrong-token' })
    await startWorkspace('mcp-http-bad', {
      remote: {
        type: 'http',
        url: `http://127.0.0.1:${String(port)}/mcp`,
        headers: { Authorization: 'Bearer ${env:MCP_HTTP_TOKEN}' },
      },
    })

    const settings = await openMcpSettings()
    const row = await $('.mcp-server-row.mcp-state-error')
    await row.waitForDisplayed({ timeout: 30_000 })
    await expect(row.$('.mcp-server-summary')).toHaveText(expect.stringContaining('remote (http)'))
    await expect(row.$('.mcp-server-summary')).toHaveText(expect.stringContaining('error'))
    await settings.$('#settings-close').click()
  })
})
