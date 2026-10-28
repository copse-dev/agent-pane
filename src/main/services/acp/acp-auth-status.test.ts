import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AcpAuthState } from '@shared/types/acp.ts'
import { probeAcpAuth, type AcpAuthProbeDeps } from './acp-auth-status.ts'

function deps(over: Partial<AcpAuthProbeDeps> = {}): AcpAuthProbeDeps {
  return {
    env: {},
    home: '/home/u',
    fileExists: () => Promise.resolve(false),
    exec: () => Promise.reject(new Error('not run')),
    agent: { command: 'codex-acp', args: [] },
    ...over,
  }
}

describe('probeAcpAuth', () => {
  it('reads Claude from `claude auth status`', async () => {
    const run = (stdout: string): AcpAuthProbeDeps => deps({ exec: () => Promise.resolve(stdout) })
    assert.equal(await probeAcpAuth('claude-acp', run('{"loggedIn":true}')), 'signed-in')
    assert.equal(await probeAcpAuth('claude-acp', run('{"loggedIn":false}')), 'signed-out')
    assert.equal(await probeAcpAuth('claude-acp', run('{"other":1}')), 'unknown')
    assert.equal(await probeAcpAuth('claude-acp', run('not json')), 'unknown')
  })

  it('treats a Claude CLI that cannot answer as unknown, never signed out', async () => {
    assert.equal(await probeAcpAuth('claude-acp', deps()), 'unknown')
  })

  it('does not treat configured credentials as a working sign-in', async () => {
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      const env = { [name]: 'invalid-test-credential' }
      assert.equal(await probeAcpAuth('claude-acp', deps({ env })), 'unknown')
      assert.equal(
        await probeAcpAuth(
          'claude-acp',
          deps({
            env,
            exec: async () => '{"loggedIn":false}',
          }),
        ),
        'signed-out',
      )
    }
    assert.equal(
      await probeAcpAuth('codex-acp', deps({ env: { OPENAI_API_KEY: 'invalid' } })),
      'unknown',
    )
    assert.equal(
      await probeAcpAuth('cursor', deps({ env: { CURSOR_API_KEY: 'invalid' } })),
      'unknown',
    )
    assert.equal(
      await probeAcpAuth('gemini', deps({ env: { GEMINI_API_KEY: 'invalid' } })),
      'unknown',
    )
    assert.equal(await probeAcpAuth('gemini', deps({ env: { GEMINI_API_KEY: ' ' } })), 'signed-out')
  })

  it('does not claim authentication from credential-file presence alone', async () => {
    const files = new Set(['/home/u/.codex/auth.json'])
    const d = deps({ fileExists: (p) => Promise.resolve(files.has(p)) })
    assert.equal(await probeAcpAuth('codex-acp', d), 'unknown')
    assert.equal(await probeAcpAuth('gemini', d), 'signed-out')
    files.add('/home/u/.gemini/oauth_creds.json')
    assert.equal(await probeAcpAuth('gemini', d), 'unknown')
  })

  it('reads Codex login status without treating a credential file as proof', async () => {
    assert.equal(
      await probeAcpAuth('codex-acp', deps({ exec: async () => 'Logged in using ChatGPT' })),
      'signed-in',
    )
    assert.equal(
      await probeAcpAuth('codex-acp', deps({ exec: async () => 'Not logged in' })),
      'signed-out',
    )
    assert.equal(
      await probeAcpAuth('codex-acp', deps({ exec: async () => 'Unknown command' })),
      'unknown',
    )
  })

  it('asks the adapter-bundled Codex CLI when no standalone `codex` is installed', async () => {
    const calls: string[] = []
    const probe = (
      adapterOut: string,
      agent: AcpAuthProbeDeps['agent'] = { command: 'codex-acp', args: [] },
    ): Promise<AcpAuthState> =>
      probeAcpAuth(
        'codex-acp',
        deps({
          agent,
          exec: async (command, args) => {
            calls.push([command, ...args].join(' '))
            if (command === 'codex')
              throw Object.assign(new Error('spawn codex'), { code: 'ENOENT' })
            return adapterOut
          },
        }),
      )
    assert.equal(await probe('Logged in using ChatGPT'), 'signed-in')
    assert.deepEqual(calls, ['codex-acp cli login status'])
    assert.equal(await probe('Not logged in'), 'signed-out')
    assert.equal(await probe('Usage: codex-acp [options]'), 'unknown')
    calls.length = 0
    await probe('Logged in using ChatGPT', {
      command: 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp'],
    })
    assert.equal(calls[0], 'npx -y @agentclientprotocol/codex-acp cli login status')
  })

  it('uses the adapter status even when standalone Codex would contradict it', async () => {
    for (const [adapter, standalone, expected] of [
      ['Logged in using ChatGPT', 'Not logged in', 'signed-in'],
      ['Not logged in', 'Logged in using ChatGPT', 'signed-out'],
      ['Usage: codex-acp', 'Logged in using ChatGPT', 'unknown'],
    ] as const) {
      const calls: string[] = []
      const d = deps({
        env: { CODEX_PATH: '/custom/codex' },
        exec: async (command) => {
          calls.push(command)
          return command === 'codex' ? standalone : adapter
        },
      })
      assert.equal(await probeAcpAuth('codex-acp', d), expected)
      assert.deepEqual(calls, ['codex-acp'])
    }
  })

  it('parses `cursor-agent status`', async () => {
    const run = (stdout: string): AcpAuthProbeDeps => deps({ exec: () => Promise.resolve(stdout) })
    assert.equal(await probeAcpAuth('cursor', run('✓ Logged in as a@b.c')), 'signed-in')
    assert.equal(await probeAcpAuth('cursor', run('Not logged in')), 'signed-out')
    assert.equal(await probeAcpAuth('cursor', deps()), 'unknown')
  })

  it('is unknown for an agent it has no check for, including prototype keys', async () => {
    assert.equal(await probeAcpAuth('goose', deps()), 'unknown')
    assert.equal(await probeAcpAuth('constructor', deps()), 'unknown')
  })
})

describe('detectAcpAuthStatus environment boundary', () => {
  it('does not use ambient provider keys that the ACP child cannot receive', async () => {
    const { detectAcpAuthStatus } = await import('./acp-auth-status.ts')
    const previous = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = 'ambient-test-key'
    try {
      const result = await detectAcpAuthStatus(['codex-acp'], (env, agent) => {
        assert.equal(env['OPENAI_API_KEY'], undefined)
        assert.equal(agent.command, 'codex-acp', 'probes the catalog launch command')
        return deps({ env, agent })
      })
      assert.deepEqual(result, [{ id: 'codex-acp', state: 'unknown' }])
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
      else process.env['OPENAI_API_KEY'] = previous
    }
  })

  it('keeps failed Codex probes unknown regardless of credential-file presence', async () => {
    for (const code of ['ENOENT', 'EACCES', 'ETIMEDOUT']) {
      for (const exists of [false, true]) {
        let inspected = false
        assert.equal(
          await probeAcpAuth(
            'codex-acp',
            deps({
              env: { CODEX_HOME: '/custom/codex' },
              exec: async () => {
                throw Object.assign(new Error('status failed'), { code })
              },
              fileExists: async () => {
                inspected = true
                return exists
              },
            }),
          ),
          'unknown',
          `${code} with credential file ${exists ? 'present' : 'absent'}`,
        )
        assert.equal(inspected, false, 'failed status must not infer login from a file')
      }
    }
  })

  it('treats unrecognised CLI output as unknown', async () => {
    assert.equal(
      await probeAcpAuth('cursor', deps({ exec: async () => 'Unexpected help text' })),
      'unknown',
    )
  })
})
