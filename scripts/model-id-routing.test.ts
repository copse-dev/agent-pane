import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/**
 * Keeps model-id prefix routing inside the capability modules.
 *
 * Routing used to be decided by `model.startsWith('gpt')` copied into a dozen
 * files, each answering a slightly different question. A new gpt-named model then
 * silently took whichever path the nearest copy implied. `modelCapabilities` /
 * `firstPartyProviderOf` (`packages/llm/src/model-capabilities.ts`, data in
 * `model-families.ts`) are the one lookup; this test fails when a literal
 * `startsWith('gpt…')` / `includes('claude…')` / `/^gpt…/` reappears anywhere else
 * in shipped source.
 *
 * If you hit it: call `modelCapabilities(selection)` (or `firstPartyProviderOf`) —
 * and if the answer you need is not in the record, add the field and its per-family
 * data to `model-families.ts` rather than matching the id yourself.
 *
 * ## Exceptions
 *
 * Only for code that classifies a *name* rather than deciding how to route a model
 * request. Every entry needs a reason, and the list should not grow for routing.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'packages/llm/src/model-families.ts': 'the capability table itself',
  'packages/llm/src/model-maker-block.ts':
    'maps vendor and agent names to a maker for the user-maintained block list; not a request route',
  'packages/llm/src/model-label.ts': 'display-name formatting, not routing',
}

/** A literal model-family prefix in a string-matching call or a regex literal. */
const FAMILY = String.raw`(?:gpt|claude|o[1-9])`
const PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\.(?:startsWith|includes)\(\s*['"\`]${FAMILY}(?![a-z0-9])`),
  new RegExp(String.raw`/\^\(?${FAMILY}(?![a-z0-9])`),
]

const SHIPPED_ROOTS = ['packages/', 'src/', 'scripts/']

function isShippedSource(file: string): boolean {
  if (!/\.(?:ts|mts|tsx)$/.test(file)) return false
  if (!SHIPPED_ROOTS.some((root) => file.startsWith(root))) return false
  if (/\.(?:test|e2e|generated|d)\.(?:ts|mts|tsx)$/.test(file)) return false
  return !file.includes('/fixtures/') && !file.includes('/test-utils/')
}

function isComment(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/** Lines in `source` that match a routing pattern, outside comments. */
function routingMatches(source: string): string[] {
  return source
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !isComment(line) && PATTERNS.some((pattern) => pattern.test(line)))
    .map(({ line, number }) => `${String(number)}: ${line.trim()}`)
}

describe('model-id routing', () => {
  it('recognises the patterns it guards against', () => {
    for (const line of [
      "if (model.startsWith('gpt')) return 'openai'",
      'if (m.startsWith("gpt-")) {',
      "id.startsWith('claude-opus-5')",
      "configured.startsWith('gpt-') ||",
      "return model.includes('gpt-5')",
      'const GPT = /^gpt-5/',
      "model.startsWith('o1') || model.startsWith('o3')",
    ]) {
      assert.equal(routingMatches(line).length, 1, line)
    }
  })

  it('ignores comments and unrelated prefixes', () => {
    for (const line of [
      "// model.startsWith('gpt') used to live here",
      " * `startsWith('gpt-')` routing",
      "value.startsWith('gptq-')",
      "value.startsWith('openrouter:')",
      "name.startsWith('glm-')",
      "anthropic.startsWith('anthropic/claude-')",
      "id.startsWith('o10x')",
    ]) {
      assert.deepEqual(routingMatches(line), [], line)
    }
  })

  it('finds no prefix routing outside the capability modules', () => {
    const tracked = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .split('\0')
      .filter((file) => isShippedSource(file) && existsSync(file))
    assert.ok(tracked.length > 500, 'expected to scan the whole tree')
    const offenders: string[] = []
    for (const file of tracked) {
      if (Object.hasOwn(ALLOWED, file)) continue
      for (const match of routingMatches(readFileSync(file, 'utf8'))) {
        offenders.push(`${file}:${match}`)
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Model-id prefix routing belongs in packages/llm/src/model-families.ts. Call ' +
        'modelCapabilities(selection) or firstPartyProviderOf(selection) instead — see ' +
        'scripts/model-id-routing.test.ts.',
    )
  })

  it('keeps every exception pointing at a file that still exists', () => {
    const tracked = new Set(
      execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
        encoding: 'utf8',
      }).split('\0'),
    )
    for (const file of Object.keys(ALLOWED)) {
      assert.ok(tracked.has(file), `${file} is allow-listed but no longer tracked`)
    }
  })
})
