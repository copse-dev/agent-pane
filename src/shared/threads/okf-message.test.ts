import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { parseOkfMessage, serializeOkfMessage } from './okf-message.ts'

const FIELDS = { type: 'Message', role: 'assistant' as const, id: 'm1', createdAt: 1712345678901 }

function roundTrip(body: string): void {
  const raw = serializeOkfMessage(FIELDS, body)
  const parsed = parseOkfMessage(raw)
  if (!parsed) throw new Error('parse returned null')
  strictEqual(parsed.body, body, `body round-trip mismatch for ${JSON.stringify(body)}`)
}

test('round-trips ordinary prose', () => {
  roundTrip('Hello, world.\n\nA second paragraph.')
})

test('round-trips an empty body', () => {
  roundTrip('')
})

test('round-trips a body that begins with a --- fence', () => {
  roundTrip('---\nnot: frontmatter\n---\nstill body')
})

test('round-trips a body containing YAML-shaped fenced code', () => {
  roundTrip('```yaml\ntype: Message\n---\nrole: fake\n```\ntext after')
})

test('round-trips a body that is only a horizontal rule', () => {
  roundTrip('---')
})

test('round-trips CRLF and leading/trailing blank lines verbatim', () => {
  roundTrip('\r\n\r\nline one\r\nline two\r\n\r\n')
})

test('round-trips astral/emoji characters', () => {
  roundTrip('café 🧵 𝕏 — done')
})

test('preserves frontmatter fields', () => {
  const parsed = parseOkfMessage(serializeOkfMessage(FIELDS, 'body'))
  if (!parsed) throw new Error('parse returned null')
  deepStrictEqual(
    { type: parsed.fields['type'], role: parsed.fields['role'], id: parsed.fields['id'] },
    { type: 'Message', role: 'assistant', id: 'm1' },
  )
  strictEqual(parsed.fields['createdAt'], '1712345678901')
})

test('quotes string values so they never form a bare --- line', () => {
  const raw = serializeOkfMessage({ ...FIELDS, id: '---' }, 'body')
  const parsed = parseOkfMessage(raw)
  if (!parsed) throw new Error('parse returned null')
  strictEqual(parsed.fields['id'], '---')
  strictEqual(parsed.body, 'body')
})

test('returns null when the opening fence is missing', () => {
  strictEqual(parseOkfMessage('no frontmatter here'), null)
})

test('returns null when the frontmatter is unterminated', () => {
  strictEqual(parseOkfMessage('---\ntype: Message\nno close'), null)
})
