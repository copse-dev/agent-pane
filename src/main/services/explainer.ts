import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'
import { sceneObject, explainerScene, validateScenes } from './explainer-scenes.ts'

/** Narration stays inert; optional drawing code runs only in a disposable browser worker. */
export const explainerInput = {
  project: z.string().trim().min(1).max(40).describe('Project or subject name.'),
  title: z.string().trim().min(1).max(75),
  pattern: z
    .enum(['review', 'parallel', 'context', 'routing', 'sequence'])
    .default('sequence')
    .describe(
      'Legacy only; ignored for custom drawings and composed scenes. Prefer beats plus drawing for new explanations. review shows exactly three edits (two accepted, one reverted); parallel shows three workers searching then gathering reports; context removes older output; routing shows device, cloud and tool destinations; sequence is a neutral three-step process. Only use a mechanism whose actions match the narration.',
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
      'Compatibility styles for objects/scenes or legacy stories; ignored for drawing, which supplies its own styleName. Paper for review; mailroom for parallel investigation; travel for capacity; folded for routes; comic or felt for approachable sequences; kinetic for a single strong contrast; workshop for assembly. Signal is abstract: use only when specifically requested. auto chooses a concrete default from the mechanism.',
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
    .min(3)
    .max(6)
    .optional()
    .describe(
      'With drawing: 3–6 narration beats, each with a short title and caption of at most 140 characters. The player allocates readable timings. Legacy stories use exactly three beats.',
    ),
  drawing: z
    .object({
      styleName: z.string().trim().min(1).max(60),
      direction: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe(
          'At most 300 characters: your art direction and how its motion explains the subject.',
        ),
      background: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .default('#171c22'),
      ink: z
        .string()
        .regex(/^#[0-9a-f]{6}$/i)
        .default('#eef1f0'),
      code: z
        .string()
        .trim()
        .min(1)
        .max(24_000)
        .describe(
          'JavaScript function BODY for (ctx, frame, helpers). Draw original Canvas 2D art in 1280×480. frame: {time,duration,index,progress,start,end,width,height}; index is the current beat, progress 0–1. helpers: clamp(v), ease(v), mix(a,b,p), text(value,x,y,size=28,color="#fff",align="left") with y on the middle baseline; textBox(value,x,y,w,h,options={}) centres measured text inside a box. textBox options: size=28, minSize=26 (or size if smaller), padding=8, color="#fff", align="center" (left|center|right), verticalAlign="middle" (top|middle|bottom), maxLines=2, lineHeight=1.2, weight=600, font="sans-serif". It wraps and fits down to minSize, then throws on overflow: enlarge the box or shorten the label. Use textBox for card/button labels, reserve icon space in its bounds, and apply the same transform to box and text; never add baseline offsets. Other helpers: rect(x,y,w,h,color,radius=0), circle(x,y,r,color), line(x1,y1,x2,y2,color,width=2). Use local functions and Canvas freely. Derive all state from frame; no randomness, clocks, asynchronous work, DOM, imports or network. Do not draw the title, narration, controls or progress bar; Copse supplies those.',
        ),
    })
    .optional()
    .describe(
      'Preferred for new explanations: invent your own visual language, not a preset plot. Supply beats and drawing together. No HTML or separate files.',
    ),
  objects: z
    .array(sceneObject)
    .min(2)
    .max(10)
    .optional()
    .describe(
      'Compatibility scene format: persistent objects with IDs, positions and file contents. Use invisible destinations for copy/merge. Workspace objects are large backdrops; place their documents in front. Keep labels at most 24 characters.',
    ),
  scenes: z
    .array(explainerScene)
    .min(4)
    .max(6)
    .optional()
    .describe(
      'Compatibility scene format: 4–6 scenes pairing one factual claim with actions that demonstrate it. State persists across scenes. Narration at most 140 characters per scene. Use copy/edit/apply/discard/merge to show cause and effect, not just highlights.',
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

/** Publication can use only the preview ID, avoiding a second copy of the drawing program. */
export const explainerPublishInput = {
  ...z
    .object({
      ...explainerInput,
      pattern: explainerInput.pattern.unwrap(),
      style: explainerInput.style.unwrap(),
      audience: explainerInput.audience.unwrap(),
      duration: explainerInput.duration.unwrap(),
    })
    .partial().shape,
  previewId: z.uuid().optional(),
}

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
  version: 1 | 2 | 3
  beatDurations: number[]
  captionSize: number
}

export function prepareExplainer(input: unknown): PreparedExplainer {
  const story = explainerSchema.parse(input)
  if (story.drawing) {
    if (story.scenes || story.objects || !story.beats)
      throw new Error('Custom drawing needs beats and drawing, without objects or scenes.')
    if (story.beats.some((beat) => beat.caption.length > 140))
      throw new Error('Custom drawing captions must be at most 140 characters.')
  } else if (story.scenes && story.objects) validateScenes(story.objects, story.scenes)
  else if (story.scenes || story.objects) throw new Error('Provide both objects and scenes.')
  else if (!story.beats || story.beats.length !== 3 || !story.labels)
    throw new Error(
      'Provide beats plus drawing, or objects plus 4–6 scenes. Legacy stories need three beats and labels.',
    )
  const beats = story.scenes ?? story.beats ?? []
  const weights = beats.map((beat) => Math.max(4, beat.caption.split(/\s+/).length / 2.5 + 1))
  const sum = weights.reduce((a, b) => a + b, 0)
  const duration = Math.min(60, Math.max(story.duration, Math.ceil(sum)))
  return {
    ...story,
    beats,
    version: story.drawing ? 3 : story.scenes ? 2 : 1,
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
  record(html: string, story?: PreparedExplainer): string
  get(id: string | undefined): { html: string; story: PreparedExplainer }
  assertReviewed(id: string | undefined, html: string): void
} {
  const entries = new Map<
    string,
    { hash: string; at: number; html: string; story: PreparedExplainer | undefined }
  >()
  const hash = (html: string): string => createHash('sha256').update(html).digest('hex')
  return {
    record(html: string, story?: PreparedExplainer): string {
      for (const [key, value] of entries) if (Date.now() - value.at > 600_000) entries.delete(key)
      while (entries.size >= 24) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
      const id = randomUUID()
      entries.set(id, { hash: hash(html), at: Date.now(), html, story })
      return id
    },
    get(id): { html: string; story: PreparedExplainer } {
      const entry = id ? entries.get(id) : undefined
      if (!entry?.story || Date.now() - entry.at > 600_000)
        throw new Error(
          'This preview expired or is unavailable. Preview the explanation again before publishing.',
        )
      return { html: entry.html, story: entry.story }
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
export function buildExplainerHtml(template: string, input: unknown, drawingRuntime = ''): string {
  const json = JSON.stringify(prepareExplainer(input)).replaceAll('<', '\\u003c')
  return template
    .replace('__COPSE_EXPLAINER_DRAWING_RUNTIME__', () => drawingRuntime)
    .replace('__COPSE_EXPLAINER_STORY__', () => json)
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
    const runtime = await readFile(join(__dirname, directory, 'drawing.js'), 'utf8')
    return buildExplainerHtml(template, input, runtime)
  }
  throw new Error('The bundled explainer player is missing. Rebuild Copse before retrying.')
}
