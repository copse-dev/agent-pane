import type { TranscriptAttachment } from '@shared/types'
import { outlineIcon } from './outline-icon.ts'

// lucide-style `currentColor` outline paths for the attachment kinds, shared by
// the composer chrome and the transcript chips so a file / thread / pasted-text
// reference reads the same everywhere — theme-aware SVG, never an emoji.
const ATTACHMENT_ICON_PATHS: Record<TranscriptAttachment['kind'], string[]> = {
  // lucide `paperclip`
  file: [
    'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
  ],
  // lucide `messages-square` — a past conversation thread
  thread: [
    'M14 9a2 2 0 0 1-2 2H6l-4 4V4c0-1.1.9-2 2-2h8a2 2 0 0 1 2 2Z',
    'M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
  ],
  // lucide `file-text` — a pasted block of text
  paste: [
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z',
    'M14 2v5h5',
    'M16 13H8',
    'M16 17H8',
    'M10 9H8',
  ],
  // lucide `square-terminal` — an @shell tab snapshot
  shell: [
    'm7 11 2-2-2-2',
    'M11 13h4',
    'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2Z',
  ],
}

/** The outline icon for an attachment kind, at a caller-styled size/color. */
export function attachmentIcon(
  kind: TranscriptAttachment['kind'],
  className: string,
): SVGSVGElement {
  return outlineIcon(kind, ATTACHMENT_ICON_PATHS[kind], className)
}
