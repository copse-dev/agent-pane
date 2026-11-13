import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setWorkspaceTrusted } from '../security/workspace-trust.ts'
import { storageSet } from '../storage/storage.ts'
import { listForwardableMcpServers, readProjectMcpConsent } from './mcp-registry.ts'
import {
  approveProjectMcpConfig,
  isProjectMcpConfigApproved,
  projectMcpConsent,
  revokeProjectMcpConfig,
} from './project-mcp-consent.ts'

const APPROVALS_KEY = 'approvedProjectMcpConfigurations'

describe('project MCP consent', () => {
  afterEach(() => {
    storageSet(APPROVALS_KEY, [])
  })

  it('pins exact command, arguments, environment and working directory', async () => {
    storageSet(APPROVALS_KEY, [])
    const config = {
      name: 'project-server',
      transport: 'stdio' as const,
      command: '/usr/bin/node',
      args: ['server.js'],
      env: { MODE: 'safe' },
      cwd: '/project',
    }
    const reviewed = projectMcpConsent('/project', [config])
    assert.equal(isProjectMcpConfigApproved(reviewed), false)
    await approveProjectMcpConfig(reviewed)
    assert.equal(isProjectMcpConfigApproved(reviewed), true)
    for (const changed of [
      { ...config, command: '/bin/sh' },
      { ...config, args: ['other.js'] },
      { ...config, env: { MODE: 'unsafe' } },
      { ...config, cwd: '/tmp' },
    ]) {
      assert.equal(isProjectMcpConfigApproved(projectMcpConsent('/project', [changed])), false)
    }
    await revokeProjectMcpConfig('/project')
    assert.equal(isProjectMcpConfigApproved(reviewed), false)
  })

  it('never forwards project stdio to external agents and still pins reviewed HTTP definitions', async () => {
    storageSet(APPROVALS_KEY, [])
    const root = await mkdtemp(join(tmpdir(), 'copse-project-mcp-consent-'))
    const configPath = join(root, '.mcp.json')
    const previousUserData = process.env['COPSE_PANEL_USER_DATA']
    process.env['COPSE_PANEL_USER_DATA'] = root
    const restoreRoot = setWorkspaceRootForTest(root)
    setWorkspaceTrusted(root, true)
    const projectServers = async (): Promise<string[]> =>
      (await listForwardableMcpServers())
        .filter((config) => config.source === configPath)
        .map((config) => config.name)
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            project: { command: '/bin/echo' },
            remote: { url: 'https://example.invalid/mcp' },
          },
        }),
      )
      await writeFile(
        join(root, 'mcp.json'),
        JSON.stringify({ mcpServers: { user: { command: '/bin/echo' } } }),
      )
      assert.equal(
        (await listForwardableMcpServers()).find((config) => config.name === 'user')?.cwd,
        homedir(),
      )
      assert.deepEqual(await projectServers(), [])
      const reviewed = await readProjectMcpConsent(root)
      await approveProjectMcpConfig(reviewed)
      assert.deepEqual(await projectServers(), ['remote'])
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            project: { command: '/bin/sh' },
            remote: { url: 'https://example.invalid/mcp' },
          },
        }),
      )
      assert.deepEqual(await projectServers(), [])
    } finally {
      if (previousUserData === undefined) delete process.env['COPSE_PANEL_USER_DATA']
      else process.env['COPSE_PANEL_USER_DATA'] = previousUserData
      setWorkspaceTrusted(root, false)
      restoreRoot()
      await rm(root, { recursive: true, force: true })
    }
  })
})
