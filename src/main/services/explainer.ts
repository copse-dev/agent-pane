import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** Bounded story data, never model-authored HTML or executable code. */
export const explainerInput = {
  project: z.string().trim().min(1).max(40).describe('Project or subject name.'),
  title: z.string().trim().min(1).max(75),
  pattern: z
    .enum(['review', 'parallel', 'context', 'routing', 'sequence'])
    .describe(
      'Visual mechanism. review shows exactly three edits (two accepted, one reverted); parallel shows three workers searching then gathering reports; context removes older output; routing shows device, cloud and tool destinations; sequence is a neutral three-step process. Only use a mechanism whose actions match the narration.',
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
    .describe('Three concrete objects or areas shown on screen.'),
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
    .describe(
      'Starting problem, action/mechanism, and observable result. Write the narration yourself from this thread and inspected project evidence.',
    ),
  source: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      'Short grounding note: inspected files or supplied facts; distinguish a conceptual example from verified project behavior.',
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

type PreparedExplainer = Omit<z.output<typeof explainerSchema>, 'style'> & {
  style: Exclude<z.output<typeof explainerSchema>['style'], 'auto'>
  version: number
  beatDurations: number[]
  captionSize: number
}

export function prepareExplainer(input: unknown): PreparedExplainer {
  const story = explainerSchema.parse(input)
  // Captions are the narration. Allocate time by reading load, not a fixed
  // six-second cut that truncates longer sentences. A caller can request longer.
  const weights = story.beats.map((beat) => Math.max(4, beat.caption.split(/\s+/).length / 2.5 + 1))
  const sum = weights.reduce((a, b) => a + b, 0)
  const duration = Math.min(60, Math.max(story.duration, Math.ceil(sum)))
  return {
    ...story,
    version: 1,
    style: story.style === 'auto' ? DEFAULT_STYLES[story.pattern] : story.style,
    duration,
    beatDurations: weights.map((weight) => (duration * weight) / sum),
    captionSize: 30,
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
