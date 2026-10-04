/**
 * The declared parameter space (`space.json`): which tuning keys may vary, each
 * parameter's default and its ordered candidate values, the fixed base every config
 * shares, and the task sets the hill climber uses.
 *
 * A *selection* picks one value label per parameter. Materialising a selection
 * merges the base and each chosen value's `set` into one tuning; the content hash
 * of that tuning is the config's identity.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  decodeHarborTuning,
  harborTuningSchema,
  type HarborTuning,
} from '../../src/main/services/container-runtime/harbor-tuning.mts'
import { configHash, makeConfig, type ResolvedConfig } from './configs.mts'

const taskList = z.array(z.string().min(1)).min(1)

export const spaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  description: z.string().optional(),
  /** Tuning every config in this space shares (not varied by the climb). */
  base: harborTuningSchema,
  parameters: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
        description: z.string(),
        /** Where the winning value would change a product default; null if it has no product seam yet. */
        productSeam: z.strictObject({ file: z.string(), symbol: z.string() }).nullable(),
        /** Label of the default value. */
        default: z.string(),
        /** Ordered candidate values; the order is the neighbourhood the climb walks. */
        values: z
          .array(z.strictObject({ label: z.string().min(1), set: harborTuningSchema }))
          .min(2),
      }),
    )
    .min(1),
  taskSets: z.strictObject({
    /** Tasks whose outcome varies run to run: cheap, discriminating, used to screen candidates. */
    screen: taskList,
    /** A wider, disjoint set where the verdict is decided (fresh data, not the screening data). */
    confirm: taskList,
    /** Easy tasks the incumbent solves reliably: a candidate that loses one is rejected. */
    canary: taskList,
  }),
  estimate: z.strictObject({
    /** Rough wall-clock minutes for one trial, for `--plan`. */
    minutesPerTrial: z.number().positive(),
  }),
})

export type Space = z.infer<typeof spaceSchema>
export type SpaceParameter = Space['parameters'][number]
/** One value label per parameter id. */
export type Selection = Readonly<Record<string, string>>

/** The dotted key paths a tuning sets, e.g. `sampling.temperature`. */
export function leafPaths(tuning: HarborTuning): string[] {
  const paths: string[] = []
  for (const [key, value] of Object.entries(tuning)) {
    if (value === undefined) continue
    if (typeof value === 'object') {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (innerValue !== undefined) paths.push(`${key}.${inner}`)
      }
    } else paths.push(key)
  }
  return paths
}

/** `b` over `a`, merging the two nested objects key by key. */
export function mergeTuning(a: HarborTuning, b: HarborTuning): HarborTuning {
  const loopLimits =
    a.loopLimits === undefined && b.loopLimits === undefined
      ? undefined
      : { ...a.loopLimits, ...b.loopLimits }
  const sampling =
    a.sampling === undefined && b.sampling === undefined
      ? undefined
      : { ...a.sampling, ...b.sampling }
  return decodeMerged({
    ...a,
    ...b,
    ...(loopLimits === undefined ? {} : { loopLimits }),
    ...(sampling === undefined ? {} : { sampling }),
  })
}

function decodeMerged(value: unknown): HarborTuning {
  const tuning = decodeHarborTuning(JSON.stringify(value))
  if (tuning === null) throw new Error('Merged tuning is invalid')
  return tuning
}

export function parameterOf(space: Space, id: string): SpaceParameter {
  const parameter = space.parameters.find((candidate) => candidate.id === id)
  if (parameter === undefined) throw new Error(`Unknown parameter '${id}'`)
  return parameter
}

export function defaultSelection(space: Space): Selection {
  return Object.fromEntries(space.parameters.map((parameter) => [parameter.id, parameter.default]))
}

/** The tuning a selection stands for: the base, then each chosen value in declaration order. */
export function materialize(space: Space, selection: Selection): HarborTuning {
  let tuning: HarborTuning = space.base
  for (const parameter of space.parameters) {
    const label = selection[parameter.id]
    const value = parameter.values.find((candidate) => candidate.label === label)
    if (value === undefined) {
      throw new Error(`Selection has no valid value for '${parameter.id}': ${String(label)}`)
    }
    tuning = mergeTuning(tuning, value.set)
  }
  return tuning
}

/** Throws on a malformed space: bad defaults, duplicate labels, overlapping keys or task sets. */
export function validateSpace(space: Space): void {
  const ids = new Set<string>()
  const owner = new Map<string, string>()
  for (const path of leafPaths(space.base)) owner.set(path, 'base')
  for (const parameter of space.parameters) {
    if (ids.has(parameter.id)) throw new Error(`Duplicate parameter id '${parameter.id}'`)
    ids.add(parameter.id)
    const labels = parameter.values.map((value) => value.label)
    if (new Set(labels).size !== labels.length) {
      throw new Error(`Parameter '${parameter.id}' has duplicate value labels`)
    }
    if (!labels.includes(parameter.default)) {
      throw new Error(
        `Parameter '${parameter.id}' default '${parameter.default}' is not one of its values`,
      )
    }
    const own = new Set<string>()
    for (const value of parameter.values) for (const path of leafPaths(value.set)) own.add(path)
    for (const path of own) {
      const other = owner.get(path)
      if (other !== undefined) {
        throw new Error(`Parameter '${parameter.id}' sets '${path}', which '${other}' also sets`)
      }
      owner.set(path, parameter.id)
    }
  }
  const sets = space.taskSets
  const seen = new Map<string, string>()
  for (const [name, tasks] of Object.entries(sets)) {
    if (new Set(tasks).size !== tasks.length) throw new Error(`Task set '${name}' repeats a task`)
    for (const task of tasks) {
      const earlier = seen.get(task)
      if (earlier !== undefined) {
        throw new Error(
          `Task '${task}' is in both '${earlier}' and '${name}'; the sets must be disjoint`,
        )
      }
      seen.set(task, name)
    }
  }
  materialize(space, defaultSelection(space))
}

export function parseSpace(text: string, source: string): Space {
  const space = safeJsonParse(text, decodeWithSchema(spaceSchema))
  if (space === null) throw new Error(`${source} is not a valid tuning space`)
  validateSpace(space)
  return space
}

export function loadSpace(path: string): Space {
  return parseSpace(readFileSync(path, 'utf8'), path)
}

/** The config a selection stands for. The all-defaults selection is named `default`. */
export function configForSelection(space: Space, selection: Selection): ResolvedConfig {
  const tuning = materialize(space, selection)
  const defaults = defaultSelection(space)
  const isDefault = space.parameters.every((p) => selection[p.id] === defaults[p.id])
  const hash = configHash(tuning)
  return makeConfig(isDefault ? 'default' : `hc-${hash.slice(0, 8)}`, tuning)
}

export interface Neighbour {
  parameter: string
  from: string
  to: string
  selection: Selection
}

export type NeighbourMode = 'adjacent' | 'all'

/**
 * One-parameter changes from `selection`. `adjacent` walks the declared order one step
 * either way (the ordinal reading of each value list); `all` tries every other value,
 * nearest first. `only` restricts the climb to some parameters.
 */
export function neighboursOf(
  space: Space,
  selection: Selection,
  mode: NeighbourMode,
  only?: readonly string[],
): Neighbour[] {
  const neighbours: Neighbour[] = []
  for (const parameter of space.parameters) {
    if (only !== undefined && !only.includes(parameter.id)) continue
    const labels = parameter.values.map((value) => value.label)
    const index = labels.indexOf(selection[parameter.id] ?? '')
    if (index < 0) throw new Error(`Selection has no valid value for '${parameter.id}'`)
    const targets = labels
      .map((label, position) => ({ label, distance: Math.abs(position - index), position }))
      .filter((target) => target.distance > 0 && (mode === 'all' || target.distance === 1))
      .sort((a, b) => a.distance - b.distance || a.position - b.position)
    for (const target of targets) {
      neighbours.push({
        parameter: parameter.id,
        from: labels[index] ?? '',
        to: target.label,
        selection: { ...selection, [parameter.id]: target.label },
      })
    }
  }
  return neighbours
}
