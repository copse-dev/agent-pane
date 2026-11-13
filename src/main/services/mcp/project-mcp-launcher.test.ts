import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { projectMcpLauncher } from './project-mcp-launcher.ts'

describe('project MCP launcher', () => {
  it('applies project environment only to the server child', () => {
    const launcher = projectMcpLauncher({
      name: 'project',
      transport: 'stdio',
      command: process.execPath,
      args: [
        '-e',
        "process.stdout.write([process.env.PROJECT_MODE, process.env.BASH_ENV, process.env.ELECTRON_RUN_AS_NODE ?? 'none'].join('|'))",
      ],
      env: { PROJECT_MODE: 'reviewed', BASH_ENV: '/project/changed-hook.sh' },
    })
    assert.equal(launcher.env['PROJECT_MODE'], undefined)
    assert.equal(launcher.env['BASH_ENV'], '')
    const output = execFileSync(launcher.command, launcher.args, {
      env: { ...process.env, ...launcher.env },
      encoding: 'utf8',
    })
    assert.equal(output, 'reviewed|/project/changed-hook.sh|none')
  })
})
