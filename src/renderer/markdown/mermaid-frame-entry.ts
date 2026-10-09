import mermaid from 'mermaid'
import { startMermaidFrame } from '@copse/streaming-markdown/diagrams/mermaid/frame'
import regularFont from '../../../assets/fonts/Pliant-Variable.ttf'
import italicFont from '../../../assets/fonts/Pliant-Italic-Variable.ttf'

async function loadPliant(): Promise<void> {
  const fonts = [
    { source: regularFont, style: 'normal' },
    { source: italicFont, style: 'italic' },
  ]
  await Promise.all(
    fonts.map(async ({ source, style }) => {
      // Binary FontFace sources do not fetch a URL. Keep font-src 'none'; these
      // are the same bundled font bytes used by chat, inside the hashed script.
      const bytes = Uint8Array.from(atob(source), (character) => character.charCodeAt(0))
      const font = new FontFace('Pliant', bytes, { style, weight: '100 900' })
      document.fonts.add(await font.load())
    }),
  )
}

startMermaidFrame({ mermaid, theme: 'dark', fontFamily: 'Pliant', prepare: loadPliant })
