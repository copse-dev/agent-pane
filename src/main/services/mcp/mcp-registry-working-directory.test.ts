import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { setElectronAppRuntime } from '../electron-app-runtime.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { ToolRegistry } from '../tool-registry.ts'
import {
  getMcpServerStatuses,
  loadMcpServers,
  reloadMcpServers,
  shutdownMcpServers,
} from './mcp-registry.ts'

describe('user MCP server working directory', () => {
  it('does not inherit the selected workspace when cwd is omitted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'copse-user-mcp-cwd-'))
    const workspace = join(root, 'project')
    const record = join(root, 'server-cwd.txt')
    const projectMarker = join(root, 'project-script-executed.txt')
    const configPath = join(root, 'mcp.json')
    const fixture = pathToFileURL(join(process.cwd(), 'tests/e2e/fixtures/mock-mcp-server.mts'))
    const script = `require('node:fs').writeFileSync(process.env.COPSE_TEST_CWD_RECORD, process.cwd()); void import(${JSON.stringify(fixture.href)})`
    const previousE2e = process.env['COPSE_E2E']
    const restoreWorkspace = setWorkspaceRootForTest(workspace)
    setElectronAppRuntime({ userDataPath: root, version: '0.0.0', isPackaged: false })
    process.env['COPSE_E2E'] = '1'
    const registry = new ToolRegistry()

    const setConfig = async (
      cwd?: string,
      args: string[] = ['--experimental-strip-types', '-e', script],
    ): Promise<void> => {
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args,
              env: { COPSE_TEST_CWD_RECORD: record },
              ...(cwd === undefined ? {} : { cwd }),
            },
          },
        }),
      )
    }

    try {
      await mkdir(workspace)
      await setConfig()
      await loadMcpServers(registry)
      assert.equal(
        getMcpServerStatuses().find((server) => server.name === 'fixture')?.state,
        'connected',
      )
      assert.equal(await readFile(record, 'utf8'), homedir())

      await writeFile(
        join(workspace, 'workspace-server.mjs'),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(projectMarker)}, 'executed')`,
      )
      await setConfig(undefined, ['workspace-server.mjs'])
      await reloadMcpServers(registry)
      assert.equal(
        getMcpServerStatuses().find((server) => server.name === 'fixture')?.state,
        'error',
      )
      await assert.rejects(readFile(projectMarker, 'utf8'), { code: 'ENOENT' })

      // A deliberately configured working directory retains its existing
      // meaning; only the implicit project inheritance is removed.
      await setConfig(workspace)
      await reloadMcpServers(registry)
      assert.equal(
        getMcpServerStatuses().find((server) => server.name === 'fixture')?.state,
        'connected',
      )
      assert.equal(await readFile(record, 'utf8'), await realpath(workspace))
    } finally {
      await shutdownMcpServers()
      restoreWorkspace()
      setElectronAppRuntime(null)
      if (previousE2e === undefined) delete process.env['COPSE_E2E']
      else process.env['COPSE_E2E'] = previousE2e
      await rm(root, { recursive: true, force: true })
    }
  })
})
