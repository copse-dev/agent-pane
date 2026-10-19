import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  GITHUB_HEAD_LIMIT,
  githubPlaceholderToken,
  guestGitHubConfig,
  HeadReader,
} from './github-capability-wire.ts'
import { threadContainerRunSpecSchema } from './run-spec.ts'

describe('guestGitHubConfig', () => {
  const config = guestGitHubConfig({
    configDir: '/workspace/home/.config/copse-gh',
    socketPath: '/tmp/copse-github/gh.sock',
    gitProxyPort: 40123,
    placeholder: 'ghp_copse_tabc123_rxyz_00ff',
  })

  it("points gh's every request at the socket, with the placeholder as its token", () => {
    assert.equal(
      config.ghFiles['config.yml'],
      [
        '# Written by Copse for this container run. Every gh request goes to the',
        "# host's GitHub read capability over this socket; the token lives on the host.",
        'http_unix_socket: "/tmp/copse-github/gh.sock"',
        'git_protocol: https',
        'prompt: disabled',
        '',
      ].join('\n'),
    )
    assert.equal(
      config.ghFiles['hosts.yml'],
      [
        'github.com:',
        '    oauth_token: "ghp_copse_tabc123_rxyz_00ff"',
        '    git_protocol: https',
        '',
      ].join('\n'),
    )
  })

  it('rewrites github.com for git to the alias and proxies only the alias', () => {
    assert.deepEqual(config.gitConfig, [
      ['url.http://github.copse.internal/.insteadOf', 'https://github.com/'],
      ['http.http://github.copse.internal/.proxy', 'http://127.0.0.1:40123'],
    ])
  })

  it('names the config directory and never a token in the environment', () => {
    assert.equal(config.env['GH_CONFIG_DIR'], '/workspace/home/.config/copse-gh')
    assert.equal(config.env['GIT_TERMINAL_PROMPT'], '0')
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
      assert.equal(Object.hasOwn(config.env, name), false, name)
    }
    assert.equal(JSON.stringify(config.env).includes('ghp_'), false)
  })
})

describe('githubPlaceholderToken', () => {
  it('binds the thread and run in a shape the run spec accepts', () => {
    const token = githubPlaceholderToken('7d046f-thread/x', 'run-mfx12-a1b2c3', 'deadbeef')
    assert.equal(token, 'ghp_copse_t7d046f_rmfx12a1b2c3_deadbeef')
    const spec = threadContainerRunSpecSchema.shape.github.safeParse({ placeholder: token })
    assert.equal(spec.success, true)
    assert.equal(
      threadContainerRunSpecSchema.shape.github.safeParse({ placeholder: 'ghp_real' }).success,
      false,
    )
  })
})

describe('HeadReader', () => {
  it('returns the head and the body bytes after it, across chunks', () => {
    const reader = new HeadReader()
    assert.equal(reader.feed(Buffer.from('{"a":')), null)
    const found = reader.feed(Buffer.from('1}\nBODY'))
    assert.deepEqual(found && { line: found.line, rest: found.rest.toString() }, {
      line: '{"a":1}',
      rest: 'BODY',
    })
  })

  it('refuses a head over the limit', () => {
    const reader = new HeadReader()
    assert.throws(() => reader.feed(Buffer.alloc(GITHUB_HEAD_LIMIT + 1, 0x61)), /too large/)
  })
})
