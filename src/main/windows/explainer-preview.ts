import { BrowserWindow } from 'electron'
import { z } from 'zod'

/** Only the shipped player + validated inert story data enter this window. */
export async function captureExplainerFrames(html: string): Promise<string[]> {
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
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const images: unknown = await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      const story = JSON.parse(document.getElementById('story').textContent);
      const canvas = document.getElementById('scene');
      const small = document.createElement('canvas'); small.width = 960; small.height = 540;
      const frames = []; let at = 0;
      for (const duration of story.beatDurations) {
        Explainer.render(canvas, story, at + duration * 0.92);
        small.getContext('2d').drawImage(canvas, 0, 0, 960, 540);
        frames.push(small.toDataURL('image/png').split(',')[1]);
        at += duration;
      }
      return frames;
    })()`)
    return z.array(z.string().min(1).max(2_000_000)).min(3).max(6).parse(images)
  } finally {
    window.destroy()
  }
}
