import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isStoredToolImageUrl,
  parseStoredToolImageUrl,
  storedToolImageUrl,
} from './stored-tool-image.ts'

const address = {
  projectId: 'proj-1',
  threadId: 'e2c8c894-8195-4db5-9fcf-53aa14474054',
  ref: 'blobs/0b57604d.tool-4-img-0.dataurl',
  sha256: 'a'.repeat(64),
}

describe('stored tool image references', () => {
  it('round-trips an address, including the slash in its ref', () => {
    const url = storedToolImageUrl(address)
    assert.equal(isStoredToolImageUrl(url), true)
    assert.deepEqual(parseStoredToolImageUrl(url), address)
  })

  it('is never mistaken for an image the field already holds', () => {
    assert.equal(isStoredToolImageUrl('data:image/png;base64,AAAA'), false)
    assert.equal(parseStoredToolImageUrl('data:image/png;base64,AAAA'), null)
  })

  it('rejects malformed references', () => {
    const url = storedToolImageUrl(address)
    assert.equal(parseStoredToolImageUrl(`${url}/extra`), null)
    assert.equal(parseStoredToolImageUrl('copse-stored-image:a/b/c'), null)
    assert.equal(parseStoredToolImageUrl('copse-stored-image:a/b/c/not-a-hash'), null)
    assert.equal(parseStoredToolImageUrl('copse-stored-image:%E0%A4%A/b/c/' + 'a'.repeat(64)), null)
    assert.equal(parseStoredToolImageUrl('copse-stored-image://b/c/' + 'a'.repeat(64)), null)
  })
})
