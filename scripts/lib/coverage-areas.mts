// Per-area line coverage for the coverage ratchet (#4391).
//
// One global line figure lets a drop in one layer hide behind a rise in
// another: `src/main/ipc` sat at about 32% while the total read 92%. This groups
// c8's per-file `json-summary` entries into areas, prints the areas with the
// most uncovered lines, and checks floors that `coverage-baseline.json` sets for
// a few named areas.

import { relative, sep } from 'node:path'
import { isRecord } from '../../src/shared/unknown-value.mts'

export interface AreaCoverage {
  area: string
  covered: number
  total: number
  /** Line coverage in percent, two decimals; 100 for an area with no lines. */
  pct: number
  files: number
}

/**
 * Areas that get a floor when the baseline is updated. They are the layers
 * #4391 measured: the IPC handlers with almost no unit coverage, and the large
 * well-covered layers a regression would otherwise hide in.
 */
export const FLOORED_AREAS: readonly string[] = [
  'src/main/ipc',
  'src/main/services',
  'src/main/windows',
  'src/renderer/views',
  'src/shared/types',
]

/**
 * The area a repository-relative file belongs to: its first three path
 * segments (`src/main/services`), or the file itself when it sits higher up
 * (`src/main/index.ts`), so a large entry point is its own row.
 */
export function areaOf(file: string): string {
  const parts = file.split('/')
  return parts.length > 3 ? parts.slice(0, 3).join('/') : file
}

function round(pct: number): number {
  return Math.round(pct * 100) / 100
}

function lineCounts(entry: unknown): { covered: number; total: number } | null {
  if (!isRecord(entry) || !isRecord(entry['lines'])) return null
  const { covered, total } = entry['lines']
  return typeof covered === 'number' && typeof total === 'number' ? { covered, total } : null
}

/** Group a c8 `coverage-summary.json` by area, most uncovered lines first. */
export function summariseAreas(summary: Record<string, unknown>, root: string): AreaCoverage[] {
  const areas = new Map<string, { covered: number; total: number; files: number }>()
  for (const [path, entry] of Object.entries(summary)) {
    if (path === 'total') continue
    const counts = lineCounts(entry)
    if (!counts) continue
    const file = relative(root, path).split(sep).join('/')
    if (file.startsWith('..')) continue
    const area = areaOf(file)
    const sum = areas.get(area) ?? { covered: 0, total: 0, files: 0 }
    sum.covered += counts.covered
    sum.total += counts.total
    sum.files += 1
    areas.set(area, sum)
  }
  return [...areas]
    .map(([area, sum]) => ({
      area,
      ...sum,
      pct: sum.total === 0 ? 100 : round((sum.covered / sum.total) * 100),
    }))
    .sort((a, b) => b.total - b.covered - (a.total - a.covered) || a.area.localeCompare(b.area))
}

/** A Markdown table of the `limit` areas with the most uncovered lines. */
export function formatAreaTable(
  areas: readonly AreaCoverage[],
  floors: Readonly<Record<string, number>>,
  limit = 12,
): string {
  const rows = areas
    .slice(0, limit)
    .map(
      (area) =>
        `| \`${area.area}\` | ${String(area.total - area.covered)} | ${area.pct.toFixed(2)}% | ` +
        `${Object.hasOwn(floors, area.area) ? `${String(floors[area.area])}%` : ''} | ${String(area.files)} |`,
    )
  return [
    '| Area | Uncovered lines | Line coverage | Floor | Files |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows,
  ].join('\n')
}

/** Floors the measured areas fall below, beyond `tolerance`. A floored area that vanished is reported too. */
export function areaFloorFailures(
  areas: readonly AreaCoverage[],
  floors: Readonly<Record<string, number>>,
  tolerance: number,
): string[] {
  const byArea = new Map(areas.map((area) => [area.area, area]))
  const failures: string[] = []
  for (const [area, floor] of Object.entries(floors)) {
    const measured = byArea.get(area)
    if (!measured) {
      failures.push(`${area}: no files measured (floor ${String(floor)}%)`)
    } else if (measured.pct + tolerance < floor) {
      failures.push(`${area}: ${measured.pct.toFixed(2)}% is below its floor of ${String(floor)}%`)
    }
  }
  return failures
}

/** The floor `--update` writes for each floored area: `margin` points under the measured figure. */
export function updatedFloors(
  areas: readonly AreaCoverage[],
  margin: number,
  names: readonly string[] = FLOORED_AREAS,
): Record<string, number> {
  const floors: Record<string, number> = {}
  for (const name of names) {
    const area = areas.find((candidate) => candidate.area === name)
    if (area) floors[name] = Math.max(0, Math.floor((area.pct - margin) * 100) / 100)
  }
  return floors
}
