import { z } from 'zod'

const id = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,23}$/)
  .describe(
    'Stable ID: lowercase letters, digits, hyphens or underscores; start with a letter; at most 24 characters.',
  )
const coordinate = z.number().min(10).max(90)
const vertical = z.number().min(20).max(80)
export const sceneObject = z.object({
  id,
  kind: z.enum(['document', 'workspace', 'worker', 'bin', 'hub']),
  label: z.string().trim().min(1).max(24),
  x: coordinate.describe('Horizontal position, 10–90. Use 20/50/80 for three columns.'),
  y: vertical.describe('Vertical position, 20–80. Documents at 55; workspace backdrops at 50.'),
  content: z.string().max(32).default('').describe('Visible file value, at most 32 characters.'),
  visible: z
    .boolean()
    .default(true)
    .describe('Set false for objects revealed by appear/copy/merge.'),
  color: z.enum(['blue', 'coral', 'green', 'gold']).default('blue'),
})
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('appear'), target: id }),
  z.object({ type: z.literal('move'), target: id, x: coordinate, y: vertical }),
  z.object({ type: z.literal('copy'), from: id, to: id }),
  z.object({ type: z.literal('edit'), target: id, content: z.string().min(1).max(32) }),
  z.object({ type: z.literal('apply'), from: id, to: id }),
  z.object({ type: z.literal('discard'), target: id, to: id.optional() }),
  z.object({ type: z.literal('merge'), from: z.array(id).length(2), to: id }),
  z.object({ type: z.literal('highlight'), target: id }),
  z.object({ type: z.literal('connect'), from: id, to: id, label: z.string().max(20).default('') }),
])
export const explainerScene = z.object({
  title: z.string().trim().min(1).max(42),
  caption: z
    .string()
    .trim()
    .min(1)
    .max(140)
    .describe('Complete silent narration: at most 140 characters; aim for 8–18 words.'),
  actions: z
    .array(action)
    .min(1)
    .max(6)
    .describe(
      'Actions run together in this scene. Changes persist. Use separate scenes for dependent actions. copy reveals a hidden document with the source contents. apply consumes a proposal and changes its destination. discard removes only its target. merge reveals a hidden document: unequal source contents produce a visible conflict, resolved only by a later edit. highlight holds attention without changing data.',
    ),
})
export type SceneObject = z.output<typeof sceneObject>
export type ExplainerScene = z.output<typeof explainerScene>

/** Check references and causal order before a scene ever reaches the renderer. */
export function validateScenes(objects: SceneObject[], scenes: ExplainerScene[]): void {
  const checkPosition = (object: SceneObject): void => {
    if (
      object.kind === 'workspace' &&
      (object.x < 15 || object.x > 85 || object.y < 35 || object.y > 65)
    )
      throw new Error('Workspace backdrops need x=15–85 and y=35–65 to fit the stage.')
    if (object.kind === 'worker' && object.y > 75)
      throw new Error('Workers need y at most 75 to keep their label visible.')
  }
  objects.forEach(checkPosition)
  const nodes = new Map(objects.map((object) => [object.id, { ...object }]))
  if (nodes.size !== objects.length) throw new Error('Object IDs must be unique.')
  for (const [index, scene] of scenes.entries()) {
    const writes = new Set<string>()
    const reads = new Set<string>()
    const node = (name: string): SceneObject => {
      const value = nodes.get(name)
      if (!value) throw new Error(`Scene ${String(index + 1)}: unknown object ${name}.`)
      return value
    }
    const visible = (name: string): SceneObject => {
      const value = node(name)
      if (!value.visible) throw new Error(`Scene ${String(index + 1)}: ${name} is hidden.`)
      return value
    }
    const document = (name: string): SceneObject => {
      const value = node(name)
      if (value.kind !== 'document') throw new Error(`${name} must be a document for this action.`)
      return value
    }
    const write = (name: string): void => {
      if (writes.has(name))
        throw new Error(
          `Scene ${String(index + 1)}: multiple actions change ${name}; split them into separate scenes.`,
        )
      writes.add(name)
    }
    for (const action of scene.actions) {
      if (action.type === 'copy' || action.type === 'apply' || action.type === 'merge') {
        const sources = action.type === 'merge' ? action.from : [action.from]
        if (new Set(sources).size !== sources.length || sources.includes(action.to))
          throw new Error('Copies and merges need distinct source and destination objects.')
        for (const source of sources) {
          visible(source)
          document(source)
          reads.add(source)
        }
        const target = document(action.to)
        if (action.type === 'apply' ? !target.visible : target.visible)
          throw new Error(
            action.type === 'apply'
              ? 'apply needs a visible destination.'
              : 'copy/merge needs a hidden destination.',
          )
        write(action.to)
        if (action.type === 'apply') write(action.from)
      } else if (action.type === 'connect') {
        visible(action.from)
        visible(action.to)
        if (action.from === action.to) throw new Error('Connections need two distinct objects.')
      } else {
        const target = node(action.target)
        if (action.type === 'appear') {
          if (target.visible)
            throw new Error(`Scene ${String(index + 1)}: ${target.id} is already visible.`)
        } else visible(action.target)
        if (action.type === 'edit') document(action.target)
        if (action.type === 'move') checkPosition({ ...target, x: action.x, y: action.y })
        if (action.type === 'discard' && action.to) {
          if (visible(action.to).kind !== 'bin')
            throw new Error('Discard destination must be a visible bin.')
        }
        if (action.type !== 'highlight') write(action.target)
      }
    }
    // apply consumes its own source; no other action may read an object that
    // another simultaneous action changes. Otherwise ordering changes meaning.
    for (const name of reads) {
      if (writes.has(name) && !scene.actions.some((a) => a.type === 'apply' && a.from === name))
        throw new Error(
          `Scene ${String(index + 1)}: separate reading and changing ${name} into different scenes.`,
        )
      if (
        writes.has(name) &&
        scene.actions.filter((a) =>
          a.type === 'copy' || a.type === 'apply'
            ? a.from === name
            : a.type === 'merge' && a.from.includes(name),
        ).length > 1
      )
        throw new Error(
          `Scene ${String(index + 1)}: a consumed proposal cannot also be copied or merged.`,
        )
    }
    for (const action of scene.actions) {
      if (action.type === 'copy' || action.type === 'apply' || action.type === 'merge') {
        node(action.to).visible = true
        if (action.type === 'apply') node(action.from).visible = false
      } else if (action.type === 'appear') node(action.target).visible = true
      else if (action.type === 'discard') node(action.target).visible = false
    }
  }
}
