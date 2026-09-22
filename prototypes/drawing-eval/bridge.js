// Shared "send to agent" bridge for every candidate page.
//
// Each page calls `agentBridge.send({ source, svg, png?, meta? })`. When the
// page is framed by index.html the payload is posted to the parent, which
// renders it in the "Agent payload" panel. Standalone, the payload is shown in
// the page's own status line, with the raw SVG made available for download.
;(function () {
  const STATUS_ID = 'status'

  function setStatus(text) {
    const el = document.getElementById(STATUS_ID)
    if (el) el.textContent = text
  }

  /** Rasterise an SVG string to a PNG data URL at the given CSS size. */
  function svgToPng(svgString, width, height, background) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const img = new Image()
      img.onload = () => {
        const scale = window.devicePixelRatio || 1
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(width * scale))
        canvas.height = Math.max(1, Math.round(height * scale))
        const ctx = canvas.getContext('2d')
        if (background) {
          ctx.fillStyle = background
          ctx.fillRect(0, 0, canvas.width, canvas.height)
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        URL.revokeObjectURL(url)
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = (e) => {
        URL.revokeObjectURL(url)
        reject(e)
      }
      img.src = url
    })
  }

  /**
   * Serialise a live <svg> element so it is self-contained: explicit
   * xmlns, width/height, and a viewBox matching its rendered box.
   */
  function serialiseSvg(svgEl, background) {
    const rect = svgEl.getBoundingClientRect()
    const clone = svgEl.cloneNode(true)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(Math.round(rect.width)))
    clone.setAttribute('height', String(Math.round(rect.height)))
    if (!clone.getAttribute('viewBox')) {
      clone.setAttribute('viewBox', `0 0 ${Math.round(rect.width)} ${Math.round(rect.height)}`)
    }
    clone.removeAttribute('style')
    clone.removeAttribute('class')
    if (background) {
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      bg.setAttribute('width', '100%')
      bg.setAttribute('height', '100%')
      bg.setAttribute('fill', background)
      clone.insertBefore(bg, clone.firstChild)
    }
    return {
      svg: new XMLSerializer().serializeToString(clone),
      width: rect.width,
      height: rect.height,
    }
  }

  async function send(payload) {
    const message = {
      type: 'drawing-eval:export',
      source: payload.source,
      svg: payload.svg,
      png: payload.png ?? null,
      meta: payload.meta ?? {},
      at: Date.now(),
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, '*')
      setStatus(
        `Sent to agent panel: ${message.svg.length.toLocaleString()} bytes of SVG${message.png ? ' + PNG' : ''}`,
      )
    } else {
      // Standalone: no panel to receive it, so offer the SVG itself.
      const url = URL.createObjectURL(new Blob([message.svg], { type: 'image/svg+xml' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${message.source.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.svg`
      link.textContent = 'download SVG'
      setStatus(
        `Export ready (open in the index for the agent panel): ${message.svg.length.toLocaleString()} bytes of SVG${message.png ? ' + PNG' : ''} · `,
      )
      document.getElementById(STATUS_ID)?.append(link)
    }
    return message
  }

  /** Convenience for SVG-model pages: serialise, rasterise, send. */
  async function sendSvgElement(source, svgEl, meta, background = '#ffffff') {
    const { svg, width, height } = serialiseSvg(svgEl, background)
    // A failed rasterisation still sends the SVG; the status line says so.
    const png = await svgToPng(svg, width, height, background).catch(() => null)
    if (png === null) setStatus('PNG rasterisation failed; sending SVG only')
    return send({ source, svg, png, meta })
  }

  window.agentBridge = { send, sendSvgElement, serialiseSvg, svgToPng, setStatus }
})()
