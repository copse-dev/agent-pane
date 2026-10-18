import { browser } from '@wdio/globals'

declare global {
  interface Window {
    e2eCaptureAnimationObserver?: MutationObserver
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
    const savedAnimations: NonNullable<Window['e2eCaptureAnimations']> = []
    window.e2eCaptureAnimations = savedAnimations
    const freezeNewAnimations = (): void => {
      for (const animation of document.getAnimations()) {
        if (
          animation.effect?.getTiming().iterations !== Infinity ||
          savedAnimations.some((saved) => saved.animation === animation)
        )
          continue
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
        savedAnimations.push(saved)
      }
    }
    // Framing and live store updates can replace indicator nodes after capture
    // starts. Enrol their loops too, preserving every original state to restore.
    window.e2eCaptureAnimationObserver = new MutationObserver(freezeNewAnimations)
    window.e2eCaptureAnimationObserver.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    freezeNewAnimations()
  })
  try {
    await capture()
  } finally {
    await browser.execute(() => {
      window.e2eCaptureAnimationObserver?.disconnect()
      delete window.e2eCaptureAnimationObserver
      for (const { animation, time, playing } of window.e2eCaptureAnimations ?? []) {
        animation.currentTime = time
        if (playing) animation.play()
      }
      delete window.e2eCaptureAnimations
      document.getElementById('e2e-capture-steady-caret')?.remove()
    })
  }
}
