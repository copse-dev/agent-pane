import { browser } from '@wdio/globals'

declare global {
  interface Window {
    e2eCaptureAnimations?: {
      animation: Animation
      time: Animation['currentTime']
      playing: boolean
    }[]
  }
}

/** Pin looping CSS indicators only while capturing; keep motion tests live. */
export async function withFrozenAnimations(capture: () => Promise<void>): Promise<void> {
  await browser.execute(() => {
    if (window.e2eCaptureAnimations) throw new Error('Nested animation capture')
    if (!CSS.supports('caret-animation', 'manual')) {
      throw new Error('Capture browser must support a steady visible caret')
    }
    const caretStyle = document.createElement('style')
    caretStyle.id = 'e2e-capture-steady-caret'
    // Keep the focused caret visible, rather than hiding a real editing affordance.
    caretStyle.textContent = '* { caret-animation: manual !important; }'
    document.head.append(caretStyle)
    window.e2eCaptureAnimations = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations === Infinity)
      .map((animation) => {
        const saved = {
          animation,
          time: animation.currentTime,
          playing: animation.playState === 'running',
        }
        animation.pause()
        const timing = animation.effect?.getTiming()
        // The reasoning spiral is invisible at 0%; its middle frame is fully drawn.
        animation.currentTime =
          (timing?.delay ?? 0) + (typeof timing?.duration === 'number' ? timing.duration / 2 : 0)
        return saved
      })
  })
  try {
    await capture()
  } finally {
    await browser.execute(() => {
      for (const { animation, time, playing } of window.e2eCaptureAnimations ?? []) {
        animation.currentTime = time
        if (playing) animation.play()
      }
      delete window.e2eCaptureAnimations
      document.getElementById('e2e-capture-steady-caret')?.remove()
    })
  }
}
