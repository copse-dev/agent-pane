// Tiny deterministic timeline runtime: every frame is a pure function of t (seconds),
// so the same scene can autoplay in a browser and be captured frame-by-frame for video.
;(() => {
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
  const seg = (t, a, b) => clamp((t - a) / (b - a))
  const lerp = (a, b, k) => a + (b - a) * k
  const E = {
    lin: (x) => x,
    out: (x) => 1 - Math.pow(1 - x, 3),
    inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
    back: (x) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2),
    in: (x) => x * x * x,
  }
  function start({ duration, beats, render }) {
    const params = new URLSearchParams(location.search)
    const beatEls = [...document.querySelectorAll('.beat')]
    const textEl = document.querySelector('.text')
    const barEl = document.querySelector('.bar')
    let lastBeat = -1
    const seek = (t) => {
      t = clamp(t, 0, duration)
      let b = 0
      beats.forEach((beat, i) => {
        if (t >= beat.at) b = i
      })
      if (b !== lastBeat) {
        lastBeat = b
        beatEls.forEach((el, i) => el.classList.toggle('on', i === b))
        textEl.textContent = beats[b].text
      }
      barEl.style.width = (t / duration) * 100 + '%'
      render(t)
    }
    window.__seek = seek
    window.__duration = duration
    if (params.has('t')) return seek(parseFloat(params.get('t')))
    const hold = 1.2
    const t0 = window.performance.now()
    const tick = (now) => {
      const el = (now - t0) / 1000
      seek(params.get('loop') === '0' ? el : el % (duration + hold))
      window.requestAnimationFrame(tick)
    }
    window.requestAnimationFrame(tick)
  }
  window.Timeline = { clamp, seg, lerp, E, start }
})()
