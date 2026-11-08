import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { preflightLocalAcpModel } from './acp-command-preflight.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function agent(command: string, env?: Record<string, string>): AcpAgentConfig {
  return { id: 'codex-acp', title: 'Codex', command, enabled: true, ...(env ? { env } : {}) }
}

describe('local ACP command preflight', () => {
  for (const id of ['codex-acp', 'claude-acp']) {
    it(
      `rejects a genuinely missing ${id} command without calling it`,
      { skip: process.platform === 'win32' },
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'copse-command-preflight-'))
        roots.push(root)
        await assert.rejects(
          preflightLocalAcpModel(`acp:${id}#model`, root, {
            getAgent: (requestedId) => {
              assert.equal(requestedId, id)
              return { ...agent(join(root, 'missing')), id }
            },
          }),
          /configured command is missing or not executable.*Settings → General → Models & agents/,
        )
      },
    )
  }

  it(
    'checks the saved PATH, accepts a repaired executable, and never runs its body',
    { skip: process.platform === 'win32' },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'copse-command-preflight-'))
      roots.push(root)
      const command = join(root, 'adapter')
      await writeFile(command, '#!/bin/sh\nexit 99\n')
      const deps = { getAgent: (): AcpAgentConfig => agent('adapter', { PATH: root }) }
      await assert.rejects(preflightLocalAcpModel('acp:codex-acp', root, deps), /not executable/)
      await chmod(command, 0o755)
      await preflightLocalAcpModel('acp:codex-acp', root, deps)
      await rm(command)
      await mkdir(command)
      await assert.rejects(preflightLocalAcpModel('acp:codex-acp', root, deps), /not executable/)
    },
  )

  it('accepts system commands supplied by the sandbox launcher with a restricted PATH', async () => {
    await preflightLocalAcpModel('acp:custom', '/repo', {
      getAgent: () => agent('sh', { PATH: '/copse-missing-custom-bin' }),
    })
  })

  it('preserves uncertainty from empty and relative original PATH entries', async () => {
    for (const PATH of ['', ':/copse-missing-custom-bin', './bin']) {
      await preflightLocalAcpModel('acp:custom', '/repo', {
        getAgent: () => agent('copse-missing-custom-agent', { PATH }),
      })
    }
  })

  it('does not inspect native or provider-hosted models', async () => {
    for (const model of [undefined, 'gpt-5.4', 'remote:codex']) {
      await preflightLocalAcpModel(model, '/repo', {
        getAgent: () => {
          throw new Error('must not read the ACP registry')
        },
      })
    }
  })

  it('gives setup recovery for a removed or disabled saved agent', async () => {
    await assert.rejects(
      preflightLocalAcpModel('acp:codex-acp', '/repo', { getAgent: () => null }),
      /coding agent is not enabled.*Settings → General/,
    )
  })

  it('preserves normal startup for relative commands and uncertain lookup results', async () => {
    await preflightLocalAcpModel('acp:custom', '/repo', { getAgent: () => agent('./adapter') })
    await preflightLocalAcpModel('acp:custom', '/repo', {
      getAgent: () => agent('adapter'),
      available: async () => null,
    })
  })
})
