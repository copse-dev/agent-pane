import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PRODUCT_ANNOUNCEMENTS } from './product-announcements.ts'

test('the shipped catalog has unique, non-empty entries', () => {
  const ids = PRODUCT_ANNOUNCEMENTS.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const entry of PRODUCT_ANNOUNCEMENTS) {
    assert.ok(entry.id && entry.title && entry.message)
  }
})

test('announces the concise threads default with a link to Appearance', () => {
  const entry = PRODUCT_ANNOUNCEMENTS.find((item) => item.id === 'concise-threads-default-v1')
  assert.equal(entry?.settingsAction?.section, 'appearance')
  assert.match(entry.detail ?? '', /Show steps/)
})
