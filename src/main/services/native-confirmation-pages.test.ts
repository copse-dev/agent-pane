import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  NATIVE_CONFIRMATION_MAX_CHARS,
  NATIVE_CONFIRMATION_PAGE_CHARS,
  nativeConfirmationPages,
} from './native-confirmation-pages.ts'

describe('native confirmation pages', () => {
  it('shows every character of long prompts without dropping or changing text', () => {
    const detail = `Action: ${'a'.repeat(NATIVE_CONFIRMATION_PAGE_CHARS - 10)}😀${'z'.repeat(22_000)}`
    const pages = nativeConfirmationPages(detail)
    assert.equal(pages.join(''), detail)
    assert.ok(pages.every((page) => page.length <= NATIVE_CONFIRMATION_PAGE_CHARS))
    assert.ok(pages.length > 1)
    assert.ok(pages.every((page) => !page.endsWith('\ud83d')))
  })

  it('rejects content too long to inspect', () => {
    assert.throws(
      () => nativeConfirmationPages('x'.repeat(NATIVE_CONFIRMATION_MAX_CHARS + 1)),
      /too large/,
    )
  })
})
