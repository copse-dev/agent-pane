import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from './safe-json.mts'
import { computeSelection, listSourceFiles, type Selection, type CiPlan } from '../test-oracle.mts'

const inventorySchema = z.object({
  version: z.literal(1),
  areas: z.array(
    z.object({
      prefix: z.string().min(1),
      smoke: z.array(z.string()).nullable(),
      evidence: z.record(z.string(), z.string()).optional(),
    }),
  ),
})
export function parseSmokeInventory(text: string): z.infer<typeof inventorySchema> {
  const inventory = safeJsonParse(text, decodeWithSchema(inventorySchema))
  if (!inventory) throw new Error('Invalid smoke inventory')
  return inventory
}
type Inventory = ReturnType<typeof parseSmokeInventory>

export function computeSmallGate(
  selection: Selection,
  suite: string[],
  inventory: Inventory,
  forced: boolean,
  expand: (files: string[]) => string[] = (files) => computeSelection(files).selectedE2e,
  sourceFiles: string[] = listSourceFiles(),
): CiPlan & { reason: string; uncovered: string[] } {
  const full = (
    reason: string,
    uncovered: string[] = [],
  ): CiPlan & { reason: string; uncovered: string[] } => ({
    mode: 'full' as const,
    specs: suite,
    count: suite.length,
    reason,
    uncovered,
  })
  if (forced || selection.broad || selection.baseUnknown) return full('forced or broad')
  const smoke = [...new Set(inventory.areas.flatMap((area) => area.smoke ?? []))]
  if (smoke.some((spec) => !suite.includes(spec))) return full('invalid smoke inventory')
  const shipped = (file: string): boolean =>
    /^(src\/|packages\/[^/]+\/src\/)/.test(file) && !file.endsWith('.test.ts')
  const source = selection.changed.filter(shipped)
  const specChange = selection.changed.some((file) => file.endsWith('.e2e.ts'))
  if (!source.length && !specChange && !selection.selectedE2e.length)
    return {
      mode: 'skip',
      specs: [],
      count: 0,
      reason: 'no shipped source or specs',
      uncovered: [],
    }
  const selected = new Set(
    [...selection.selectedE2e, ...smoke].filter((spec) => suite.includes(spec)),
  )
  // Package source isn't part of the current oracle's confidence universe.
  // Keep it full until its imports/area ownership can be evaluated there.
  if (source.some((file) => file.startsWith('packages/')))
    return full('package source requires full')
  const expansion = new Set<string>()
  const uncovered: string[] = []
  for (const file of selection.unmapped) {
    const areas = inventory.areas.filter((area) => file.startsWith(area.prefix))
    if (!areas.length || areas.some((area) => area.smoke === null)) {
      uncovered.push(file)
      continue
    }
    for (const area of areas) {
      for (const spec of area.smoke ?? []) selected.add(spec)
      for (const path of sourceFiles) if (path.startsWith(area.prefix)) expansion.add(path)
    }
  }
  if (uncovered.length) return full('unmapped area', uncovered)
  for (const spec of expansion.size ? expand([...expansion]) : [])
    if (suite.includes(spec)) selected.add(spec)
  const specs = [...selected].sort()
  if (specs.length > suite.length / 2) return full('selection exceeds half suite')
  return {
    mode: 'subset',
    specs,
    count: specs.length,
    reason: 'affected plus smoke and area expansion',
    uncovered,
  }
}
