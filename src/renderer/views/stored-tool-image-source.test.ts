import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { storedToolImageUrl } from '@shared/threads/stored-tool-image.ts'
import { setTranscriptImageSource } from './stored-tool-image-source.ts'

const IMAGE = 'data:image/png;base64,iVBORw0KGgo='

function reference(name: string): string {
  return storedToolImageUrl({
    projectId: 'p1',
    threadId: 't1',
    ref: `blobs/${name}.dataurl`,
    sha256: 'b'.repeat(64),
  })
}

/** Stands in for the viewport: the test says when an image comes near it. */
const watched: Element[] = []
let deliver: ((entries: IntersectionObserverEntry[]) => void) | undefined
class FakeObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0]
  constructor(callback: IntersectionObserverCallback) {
    deliver = (entries): void => {
      callback(entries, this)
    }
  }
  observe(target: Element): void {
    watched.push(target)
  }
  unobserve(target: Element): void {
    watched.splice(watched.indexOf(target), 1)
  }
  disconnect(): void {
    watched.length = 0
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
Object.defineProperty(globalThis, 'IntersectionObserver', { value: FakeObserver, writable: true })

class NearViewport implements IntersectionObserverEntry {
  readonly boundingClientRect: DOMRectReadOnly
  readonly intersectionRect: DOMRectReadOnly
  readonly intersectionRatio = 1
  readonly isIntersecting = true
  readonly rootBounds = null
  readonly time = 0
  readonly target: HTMLImageElement
  constructor(target: HTMLImageElement) {
    this.target = target
    this.boundingClientRect = target.getBoundingClientRect()
    this.intersectionRect = this.boundingClientRect
  }
}

function scrollNear(img: HTMLImageElement): void {
  deliver?.([new NearViewport(img)])
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('transcript image sources', () => {
  it('sets an inline image directly', () => {
    const img = document.createElement('img')
    setTranscriptImageSource(img, IMAGE, () => Promise.reject(new Error('not read')))
    assert.equal(img.getAttribute('src'), IMAGE)
    assert.equal(img.dataset['storedImageState'], undefined)
  })

  it('reads a stored image only once it comes near the viewport', async () => {
    const reads: string[] = []
    const img = document.createElement('img')
    const url = reference('a1.tool-0-img-0')
    setTranscriptImageSource(img, url, (requested) => {
      reads.push(requested)
      return Promise.resolve(IMAGE)
    })
    assert.equal(img.getAttribute('src'), null)
    assert.equal(img.dataset['storedImageState'], 'pending')
    await settle()
    assert.deepEqual(reads, [], 'nothing is read while the image is off screen')
    scrollNear(img)
    assert.equal(img.dataset['storedImageState'], 'loading')
    await settle()
    assert.deepEqual(reads, [url])
    assert.equal(img.getAttribute('src'), IMAGE)
    assert.equal(img.dataset['storedImageState'], 'loaded')
    assert.equal(watched.includes(img), false)
  })

  it('marks an image that is gone from the store unavailable', async () => {
    const img = document.createElement('img')
    setTranscriptImageSource(img, reference('gone'), () => Promise.resolve(null))
    scrollNear(img)
    await settle()
    assert.equal(img.dataset['storedImageState'], 'unavailable')
    assert.ok(img.classList.contains('stored-image-unavailable'))
    assert.match(img.alt, /unavailable/)
    assert.equal(img.getAttribute('src'), null)
  })

  it('ignores a late read for an element since pointed at another image', async () => {
    let finish: (value: string | null) => void = () => undefined
    const img = document.createElement('img')
    setTranscriptImageSource(
      img,
      reference('first'),
      () => new Promise<string | null>((resolve) => (finish = resolve)),
    )
    scrollNear(img)
    setTranscriptImageSource(img, reference('second'), () => Promise.resolve(IMAGE))
    finish('data:image/png;base64,c3RhbGU=')
    await settle()
    assert.equal(img.getAttribute('src'), null)
    assert.equal(img.dataset['storedImageState'], 'pending')
  })
})
