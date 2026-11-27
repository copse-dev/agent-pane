import { isStoredToolImageUrl } from '@shared/threads/stored-tool-image.ts'

/**
 * Give a transcript image its source. A `copse-stored-image:` reference (see
 * `@shared/threads/stored-tool-image.ts`) is read from main only when the image
 * comes within a screen or two of the viewport, so a thread of a hundred
 * generated images keeps none of them in the window until they are scrolled to.
 *
 * The element carries `data-stored-image-state`: `pending` until it is near the
 * viewport, then `loading`, then `loaded` or `unavailable`.
 */

type StoredImageReader = (url: string) => Promise<string | null>

const STATE = 'storedImageState'
const URL_KEY = 'storedImageUrl'
const UNAVAILABLE_ALT = 'Image unavailable: it is no longer in this thread’s store.'

let observer: IntersectionObserver | null = null
/** The images waiting for the viewport, by the element the observer reports. */
const waiting = new WeakMap<Element, { img: HTMLImageElement; read: StoredImageReader }>()

const readFromMain: StoredImageReader = (url) => window.api.threads.storedToolImage(url)

function markUnavailable(img: HTMLImageElement): void {
  img.dataset[STATE] = 'unavailable'
  img.classList.add('stored-image-unavailable')
  img.alt = UNAVAILABLE_ALT
}

function load(target: Element): void {
  const entry = waiting.get(target)
  if (entry === undefined) return
  waiting.delete(target)
  const { img, read } = entry
  const url = img.dataset[URL_KEY]
  if (url === undefined || img.dataset[STATE] !== 'pending') return
  img.dataset[STATE] = 'loading'
  read(url).then(
    (dataUrl) => {
      // A rebuilt card may have pointed this element at another image meanwhile.
      if (img.dataset[URL_KEY] !== url) return
      if (dataUrl === null) {
        markUnavailable(img)
        return
      }
      img.src = dataUrl
      img.dataset[STATE] = 'loaded'
    },
    () => {
      if (img.dataset[URL_KEY] === url) markUnavailable(img)
    },
  )
}

function nearViewport(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        observer?.unobserve(entry.target)
        load(entry.target)
      }
    },
    { rootMargin: '1500px 0px' },
  )
  return observer
}

/** Set `img`'s source to `src`, deferring a stored-image reference until it is near view. */
export function setTranscriptImageSource(
  img: HTMLImageElement,
  src: string,
  read: StoredImageReader = readFromMain,
): void {
  if (!isStoredToolImageUrl(src)) {
    img.src = src
    return
  }
  img.dataset[URL_KEY] = src
  img.dataset[STATE] = 'pending'
  waiting.set(img, { img, read })
  const watcher = nearViewport()
  if (watcher) watcher.observe(img)
  else load(img)
}
