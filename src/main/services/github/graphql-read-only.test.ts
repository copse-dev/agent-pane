import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  graphqlQueryRefusal,
  graphqlRequestBodyRefusal,
  lexGraphql,
  summariseGraphqlDocument,
} from './graphql-read-only.ts'

const body = (query: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ query, ...extra })

describe('graphqlQueryRefusal', () => {
  it('accepts the queries gh sends', () => {
    for (const query of [
      'query { viewer { login } }',
      '{ viewer { login } }',
      'query PullRequestForBranch($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { pullRequests(first: 1) { nodes { number } } } }',
      // Fragments beside the one query are fine, in either order.
      'fragment pr on PullRequest { number title } query Q { viewer { login } }',
      'query Q { node(id: "x") { ...pr ... on Issue { title } } } fragment pr on PullRequest { number }',
      // A variable default that is an object literal, with braces inside parens.
      'query Q($f: Filter = { state: OPEN, labels: ["a", "b"] }) { search(filter: $f) { count } }',
      // Directives with arguments in the header and the selection.
      'query Q @cached(ttl: 5) { viewer @include(if: true) { login } }',
    ]) {
      assert.equal(graphqlQueryRefusal(query), null, query)
    }
  })

  it('refuses mutations and subscriptions', () => {
    assert.match(
      graphqlQueryRefusal('mutation { addComment(input: {}) { clientMutationId } }') ?? '',
      /mutations are writes/,
    )
    assert.match(
      graphqlQueryRefusal('subscription { events { id } }') ?? '',
      /subscriptions are writes or streams/,
    )
  })

  it('refuses a mutation smuggled beside a query', () => {
    for (const query of [
      'query Q { viewer { login } } mutation M { deleteRepository(input: {}) { clientMutationId } }',
      'mutation M { x } query Q { viewer { login } }',
      '{ viewer { login } } mutation { x }',
      // Two queries: operationName would choose, so one is never enough to check.
      'query A { viewer { login } } query B { viewer { id } }',
      '{ a } { b }',
    ]) {
      assert.match(graphqlQueryRefusal(query) ?? '', /operations|writes/, query)
    }
  })

  it('treats keywords inside strings, block strings and comments as text', () => {
    assert.equal(graphqlQueryRefusal('query { search(query: "} mutation { x }") { count } }'), null)
    assert.equal(
      graphqlQueryRefusal('query { search(query: """ } \\""" mutation { x } """) { count } }'),
      null,
    )
    assert.equal(graphqlQueryRefusal('# mutation { x }\nquery { viewer { login } }'), null)
    assert.equal(
      graphqlQueryRefusal('query { search(query: "escaped \\" } mutation { x }") { count } }'),
      null,
    )
    // And the other way round: a comment cannot hide a real mutation.
    assert.notEqual(graphqlQueryRefusal('query { a } # }\nmutation { x }'), null)
    // A string that does not end swallows nothing: it is refused.
    assert.notEqual(graphqlQueryRefusal('query { a(b: "unterminated) }'), null)
    assert.notEqual(graphqlQueryRefusal('query { a(b: """unterminated) }'), null)
  })

  it('refuses documents it cannot check', () => {
    for (const query of [
      '',
      'query { a ',
      'query { a } }',
      'query ( { a }',
      'type Query { a: Int }',
      'schema { query: Query }',
      'extend type Query { b: Int }',
      'query { a } ; mutation { b }',
      'mutation',
      'query',
      '{ a ) }',
    ]) {
      assert.notEqual(graphqlQueryRefusal(query), null, JSON.stringify(query))
    }
  })

  it('summarises operations and fragments', () => {
    assert.deepEqual(summariseGraphqlDocument('query A { a } fragment f on T { b }'), {
      operations: [{ kind: 'query', name: 'A' }],
      fragments: 1,
    })
    assert.equal(typeof lexGraphql('"'), 'string')
  })
})

describe('graphqlRequestBodyRefusal', () => {
  it('accepts a single query with variables', () => {
    assert.equal(
      graphqlRequestBodyRefusal(
        body('query($n: Int!) { viewer { repositories(first: $n) { totalCount } } }', {
          variables: { n: 1 },
        }),
      ),
      null,
    )
  })

  it('refuses batches, persisted queries and bodies that are not one JSON object', () => {
    assert.match(graphqlRequestBodyRefusal(JSON.stringify([{ query: '{ a }' }])) ?? '', /batched/)
    assert.match(
      graphqlRequestBodyRefusal(
        JSON.stringify({ extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } }),
      ) ?? '',
      /persisted/,
    )
    assert.match(graphqlRequestBodyRefusal(JSON.stringify({ query: '' })) ?? '', /no query/)
    assert.match(graphqlRequestBodyRefusal(JSON.stringify({ query: 5 })) ?? '', /no query/)
    assert.match(graphqlRequestBodyRefusal('not json') ?? '', /not a JSON object/)
    assert.match(graphqlRequestBodyRefusal('null') ?? '', /not a JSON object/)
    assert.match(graphqlRequestBodyRefusal('"query { a }"') ?? '', /no query/)
  })

  it('refuses a mutation in the body', () => {
    assert.match(graphqlRequestBodyRefusal(body('mutation { x }')) ?? '', /mutations/)
  })
})
