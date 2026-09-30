import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { announcementHistorySchema, parseAnnouncementHistory } from './product-announcements.ts'
import { getSettingSchema } from '../main/services/storage/settings-schema.ts'
import { parseRendererWritableSetting } from '../main/services/storage/settings-writable.ts'

describe('announcement history', () => {
  it('round trips through the renderer write and registered read schemas', () => {
    const history = ['compact-v1', 'new-default-v2']
    const written = parseRendererWritableSetting('acknowledgedProductAnnouncements', history)
    const schema = getSettingSchema('acknowledgedProductAnnouncements')
    assert.ok(schema)
    assert.deepEqual(schema.parse(written), history)
  })
  it('rejects malformed or unbounded history and tolerates absent/corrupt reads', () => {
    for (const value of [null, 'seen', [1], [''], ['x'.repeat(129)], Array(4097).fill('id')]) {
      assert.equal(announcementHistorySchema.safeParse(value).success, false)
      assert.deepEqual(parseAnnouncementHistory(value), [])
    }
    assert.deepEqual(parseAnnouncementHistory(['first', 'first', 'second']), ['first', 'second'])
  })
})
