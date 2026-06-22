import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { imageMimeType, isImagePath } from './image-path.ts'

describe('image-path', () => {
  it('detects common raster image extensions', () => {
    assert.equal(imageMimeType('assets/logo.png'), 'image/png')
    assert.equal(imageMimeType('photo.JPG'), 'image/jpeg')
    assert.equal(imageMimeType('icon.webp'), 'image/webp')
    assert.equal(isImagePath('dir/shot.avif'), true)
  })

  it('detects svg and ico', () => {
    assert.equal(imageMimeType('diagram.svg'), 'image/svg+xml')
    assert.equal(imageMimeType('favicon.ico'), 'image/x-icon')
  })

  it('returns null for non-image paths', () => {
    assert.equal(imageMimeType('src/index.ts'), null)
    assert.equal(isImagePath('README.md'), false)
  })
})
