/**
 * The browser tier sizes the page, not the window.
 *
 * Chrome for Testing's `--headless=new` window keeps its toolbar and shows
 * infobars, so a 1280x800 window leaves a 1280x600 page (#4513). WebDriver's
 * window commands measure the outer window, and the gap depends on the build
 * and its flags. Every demo spec means the page size when it resizes, so
 * `setWindowSize` and `getWindowSize` are redefined here in page terms: a
 * spec's `setWindowSize(1280, 800)` gives a 1280x800 page on any build.
 */

/** A width and height in CSS pixels. */
export interface PageSize {
  width: number
  height: number
}

/** The slice of a WebDriver session this helper patches. */
export interface ViewportSession {
  /** The page's own size: what a spec measures and what a screenshot captures. */
  execute: (script: () => PageSize) => Promise<PageSize>
  /** The window command, as {@link installPageViewport} leaves it: page terms. */
  setWindowSize: (width: number, height: number) => Promise<unknown>
  /**
   * WDIO's supported command override. Assigning through the `@wdio/globals`
   * Proxy would not reach the real browser (see `after-test-safety.ts`).
   */
  overwriteCommand: (
    name: 'setWindowSize' | 'getWindowSize',
    fn: (
      this: unknown,
      origCommand: (...args: unknown[]) => Promise<unknown>,
      ...args: unknown[]
    ) => Promise<unknown>,
  ) => void
}

/** The page size every demo spec starts from. */
export const DEMO_PAGE_SIZE: PageSize = { width: 1280, height: 800 }

/** How many times to re-measure when the window's frame changes under a resize. */
const SETTLE_ATTEMPTS = 3

const viewportPatched = new WeakSet<object>()

function readPageSize(): PageSize {
  return { width: window.innerWidth, height: window.innerHeight }
}

function readFrame(): PageSize {
  return {
    width: window.outerWidth - window.innerWidth,
    height: window.outerHeight - window.innerHeight,
  }
}

/**
 * Make `setWindowSize(width, height)` size the page to `width` x `height` and
 * `getWindowSize()` report the page size, then size the page to
 * {@link DEMO_PAGE_SIZE}. Installed from `wdio.demo.conf.ts`'s `before()`.
 */
export async function installPageViewport(session: ViewportSession): Promise<void> {
  if (viewportPatched.has(session)) return
  viewportPatched.add(session)
  session.overwriteCommand('getWindowSize', async () => await session.execute(readPageSize))
  session.overwriteCommand(
    'setWindowSize',
    async function setPageSize(this: unknown, origSetWindowSize, ...args) {
      const [width, height] = args
      if (typeof width !== 'number' || typeof height !== 'number') {
        return await origSetWindowSize.apply(this, args)
      }
      // An infobar can come or go as the window resizes, which moves the frame,
      // so measure again until the page lands on the size asked for.
      let page: PageSize | undefined
      for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
        const frame = await session.execute(readFrame)
        await origSetWindowSize.apply(this, [width + frame.width, height + frame.height])
        page = await session.execute(readPageSize)
        if (page.width === width && page.height === height) return undefined
      }
      // A spec would otherwise measure or capture at the wrong size, the failure
      // this helper exists to prevent, with nothing saying why.
      throw new Error(
        `setWindowSize(${String(width)}, ${String(height)}) left a ` +
          `${String(page?.width)}x${String(page?.height)} page after ` +
          `${String(SETTLE_ATTEMPTS)} attempts`,
      )
    },
  )
  await session.setWindowSize(DEMO_PAGE_SIZE.width, DEMO_PAGE_SIZE.height)
}
