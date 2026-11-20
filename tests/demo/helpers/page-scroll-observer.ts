declare global {
  interface Window {
    __pageJumps?: number[]
  }
}

/** Self-contained because WebDriver serializes this callback into the page. */
export function observePageScrollAfterSetup(offset: number): Promise<number> {
  if (Math.round(window.scrollY) === offset) {
    throw new Error('Expected the setup scroll to change the page position')
  }
  return new Promise((resolve, reject) => {
    // Reading scrollY after scrollTo does not drain its queued scroll event.
    // Arm inside that event's callback so it cannot enter the observation ledger.
    window.addEventListener(
      'scroll',
      () => {
        const settled = Math.round(window.scrollY)
        if (settled !== offset) {
          reject(
            new Error(`Setup scroll settled at ${String(settled)}, expected ${String(offset)}`),
          )
          return
        }
        const jumps: number[] = []
        window.__pageJumps = jumps
        window.addEventListener(
          'scroll',
          () => {
            jumps.push(Math.round(window.scrollY))
          },
          { passive: true },
        )
        resolve(settled)
      },
      { once: true, passive: true },
    )
    window.scrollTo(0, offset)
  })
}
