import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { sceneObject, explainerScene, validateScenes } from './explainer-scenes.ts'

/** Bounded story data, never model-authored HTML or executable code. */
export const explainerInput = {
  project: z.string().trim().min(1).max(40).describe('Project or subject name.'),
  title: z.string().trim().min(1).max(75),
  pattern: z
    .enum(['review', 'parallel', 'context', 'routing', 'sequence'])
    .default('sequence')
    .describe(
      'Legacy only; ignored when scenes are provided. For new explanations use objects and scenes. review shows exactly three edits (two accepted, one reverted); parallel shows three workers searching then gathering reports; context removes older output; routing shows device, cloud and tool destinations; sequence is a neutral three-step process. Only use a mechanism whose actions match the narration.',
    ),
  style: z
    .enum([
      'auto',
      'paper',
      'mailroom',
      'comic',
      'felt',
      'travel',
      'kinetic',
      'workshop',
      'folded',
      'signal',
    ])
    .default('auto')
    .describe(
      'Choose a style for the subject: paper for review; mailroom for parallel investigation; travel for capacity; folded for routes; comic or felt for approachable sequences; kinetic for a single strong contrast; workshop for assembly. Signal is abstract: use only when specifically requested. auto chooses a concrete default from the mechanism.',
    ),
  audience: z.enum(['users', 'engineers', 'both']).default('both'),
  duration: z
    .number()
    .int()
    .min(12)
    .max(60)
    .default(24)
    .describe('Seconds. Allow enough time to read every caption.'),
  labels: z
    .array(z.string().trim().min(1).max(28))
    .length(3)
    .optional()
    .describe('Legacy only. Three concrete objects or areas shown on screen.'),
  beats: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(48),
        caption: z
          .string()
          .trim()
          .min(1)
          .max(180)
          .describe(
            'Complete narration for this beat: plain language, one action and its consequence.',
          ),
      }),
    )
    .length(3)
    .optional()
    .describe(
      'Legacy only. Starting problem, action/mechanism, and observable result. Write the narration yourself from this thread and inspected project evidence.',
    ),
  objects: z
    .array(sceneObject)
    .min(2)
    .max(10)
    .optional()
    .describe(
      'New explainers: persistent objects with IDs, positions and file contents. Use invisible destinations for copy/merge. Workspace objects are large backdrops; place their documents in front. Keep labels at most 24 characters.',
    ),
  scenes: z
    .array(explainerScene)
    .min(4)
    .max(6)
    .optional()
    .describe(
      'New explainers: 4–6 scenes pairing one factual claim with actions that demonstrate it. State persists across scenes. Narration at most 140 characters per scene. Use copy/edit/apply/discard/merge to show cause and effect, not just highlights.',
    ),
  source: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      'At most 300 characters. Short grounding note: inspected files or supplied facts; distinguish a conceptual example from verified project behavior.',
    ),
}

const explainerSchema = z.object(explainerInput)

const DEFAULT_STYLES = {
  review: 'paper',
  parallel: 'mailroom',
  context: 'travel',
  routing: 'folded',
  sequence: 'comic',
} as const

type ParsedExplainer = z.output<typeof explainerSchema>
type PreparedExplainer = Omit<ParsedExplainer, 'beats' | 'style'> & {
  beats: Array<{ title: string; caption: string }>
  style: Exclude<ParsedExplainer['style'], 'auto'>
  version: 1 | 2
  beatDurations: number[]
  captionSize: number
}

export function prepareExplainer(input: unknown): PreparedExplainer {
  const story = explainerSchema.parse(input)
  if (story.scenes && story.objects) validateScenes(story.objects, story.scenes)
  else if (story.scenes || story.objects) throw new Error('Provide both objects and scenes.')
  else if (!story.beats || !story.labels)
    throw new Error(
      'New explanations need objects and 4–6 scenes. Legacy stories need three beats and labels.',
    )
  const beats = story.scenes ?? story.beats ?? []
  const weights = beats.map((beat) => Math.max(4, beat.caption.split(/\s+/).length / 2.5 + 1))
  const sum = weights.reduce((a, b) => a + b, 0)
  const duration = Math.min(60, Math.max(story.duration, Math.ceil(sum)))
  return {
    ...story,
    beats,
    version: story.scenes ? 2 : 1,
    style:
      story.style === 'auto'
        ? story.scenes
          ? 'paper'
          : DEFAULT_STYLES[story.pattern]
        : story.style,
    duration,
    beatDurations: weights.map((weight) => (duration * weight) / sum),
    captionSize: 30,
  }
}

/** A preview token refers to the exact HTML inspected, never a mutable title. */
export function createExplainerPreviews(): {
  record(html: string): string
  assertReviewed(id: string | undefined, html: string): void
} {
  const entries = new Map<string, { hash: string; at: number }>()
  const hash = (html: string): string => createHash('sha256').update(html).digest('hex')
  return {
    record(html: string): string {
      for (const [key, value] of entries) if (Date.now() - value.at > 600_000) entries.delete(key)
      while (entries.size >= 24) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      const id = randomUUID()
      entries.set(id, { hash: hash(html), at: Date.now() })
      return id
    },
    assertReviewed(id: string | undefined, html: string): void {
      const entry = id ? entries.get(id) : undefined
      if (!entry || Date.now() - entry.at > 600_000 || entry.hash !== hash(html))
        throw new Error(
          'Preview these exact scenes with preview_explainer first, inspect the returned frames, then pass its previewId. Changed stories need a new preview.',
        )
    },
  }
}

/** Escaping '<' also prevents user text from terminating the inert JSON script. */
export function buildExplainerHtml(template: string, input: unknown): string {
  const json = JSON.stringify(prepareExplainer(input)).replaceAll('<', '\\u003c')
  return template.replace('__COPSE_EXPLAINER_STORY__', () => json)
}

export async function renderExplainerHtml(input: unknown): Promise<string> {
  // The production bundle is dist/main; a source-hosted executor lives under
  // src/main/services. Never search the user's working directory for scripts.
  for (const directory of ['../assets/explainers', '../../../assets/explainers']) {
    let template: string
    try {
      template = await readFile(join(__dirname, directory, 'player.html'), 'utf8')
    } catch {
      continue
    }
    return buildExplainerHtml(template, input)
  }
  throw new Error('The bundled explainer player is missing. Rebuild Copse before retrying.')
}
