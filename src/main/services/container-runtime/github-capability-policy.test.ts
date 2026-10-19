import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideGitHubRequest,
  parseAuthority,
  type GitHubDecision,
  type GitHubRequestFacts,
} from './github-capability-policy.ts'

function decide(
  method: string,
  target: string,
  host: string | null = 'api.github.com',
): GitHubDecision {
  const facts: GitHubRequestFacts = { method, target, host }
  return decideGitHubRequest(facts)
}

function refused(decision: GitHubDecision): string {
  if (decision.action !== 'refuse') assert.fail(`expected a refusal: ${JSON.stringify(decision)}`)
  return decision.reason
}

describe('decideGitHubRequest: hosts', () => {
  it('gives the API its token for reads', () => {
    assert.deepEqual(decide('GET', '/user'), {
      action: 'forward',
      host: 'api.github.com',
      path: '/user',
      auth: 'token',
      body: 'none',
    })
    assert.equal(decide('HEAD', '/repos/o/r', 'API.GitHub.com').action, 'forward')
    assert.equal(decide('GET', '/user', 'api.github.com:443').action, 'forward')
  })

  it('refuses every look-alike of a token-bearing host', () => {
    for (const host of [
      'api.github.com.',
      'api.github.com:80',
      'api.github.com:8443',
      'api.github.com.evil.example',
      'evilapi.github.com',
      'xapi.github.com',
      'api.github.co',
      'github.com.',
      'github.com.evil.example',
      'notgithub.com',
      'user@api.github.com',
      'user:pass@api.github.com',
      '140.82.112.6',
      '[::1]',
      '127.0.0.1:443',
      'api..github.com',
      '.api.github.com',
      'api.github.com/x',
      'api.github.com\\x',
      '',
    ]) {
      const decision = decide('GET', '/user', host)
      assert.equal(decision.action, 'refuse', host)
    }
  })

  it('refuses a request with no or several Host headers', () => {
    assert.match(refused(decide('GET', '/user', null)), /Host/)
  })

  it('forwards pass-through hosts at any depth without a credential, reads only', () => {
    for (const host of [
      'codeload.github.com',
      'raw.githubusercontent.com',
      'objects.githubusercontent.com',
      'results-receiver.actions.githubusercontent.com',
      'a.b.c.githubusercontent.com',
    ]) {
      assert.deepEqual(decide('GET', '/x?sig=abc', host), {
        action: 'forward',
        host,
        path: '/x?sig=abc',
        auth: 'none',
        body: 'none',
      })
      refused(decide('POST', '/x', host))
      refused(decide('PUT', '/x', host))
    }
    for (const host of [
      'githubusercontent.com',
      'evilgithubusercontent.com',
      'raw.githubusercontent.com.evil.example',
      'raw.githubusercontent.com.',
      'x.codeload.github.com',
      'uploads.github.com',
      'gist.github.com',
      'example.com',
    ]) {
      refused(decide('GET', '/x', host))
    }
  })

  it('takes absolute-form only for the git alias, and only when the Host agrees', () => {
    const viaProxy = decide(
      'GET',
      'http://github.copse.internal/o/r.git/info/refs?service=git-upload-pack',
      'github.copse.internal',
    )
    assert.deepEqual(viaProxy, {
      action: 'forward',
      host: 'github.com',
      path: '/o/r.git/info/refs?service=git-upload-pack',
      auth: 'basic',
      body: 'none',
    })
    assert.match(
      refused(
        decide(
          'GET',
          'http://github.copse.internal/o/r.git/info/refs?service=git-upload-pack',
          'api.github.com',
        ),
      ),
      /different hosts/,
    )
    assert.match(
      refused(decide('GET', 'http://api.github.com/user', 'api.github.com')),
      /git alias/,
    )
    assert.match(
      refused(decide('GET', 'https://api.github.com/user', 'api.github.com')),
      /origin-form/,
    )
    refused(
      decide(
        'GET',
        'http://x@github.copse.internal/o/r.git/info/refs?service=git-upload-pack',
        'github.copse.internal',
      ),
    )
    refused(
      decide(
        'GET',
        'http://github.copse.internal:8080/o/r.git/info/refs?service=git-upload-pack',
        'github.copse.internal:8080',
      ),
    )
    refused(decide('CONNECT', 'api.github.com:443', 'api.github.com:443'))
    refused(decide('GET', '*', 'api.github.com'))
  })
})

describe('decideGitHubRequest: git', () => {
  it('gives git fetch paths Basic credentials on github.com', () => {
    for (const repo of ['o/r.git', 'o/r', 'my-org/my.repo']) {
      const refs = decide('GET', `/${repo}/info/refs?service=git-upload-pack`, 'github.com')
      assert.equal(refs.action === 'forward' && refs.auth, 'basic', repo)
      const pack = decide('POST', `/${repo}/git-upload-pack`, 'github.com')
      assert.deepEqual(pack, {
        action: 'forward',
        host: 'github.com',
        path: `/${repo}/git-upload-pack`,
        auth: 'basic',
        body: 'stream',
      })
    }
  })

  it('refuses receive-pack in every spelling, including the info/refs probe', () => {
    for (const [method, target] of [
      ['GET', '/o/r.git/info/refs?service=git-receive-pack'],
      ['GET', '/o/r/info/refs?service=git%2Dreceive%2Dpack'],
      ['GET', '/o/r/info/refs?service=GIT-RECEIVE-PACK'],
      ['POST', '/o/r.git/git-receive-pack'],
      ['POST', '/o/r/git-receive-pack'],
      ['POST', '/o/r/git%2Dreceive-pack'],
    ] as const) {
      assert.match(refused(decide(method, target, 'github.com')), /pushing/, target)
      assert.match(
        refused(decide(method, `http://github.copse.internal${target}`, 'github.copse.internal')),
        /pushing/,
        target,
      )
    }
  })

  it('does not give the token to github.com paths that are not git fetches', () => {
    const page = decide('GET', '/o/r/pulls', 'github.com')
    assert.equal(page.action === 'forward' && page.auth, 'none')
    // The dumb protocol, or anything but upload-pack, is not a git fetch.
    const dumb = decide('GET', '/o/r.git/info/refs', 'github.com')
    assert.equal(dumb.action === 'forward' && dumb.auth, 'none')
    refused(decide('POST', '/o/r/pulls', 'github.com'))
    refused(decide('POST', '/o/r.git/info/lfs/objects/batch', 'github.com'))
    // An encoded slash cannot reshape a path into a git one.
    const encoded = decide('POST', '/o/r%2Fx/git-upload-pack', 'github.com')
    assert.equal(encoded.action, 'refuse')
  })

  it('lets the alias carry git fetches only', () => {
    assert.match(
      refused(decide('GET', 'http://github.copse.internal/o/r/pulls', 'github.copse.internal')),
      /only git fetches/,
    )
    assert.match(refused(decide('GET', '/user', 'github.copse.internal')), /only git fetches/)
  })

  it('refuses dot segments and malformed encoding', () => {
    refused(decide('GET', '/o/r/../../user', 'api.github.com'))
    refused(decide('GET', '/o/r/%2e%2e/user', 'api.github.com'))
    refused(decide('GET', '/o/%E0%A4%A', 'api.github.com'))
    refused(decide('GET', '/o r', 'api.github.com'))
    refused(decide('GET', '/o#r', 'api.github.com'))
  })
})

describe('decideGitHubRequest: methods', () => {
  it('routes GraphQL POSTs to the body check and refuses every other write', () => {
    const graphql = decide('POST', '/graphql')
    assert.equal(graphql.action === 'forward' && graphql.body, 'graphql')
    refused(decide('POST', '/graphql?x=1'))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
      assert.match(refused(decide(method, '/repos/o/r/issues/1/comments')), /write/, method)
    }
    assert.equal(decide('post', '/graphql').action, 'forward')
    assert.match(refused(decide('GET', '/graphql?query=mutation{x}')), /POST/)
    assert.match(refused(decide('HEAD', '/graphql/')), /POST/)
    refused(decide('G ET', '/user'))
  })
})

describe('parseAuthority', () => {
  it('lowercases and splits a port', () => {
    assert.deepEqual(parseAuthority('API.GitHub.com:443'), { host: 'api.github.com', port: 443 })
    assert.deepEqual(parseAuthority('github.com'), { host: 'github.com', port: null })
    assert.equal(parseAuthority('github.com:0'), null)
    assert.equal(parseAuthority('github.com:99999'), null)
    assert.equal(parseAuthority('-github.com'), null)
  })
})
