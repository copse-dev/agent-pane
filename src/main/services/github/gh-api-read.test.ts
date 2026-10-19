import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  GH_API_READ_MAX_OUTPUT_BYTES,
  GH_API_READ_MAX_PAGES,
  nextRestEndpoint,
  parseGhApiReadArgs,
  parseGraphqlQuery,
  parseRestEndpoint,
  runGhApiRead,
  truncateUtf8,
  validateJq,
  type GhApiReadInput,
  type GhApiRunner,
} from './gh-api-read.ts'

function input(args: Parameters<typeof parseGhApiReadArgs>[0]): GhApiReadInput {
  const parsed = parseGhApiReadArgs(args)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

function refused(args: Parameters<typeof parseGhApiReadArgs>[0]): string {
  const parsed = parseGhApiReadArgs(args)
  if (parsed.ok) assert.fail(`accepted ${JSON.stringify(args)}`)
  return parsed.error
}

/** The `index`th recorded call's stdin, parsed. */
function sentBody(calls: readonly Call[], index: number): unknown {
  const stdin = calls[index]?.stdin
  assert.ok(stdin !== undefined, `call ${String(index)} had no stdin`)
  return JSON.parse(stdin)
}

interface Call {
  args: string[]
  stdin: string | undefined
}

/** A recorded `gh` that answers each call from `respond`. */
function recordingGh(respond: (call: Call, index: number) => { stdout: string; code?: number }): {
  run: GhApiRunner
  calls: Call[]
} {
  const calls: Call[] = []
  const run: GhApiRunner = async (args, opts) => {
    const call = { args, stdin: opts.stdin?.toString('utf8') }
    calls.push(call)
    const { stdout, code = 0 } = respond(call, calls.length - 1)
    return { stdout, stderr: code === 0 ? '' : 'gh: HTTP 404', code }
  }
  return { run, calls }
}

function included(body: string, headers: string[] = []): string {
  return ['HTTP/2.0 200 OK', ...headers, '', body].join('\r\n')
}

describe('parseRestEndpoint', () => {
  it('accepts relative API paths with a query string', () => {
    for (const endpoint of [
      'repos/o/r/rules/branches/main',
      'repos/{owner}/{repo}/pulls?state=all&per_page=100',
      'repos/o/r/compare/main...o2:feature',
      'search/issues?q=repo:o/r+is:open',
    ]) {
      const parsed = parseRestEndpoint(endpoint)
      assert.deepEqual(parsed, { ok: true, value: endpoint })
    }
    assert.deepEqual(parseRestEndpoint('/user'), { ok: true, value: 'user' })
  })

  it('rejects URLs, hosts, options, traversal and control characters', () => {
    for (const endpoint of [
      'https://api.github.com/user',
      'http://evil.example/x',
      '//evil.example/x',
      'api.github.com:443/user',
      '-XPOST',
      '--method=POST',
      'repos/o/r/../../user',
      'repos/o/r/%2e%2e/x',
      'repos/o/r/./x',
      'repos/o/r\n-XPOST',
      'repos/o/r\u0000',
      'repos/o r',
      'repos//o',
      'repos\\o',
      'repos/o#frag',
      'graphql',
      '',
    ]) {
      assert.equal(parseRestEndpoint(endpoint).ok, false, JSON.stringify(endpoint))
    }
  })
})

describe('validateJq', () => {
  it('accepts ordinary filters, including fields named env', () => {
    for (const jq of ['.[] | .name', '.env', '.payload.include', 'map(select(.draft))\n| length'])
      assert.equal(validateJq(jq).ok, true, jq)
  })

  it('refuses environment access and module imports', () => {
    for (const jq of [
      'env',
      'env.GH_TOKEN',
      '$ENV.GH_TOKEN',
      '"\\(env)"',
      '{env}',
      'import "x" as y; .',
    ])
      assert.equal(validateJq(jq).ok, false, jq)
  })
})

describe('parseGraphqlQuery', () => {
  it('accepts one query with fragments, anonymous or named', () => {
    assert.equal(parseGraphqlQuery('{ viewer { login } }').ok, true)
    const named = parseGraphqlQuery(
      'query Q($endCursor: String) { viewer { ...F } } fragment F on User { login }',
    )
    assert.equal(named.ok && named.value.declaresEndCursor, true)
  })

  it('rejects mutations, subscriptions, several operations and bad documents', () => {
    for (const query of [
      'mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
      'mutation Named { addStar(input: {starrableId: "x"}) { clientMutationId } }',
      'mutation Aliased { innocent: addStar(input: {starrableId: "x"}) { clientMutationId } }',
      'subscription { x }',
      'query A { viewer { login } } query B { viewer { id } }',
      '{ viewer { login } } mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
      'type Query { x: Int }',
      '{ viewer { login }',
      '',
      'fragment F on User { login }',
    ]) {
      assert.equal(parseGraphqlQuery(query).ok, false, query)
    }
  })
})

describe('parseGhApiReadArgs', () => {
  it('needs exactly one of endpoint and graphql', () => {
    assert.match(refused({}), /exactly one/)
    assert.match(refused({ endpoint: 'user', graphql: '{ viewer { login } }' }), /exactly one/)
  })

  it('keeps variables to GraphQL and requires $endCursor for GraphQL pagination', () => {
    assert.match(refused({ endpoint: 'user', variables: { a: 1 } }), /graphql only/)
    assert.match(refused({ graphql: '{ viewer { login } }', paginate: true }), /endCursor/)
  })

  it('has no way to choose a method, header, host or flag', () => {
    // Unknown keys never reach the request; only the validated fields do.
    const parsed = input({ endpoint: 'user' })
    assert.deepEqual(Object.keys(parsed).sort(), ['endpoint', 'jq', 'kind', 'paginate'])
  })
})

describe('runGhApiRead', () => {
  it('runs a REST GET with jq through a Copse-built argv', async () => {
    const gh = recordingGh(() => ({ stdout: included('["main"]') }))
    const text = await runGhApiRead(
      input({ endpoint: 'repos/o/r/branches', jq: '[.[].name]' }),
      gh.run,
    )
    assert.equal(text, '["main"]')
    assert.deepEqual(gh.calls[0]?.args, [
      'api',
      '--method',
      'GET',
      '--include',
      '--jq=[.[].name]',
      '--',
      'repos/o/r/branches',
    ])
  })

  it('sends a GraphQL query and variables as the request body, not as flags', async () => {
    const gh = recordingGh(() => ({ stdout: '{"data":{"repository":{"name":"r"}}}' }))
    const query = 'query($o: String!, $n: String!) { repository(owner: $o, name: $n) { name } }'
    const text = await runGhApiRead(
      input({ graphql: query, variables: { o: '-F', n: 'r' } }),
      gh.run,
    )
    assert.equal(text, '{"data":{"repository":{"name":"r"}}}')
    assert.deepEqual(gh.calls[0]?.args, ['api', 'graphql', '--input', '-'])
    assert.deepEqual(sentBody(gh.calls, 0), {
      query,
      variables: { o: '-F', n: 'r' },
    })
  })

  it('truncates at the cap on a UTF-8 boundary with a notice', async () => {
    const body = 'é'.repeat(GH_API_READ_MAX_OUTPUT_BYTES)
    const gh = recordingGh(() => ({ stdout: included(body) }))
    const text = await runGhApiRead(input({ endpoint: 'user' }), gh.run)
    const [kept = ''] = text.split('\n\n[gh_api_read: output truncated')
    assert.ok(Buffer.byteLength(kept, 'utf8') <= GH_API_READ_MAX_OUTPUT_BYTES)
    assert.ok(!kept.includes('�'))
    assert.match(text, /output truncated at 256 KiB\. Narrow the result with jq/)
  })

  it('follows REST Link headers and stops after the page limit', async () => {
    const gh = recordingGh((_call, index) => ({
      stdout: included(`[${String(index + 1)}]`, [
        `Link: <https://api.github.com/repositories/1/pulls?page=${String(index + 2)}>; rel="next", <https://api.github.com/repositories/1/pulls?page=99>; rel="last"`,
      ]),
    }))
    const text = await runGhApiRead(input({ endpoint: 'repos/o/r/pulls', paginate: true }), gh.run)
    assert.equal(gh.calls.length, GH_API_READ_MAX_PAGES)
    assert.equal(gh.calls[1]?.args.at(-1), 'repositories/1/pulls?page=2')
    assert.match(text, /^\[1\]\n\[2\]/)
    assert.match(text, /stopped after 10 pages; more exist.*repositories\/1\/pulls\?page=11/)
  })

  it('follows GraphQL pageInfo through $endCursor', async () => {
    const gh = recordingGh((_call, index) => ({
      stdout: JSON.stringify({
        copsePageInfo: { hasNextPage: index === 0, endCursor: `c${String(index)}` },
        copseOutput: [`page ${String(index)}`],
      }),
    }))
    const text = await runGhApiRead(
      input({
        graphql:
          'query($endCursor: String) { viewer { repositories(first: 1, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { name } } } }',
        jq: '.data.viewer.repositories.nodes[].name',
        paginate: true,
      }),
      gh.run,
    )
    assert.equal(text, 'page 0\npage 1')
    assert.equal(gh.calls.length, 2)
    assert.deepEqual(
      z.object({ variables: z.object({ endCursor: z.string() }) }).parse(sentBody(gh.calls, 1)),
      { variables: { endCursor: 'c0' } },
    )
    assert.match(gh.calls[0]?.args.at(-1) ?? '', /^--jq=.*\n\.data\.viewer\.repositories/s)
  })

  it('reports a failure with gh stderr and the response body', async () => {
    const gh = recordingGh(() => ({ stdout: included('{"message":"Not Found"}'), code: 1 }))
    const text = await runGhApiRead(input({ endpoint: 'repos/o/missing' }), gh.run)
    assert.match(text, /^gh_api_read failed: gh: HTTP 404\n\{"message":"Not Found"\}/)
  })
})

describe('nextRestEndpoint', () => {
  it('keeps only the path of the next link, dropping the host', () => {
    assert.equal(
      nextRestEndpoint(['Link: <https://evil.example/api/v3/repos/o/r/pulls?page=2>; rel="next"']),
      'repos/o/r/pulls?page=2',
    )
    assert.equal(nextRestEndpoint(['link: <https://api.github.com/x?page=9>; rel="last"']), null)
  })
})

describe('truncateUtf8', () => {
  it('never splits a multi-byte character', () => {
    assert.equal(truncateUtf8('aé', 2), 'a')
    assert.equal(truncateUtf8('aé', 3), 'aé')
    assert.equal(truncateUtf8('😀', 3), '')
  })
})

describe('gh_api_read tool arguments', () => {
  it('has no method, header, hostname or flag field', async () => {
    const { ghApiReadTool } = await import('../../tools/gh-tools.ts')
    for (const extra of [
      { method: 'POST' },
      { method: 'GET' },
      { headers: { Accept: 'x' } },
      { hostname: 'evil.example' },
      { flags: ['-XPOST'] },
      { field: 'a=b' },
    ]) {
      assert.equal(
        ghApiReadTool.parameters.safeParse({ endpoint: 'user', ...extra }).success,
        false,
        JSON.stringify(extra),
      )
    }
    assert.equal(ghApiReadTool.parameters.safeParse({ endpoint: 'user' }).success, true)
  })
})
