import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  VISUAL_EVIDENCE_CAPTION_MAX_CHARS,
  VISUAL_EVIDENCE_LABEL_MAX_CHARS,
  type VisualEvidenceAsset,
  type VisualEvidenceDraft,
} from '@copse/agent/visual-evidence.ts'
import { defineTool } from '@shared/types'
import { requireThreadExecutionOwner } from '../services/thread-execution-context.ts'
import { resolveCaptureHandle } from '../services/visual-evidence/capture-handle-store.ts'

export const PRESENT_VISUAL_EVIDENCE_TOOL_NAME = 'present_visual_evidence'

const captureSelectionSchema = z
  .object({
    captureHandle: z
      .string()
      .regex(/^capture_[A-Za-z0-9-]{1,128}$/)
      .describe('Opaque capture handle returned by browser_screenshot.'),
    label: z
      .string()
      .trim()
      .min(1)
      .max(VISUAL_EVIDENCE_LABEL_MAX_CHARS)
      .optional()
      .describe('Short visible label. Defaults to Screenshot, or Before / After for a pair.'),
  })
  .strict()

const presentVisualEvidenceParameters = z
  .object({
    caption: z
      .string()
      .trim()
      .min(1)
      .max(VISUAL_EVIDENCE_CAPTION_MAX_CHARS)
      .describe('Concise factual explanation of what the visual proves.'),
    captures: z
      .array(captureSelectionSchema)
      .min(1)
      .max(2)
      .describe('One screenshot, or a before/after pair in display order.'),
  })
  .strict()
  .refine(
    ({ captures }) =>
      new Set(captures.map(({ captureHandle }) => captureHandle)).size === captures.length,
    { message: 'Capture handles must be unique.', path: ['captures'] },
  )

function displaySafeBrowserUrl(raw: string): string {
  if (!raw) return 'about:blank'
  try {
    const parsed = new URL(raw)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return 'about:blank'
  }
}

function defaultLabel(index: number, count: number): string {
  if (count === 1) return 'Screenshot'
  return index === 0 ? 'Before' : 'After'
}

export const presentVisualEvidenceTool = defineTool({
  name: PRESENT_VISUAL_EVIDENCE_TOOL_NAME,
  description:
    'Publish one inspected screenshot, or a two-screenshot before/after comparison, as durable visual evidence in your response. Pass only capture handles returned by browser_screenshot in this thread. Use this for meaningful proof of a reproduced bug or verified fix, not for every screenshot.',
  parameters: presentVisualEvidenceParameters,
  execute({ caption, captures }) {
    const owner = requireThreadExecutionOwner()
    const resolved = captures.map(({ captureHandle, label }, index): VisualEvidenceAsset => {
      const capture = resolveCaptureHandle(captureHandle, owner)
      if (!capture) {
        throw new Error(
          `Capture handle ${captureHandle} is expired, unavailable, or belongs to another thread. Take a fresh screenshot and try again.`,
        )
      }
      return {
        id: `evidence_asset_${randomUUID()}`,
        label: label ?? defaultLabel(index, captures.length),
        mimeType: capture.handle.mimeType,
        width: capture.handle.width,
        height: capture.handle.height,
        capturedAt: capture.handle.capturedAt,
        source: {
          kind: 'browser',
          viewId: capture.handle.source.viewId,
          title: capture.handle.source.title,
          url: displaySafeBrowserUrl(capture.handle.source.url),
        },
        dataUrl: `data:image/png;base64,${capture.bytes.toString('base64')}`,
      }
    })
    const evidence: VisualEvidenceDraft = {
      id: `evidence_${randomUUID()}`,
      kind: resolved.length === 1 ? 'screenshot' : 'comparison',
      caption,
      createdAt: Date.now(),
      assets: resolved,
    }
    return {
      result:
        resolved.length === 1
          ? `Published visual evidence: ${caption}`
          : `Published a before/after visual comparison: ${caption}`,
      visualEvidence: [evidence],
    }
  },
})
