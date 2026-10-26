import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  imageMimeType,
  isImagePath,
  isRasterImagePath,
  isUnrenderableImageMime,
  isUnrenderableImagePath,
} from './image-path.ts'

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

  it('distinguishes byte-oriented raster images from textual SVG images', () => {
    assert.equal(isRasterImagePath('shot.png'), true)
    assert.equal(isRasterImagePath('photo.avif'), true)
    assert.equal(isRasterImagePath('icon.svg'), false)
    assert.equal(isRasterImagePath('README.md'), false)
  })

  it('only maps real image extensions', () => {
    const cases: Array<[string, string | null]> = [
      ['notes.constructor', null],
      ['notes.toString', null],
      ['a.__proto__', null],
      ['png', null],
      ['dir/png', null],
      ['dir.png/README', null],
      ['.png', 'image/png'],
      ['C:\\shots\\a.PNG', 'image/png'],
    ]
    for (const [path, expected] of cases) assert.equal(imageMimeType(path), expected, path)
  })

  it('flags HEIC/HEIF/TIFF as unrenderable by the browser <img> element', () => {
    assert.equal(isUnrenderableImageMime('image/heic'), true)
    assert.equal(isUnrenderableImageMime('image/heic-sequence'), true)
    assert.equal(isUnrenderableImageMime('image/heif'), true)
    assert.equal(isUnrenderableImageMime('image/tiff'), true)
    // Case-insensitive: some clipboard sources report the MIME type in mixed case.
    assert.equal(isUnrenderableImageMime('image/HEIC'), true)
  })

  it('does not flag formats the browser can render', () => {
    assert.equal(isUnrenderableImageMime('image/png'), false)
    assert.equal(isUnrenderableImageMime('image/jpeg'), false)
    assert.equal(isUnrenderableImageMime('image/webp'), false)
    assert.equal(isUnrenderableImageMime('image/gif'), false)
  })

  it('flags the same formats by extension, for files with no MIME type', () => {
    for (const path of ['IMG_0412.HEIC', 'photo.heif', 'scans/page.tif', 'C:\\scans\\page.TIFF'])
      assert.equal(isUnrenderableImagePath(path), true, path)
    for (const path of ['chart.png', 'photo.jpeg', 'heic', 'notes.heic.txt'])
      assert.equal(isUnrenderableImagePath(path), false, path)
  })
})
