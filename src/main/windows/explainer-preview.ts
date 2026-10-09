import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { htmlDataUrl } from '@shared/canvas/artefact.ts'

const EXPLAINER_PREVIEW_PARTITION = 'explainer-preview'

/** The shared player owns the window; generated drawing code runs in its bounded worker. */
export async function captureExplainerFrames(
  html: string,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted()
  const window = new BrowserWindow({
    show: false,
    width: 960,
    height: 620,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false,
      // One in-memory partition for every capture: Electron never frees a
      // session, so a fresh partition per capture leaked one per preview.
      // Captures load opaque data: URLs, which cannot share storage anyway.
      partition: EXPLAINER_PREVIEW_PARTITION,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    callback({ cancel: !/^(data:|blob:)/.test(request.url) })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel = (): void => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = (): void => {
      reject(new Error('Explainer preview cancelled.'))
    }
    timer = setTimeout(() => {
      reject(new Error('Explainer preview timed out. Simplify the drawing and retry.'))
    }, 20_000)
    signal?.addEventListener('abort', cancel, { once: true })
  })
  try {
    const capture = async (): Promise<unknown> => {
      await window.loadURL(htmlDataUrl(html))
      return window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      await window.explainerReady;
      const story = JSON.parse(document.getElementById('story').textContent);
      const canvas = document.getElementById('scene');
      const small = document.createElement('canvas');
      small.width = story.drawing ? 1920 : 960;
      small.height = story.drawing ? 384 : 540;
      const ctx = small.getContext('2d');
      const artwork = document.createElement('canvas'); artwork.width = 1280; artwork.height = 480;
      const art = () => { artwork.getContext('2d').clearRect(0, 0, 1280, 480); artwork.getContext('2d').drawImage(canvas, 0, 108, 1280, 480, 0, 0, 1280, 480); return artwork.toDataURL(); };
      let movingBeats = 0;
      const frames = []; let at = 0;
      for (const duration of story.beatDurations) {
        const changes = new Set();
        ctx.fillStyle = '#171c22'; ctx.fillRect(0, 0, small.width, small.height);
        const samples = story.drawing ? [.18, .5, .96] : [.92];
        for (let index = 0; index < samples.length; index++) {
          const seconds = at + duration * samples[index];
          await window.renderFrame(seconds);
          if (story.drawing) {
            changes.add(art());
            ctx.drawImage(canvas, index * 640, 24, 640, 360);
            ctx.font = '15px sans-serif'; ctx.fillStyle = '#fff';
            ctx.fillText(seconds.toFixed(1) + 's · ' + ['early movement', 'mid-transition', 'outcome'][index], index * 640 + 12, 17);
          } else ctx.drawImage(canvas, 0, 0, 960, 540);
        }
        frames.push(small.toDataURL('image/png').split(',')[1]);
        if (changes.size > 1) movingBeats++;
        at += duration;
      }
      if (story.drawing) {
        if (movingBeats === 0) throw new Error('The drawing did not change within any beat. Show the mechanism through motion, not only cuts between static pictures.');
        for (const time of [story.duration * .37, story.duration]) {
          await window.renderFrame(time); const expected = art();
          await window.renderFrame(0); await window.renderFrame(time);
          if (art() !== expected) throw new Error('Drawing is not deterministic. Derive all state from frame; remove random values, clocks and persistent state.');
        }
      }
      return frames;
    })()`)
    }
    const images: unknown = await Promise.race([capture(), stopped])
    return z.array(z.string().min(1).max(2_000_000)).min(3).max(6).parse(images)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
    if (!window.isDestroyed()) window.destroy()
  }
}
