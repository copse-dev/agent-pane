/* Original drawings run away from the player DOM and can be terminated independently. */
;(function (root) {
  'use strict'
  const sessions = new WeakMap()
  function workerMain(paint) {
    const clamp = (v) => Math.max(0, Math.min(1, v))
    const ease = (v) => {
      v = clamp(v)
      return v * v * (3 - 2 * v)
    }
    self.onmessage = ({ data }) => {
      try {
        const canvas = new OffscreenCanvas(1280, 480)
        const ctx = canvas.getContext('2d')
        const helpers = {
          clamp,
          ease,
          mix: (a, b, p) => a + (b - a) * p,
          text(value, x, y, size = 28, color = '#ffffff', align = 'left') {
            ctx.save()
            ctx.font = `600 ${size}px sans-serif`
            ctx.textAlign = align
            ctx.textBaseline = 'middle'
            ctx.fillStyle = color
            ctx.fillText(String(value), x, y)
            ctx.restore()
          },
          rect(x, y, w, h, color, radius = 0) {
            ctx.save()
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.roundRect(x, y, w, h, radius)
            ctx.fill()
            ctx.restore()
          },
          circle(x, y, r, color) {
            ctx.save()
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(x, y, r, 0, Math.PI * 2)
            ctx.fill()
            ctx.restore()
          },
          line(x1, y1, x2, y2, color, width = 2) {
            ctx.save()
            ctx.strokeStyle = color
            ctx.lineWidth = width
            ctx.beginPath()
            ctx.moveTo(x1, y1)
            ctx.lineTo(x2, y2)
            ctx.stroke()
            ctx.restore()
          },
        }
        paint(ctx, Object.freeze(data.frame), Object.freeze(helpers))
        const bitmap = canvas.transferToImageBitmap()
        self.postMessage({ id: data.id, bitmap }, [bitmap])
      } catch (error) {
        self.postMessage({ id: data.id, error: String(error).slice(0, 500) })
      }
    }
  }
  function session(canvas, story) {
    let value = sessions.get(canvas)
    if (value) return value
    const source = `'use strict';const paint=(ctx,frame,helpers)=>{\n${story.drawing.code}\n};(${workerMain.toString()})(paint);`
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const worker = new Worker(url)
    URL.revokeObjectURL(url)
    value = { worker, pending: null, id: 0, failed: null }
    const fail = (message) => {
      value.failed = new Error(message)
      worker.terminate()
      if (value.pending) {
        clearTimeout(value.pending.timer)
        value.pending.reject(value.failed)
        value.pending = null
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      fail(event.message || 'The drawing could not run.')
    }
    worker.onmessage = ({ data }) => {
      const pending = value.pending
      if (!pending || data?.id !== pending.id) {
        data?.bitmap?.close?.()
        return
      }
      if (typeof data.error === 'string') {
        fail(data.error)
        return
      }
      if (
        !(data.bitmap instanceof ImageBitmap) ||
        data.bitmap.width !== 1280 ||
        data.bitmap.height !== 480
      ) {
        data?.bitmap?.close?.()
        fail('The drawing returned an invalid frame.')
        return
      }
      clearTimeout(pending.timer)
      value.pending = null
      pending.resolve(data.bitmap)
    }
    value.request = (frame) =>
      new Promise((resolve, reject) => {
        if (value.failed) {
          reject(value.failed)
          return
        }
        if (value.pending) {
          reject(new Error('A drawing frame is already pending.'))
          return
        }
        const id = ++value.id
        const timer = setTimeout(
          () => fail('The drawing took too long. Ask for a simpler revision.'),
          2000,
        )
        value.pending = { id, resolve, reject, timer }
        worker.postMessage({ id, frame })
      })
    value.dispose = () => fail('The player was closed.')
    sessions.set(canvas, value)
    return value
  }
  function frameAt(story, seconds) {
    const time = Math.max(0, Math.min(story.duration, Number(seconds) || 0))
    let start = 0,
      index = 0
    while (index < story.beatDurations.length - 1 && time >= start + story.beatDurations[index]) {
      start += story.beatDurations[index++]
    }
    const end = start + story.beatDurations[index]
    return {
      time,
      duration: story.duration,
      index,
      progress: Math.max(0, Math.min(1, (time - start) / (end - start))),
      start,
      end,
      width: 1280,
      height: 480,
    }
  }
  function wrapped(ctx, value, x, y, width, size, color, lines = 2) {
    const words = String(value)
      .split(/\s+/)
      .flatMap((word) => word.match(/.{1,35}/g) || [])
    let result
    do {
      ctx.font = `600 ${size}px system-ui, sans-serif`
      result = []
      let line = ''
      for (const word of words) {
        const next = line ? line + ' ' + word : word
        if (ctx.measureText(next).width > width && line) {
          result.push(line)
          line = word
        } else line = next
      }
      if (line) result.push(line)
      if (result.length <= lines || size <= 18) break
      size -= 2
    } while (result.length > lines && size >= 18)
    ctx.fillStyle = color
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    result
      .slice(0, lines)
      .forEach((line, i) => ctx.fillText(line, x, y + (i - (result.length - 1) / 2) * (size + 5)))
  }
  async function render(canvas, story, seconds) {
    const frame = frameAt(story, seconds)
    const bitmap = await session(canvas, story).request(frame)
    const ctx = canvas.getContext('2d')
    ctx.reset()
    ctx.fillStyle = story.drawing.background
    ctx.fillRect(0, 0, 1280, 720)
    ctx.drawImage(bitmap, 0, 108)
    bitmap.close()
    ctx.font = '600 16px system-ui, sans-serif'
    ctx.fillStyle = story.drawing.ink
    ctx.textAlign = 'left'
    ctx.fillText(story.project, 32, 26)
    ctx.textAlign = 'right'
    ctx.fillText(story.drawing.styleName, 1248, 26)
    wrapped(ctx, story.title, 32, 67, 1216, 34, story.drawing.ink)
    ctx.fillStyle = '#f8faf7'
    ctx.beginPath()
    ctx.roundRect(24, 600, 1232, 94, 12)
    ctx.fill()
    ctx.fillStyle = '#203941'
    ctx.font = '700 21px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(String(frame.index + 1).padStart(2, '0'), 44, 653)
    wrapped(ctx, story.beats[frame.index].caption, 94, 646, 1128, 28, '#203941')
    ctx.fillStyle = story.drawing.ink
    ctx.fillRect(24, 706, (1232 * frame.time) / story.duration, 4)
    return frame.index
  }
  root.CreativeExplainer = {
    render,
    frameAt,
    dispose(canvas) {
      sessions.get(canvas)?.dispose()
      sessions.delete(canvas)
    },
  }
})(globalThis)
