/**
 * Is this GraphQL request a read? A lexer-level check, deliberately without a
 * GraphQL dependency, shared by every place Copse forwards a GitHub GraphQL
 * request on someone else's behalf (the container's GitHub read capability,
 * `container-runtime/github-capability.ts`, today).
 *
 * A request is a read when its JSON body is one object whose `query` is a
 * document with exactly one operation, that operation is a `query` (or the
 * anonymous `{ … }` shorthand, which is one), and every other definition is a
 * fragment. Everything else is refused: a mutation or subscription, a second
 * operation beside the query (`operationName` would pick between them, and a
 * check that looked only at the first could be walked past), a batched array,
 * a persisted-query id with no document, a schema definition, and anything
 * that does not lex.
 *
 * The lexer follows the GraphQL spec's lexical grammar closely enough to find
 * definition boundaries: strings, block strings and comments are skipped as
 * whole tokens, so `mutation` inside `"…"`, `"""…"""` or after `#` is text and
 * not a keyword, and braces inside them do not count.
 */

import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

/** The fields this check reads; any others (`variables`, `operationName`) pass through unread. */
const graphqlRequestSchema = z.object({ query: z.string() })

export type GraphqlOperationKind = 'query' | 'mutation' | 'subscription'

interface Token {
  kind: 'punct' | 'name' | 'number' | 'string'
  value: string
}

/** Longest document accepted; GitHub's own limit is far below this. */
export const GRAPHQL_QUERY_LIMIT = 256 * 1024

const PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}'])

function isNameStart(char: string): boolean {
  return /^[A-Za-z_]$/.test(char)
}

function isNameContinue(char: string): boolean {
  return /^[A-Za-z0-9_]$/.test(char)
}

/** The document's significant tokens, or a reason it does not lex. */
export function lexGraphql(source: string): Token[] | string {
  const tokens: Token[] = []
  let index = 0
  const length = source.length
  while (index < length) {
    const char = source.charAt(index)
    // Ignored: BOM, whitespace, line terminators, commas.
    if (char === '﻿' || char === ' ' || char === '\t' || char === ',') {
      index += 1
      continue
    }
    if (char === '\n' || char === '\r') {
      index += 1
      continue
    }
    if (char === '#') {
      while (index < length && source.charAt(index) !== '\n' && source.charAt(index) !== '\r') {
        index += 1
      }
      continue
    }
    if (char === '.') {
      if (source.startsWith('...', index)) {
        tokens.push({ kind: 'punct', value: '...' })
        index += 3
        continue
      }
      return `unexpected "." at ${String(index)}`
    }
    if (PUNCTUATORS.has(char)) {
      tokens.push({ kind: 'punct', value: char })
      index += 1
      continue
    }
    if (isNameStart(char)) {
      const start = index
      while (index < length && isNameContinue(source.charAt(index))) index += 1
      tokens.push({ kind: 'name', value: source.slice(start, index) })
      continue
    }
    if (char === '-' || /^[0-9]$/.test(char)) {
      const start = index
      index += 1
      while (index < length && /^[0-9eE+\-.]$/.test(source.charAt(index))) index += 1
      tokens.push({ kind: 'number', value: source.slice(start, index) })
      continue
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        // Block string: ends at the first `"""` not escaped as `\"""`.
        index += 3
        for (;;) {
          if (index >= length) return 'unterminated block string'
          if (source.startsWith('\\"""', index)) {
            index += 4
            continue
          }
          if (source.startsWith('"""', index)) {
            index += 3
            break
          }
          index += 1
        }
        tokens.push({ kind: 'string', value: '' })
        continue
      }
      index += 1
      for (;;) {
        if (index >= length) return 'unterminated string'
        const inner = source.charAt(index)
        if (inner === '\n' || inner === '\r') return 'line break in a string'
        if (inner === '\\') {
          index += 2
          continue
        }
        index += 1
        if (inner === '"') break
      }
      tokens.push({ kind: 'string', value: '' })
      continue
    }
    return `unexpected character at ${String(index)}`
  }
  return tokens
}

export interface GraphqlDocumentSummary {
  operations: Array<{ kind: GraphqlOperationKind; name: string | null }>
  fragments: number
}

/**
 * The document's top-level definitions, found by walking tokens and skipping
 * each definition's bracketed body as a balanced unit. Returns a reason when
 * the document is not an executable document this check understands.
 */
export function summariseGraphqlDocument(source: string): GraphqlDocumentSummary | string {
  if (source.length > GRAPHQL_QUERY_LIMIT) return 'the query is too long'
  const lexed = lexGraphql(source)
  if (typeof lexed === 'string') return lexed
  const tokens = lexed
  const summary: GraphqlDocumentSummary = { operations: [], fragments: 0 }
  let index = 0

  /** Skip a balanced `{ … }` starting at `index`; false when unbalanced. */
  const skipSelectionSet = (): boolean => {
    if (tokens[index]?.value !== '{' || tokens[index]?.kind !== 'punct') return false
    const stack: string[] = []
    while (index < tokens.length) {
      const token = tokens[index]
      index += 1
      if (token === undefined || token.kind !== 'punct') continue
      if (token.value === '{' || token.value === '(' || token.value === '[') {
        stack.push(token.value)
      } else if (token.value === '}' || token.value === ')' || token.value === ']') {
        const open = stack.pop()
        const expected = token.value === '}' ? '{' : token.value === ')' ? '(' : '['
        if (open !== expected) return false
        if (stack.length === 0) return true
      }
    }
    return false
  }

  /**
   * Skip a definition's header (name, variables, type condition, directives)
   * up to its selection set: the first `{` outside parentheses and brackets,
   * since a variable's default can itself be an object literal.
   */
  const skipHeader = (): boolean => {
    let depth = 0
    while (index < tokens.length) {
      const token = tokens[index]
      if (token === undefined) return false
      if (token.kind === 'punct') {
        if (token.value === '(' || token.value === '[') depth += 1
        else if (token.value === ')' || token.value === ']') {
          depth -= 1
          if (depth < 0) return false
        } else if (token.value === '{') {
          if (depth === 0) return true
          depth += 1
        } else if (token.value === '}') {
          depth -= 1
          if (depth < 0) return false
        }
      }
      index += 1
    }
    return false
  }

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === undefined) break
    if (token.kind === 'punct' && token.value === '{') {
      summary.operations.push({ kind: 'query', name: null })
      if (!skipSelectionSet()) return 'unbalanced selection set'
      continue
    }
    if (token.kind !== 'name') return `unexpected token at the top level`
    if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
      const next = tokens[index + 1]
      const name = next?.kind === 'name' ? next.value : null
      summary.operations.push({ kind: token.value, name })
      index += 1
      if (!skipHeader()) return `the ${token.value} has no selection set`
      if (!skipSelectionSet()) return 'unbalanced selection set'
      continue
    }
    if (token.value === 'fragment') {
      summary.fragments += 1
      index += 1
      if (!skipHeader()) return 'the fragment has no selection set'
      if (!skipSelectionSet()) return 'unbalanced selection set'
      continue
    }
    return `"${token.value.slice(0, 40)}" definitions are not allowed`
  }
  if (summary.operations.length === 0) return 'the document has no operation'
  return summary
}

/** Why a GraphQL document is not a single read-only query, or null when it is one. */
export function graphqlQueryRefusal(source: string): string | null {
  const summary = summariseGraphqlDocument(source)
  if (typeof summary === 'string') return `the GraphQL document could not be checked (${summary})`
  if (summary.operations.length !== 1) {
    return `the GraphQL document has ${String(summary.operations.length)} operations; only a single query is allowed`
  }
  const operation = summary.operations[0]
  if (operation === undefined || operation.kind !== 'query') {
    return `GraphQL ${operation?.kind ?? 'operation'}s are writes or streams, not reads`
  }
  return null
}

/**
 * Why a GraphQL HTTP request body is not a single read-only query, or null
 * when it is one. The body is the raw bytes the client sent.
 */
export function graphqlRequestBodyRefusal(body: string): string | null {
  const parsed = safeJsonParse(body)
  if (parsed === null) return 'the GraphQL request body is not a JSON object'
  if (Array.isArray(parsed)) return 'batched GraphQL requests are not allowed'
  const request = decodeWithSchema(graphqlRequestSchema)(parsed)
  if (request === null || request.query.trim().length === 0) {
    return 'the GraphQL request has no query document (persisted queries are not allowed)'
  }
  return graphqlQueryRefusal(request.query)
}
