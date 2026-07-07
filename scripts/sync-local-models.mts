// Regenerates packages/llm/src/local-model-benchmarks.generated.ts from public
// benchmark leaderboards. Companion to sync-model-catalog.mts (cloud pricing from
// LiteLLM); this one seeds *measured* benchmark scores for the local models in
// packages/llm/src/local-model-catalog.ts.
//
// Design notes:
//   - We record only MEASURED facts (value + source URL + date + the precision it
//     was measured at). We do NOT estimate here — turning a full-precision number
//     into an on-device 4-bit estimate is a runtime concern (quant-penalty.ts),
//     kept separate so the sync stays purely factual.
//   - Coverage is sparse for small local models, so — unlike the cloud sync — a
//     model simply absent from a leaderboard is NOT an error; we fill what we can.
//   - Leaderboard model names never match our catalog ids, so an explicit ALIASES
//     map is the join. Extend it (and re-run) to cover more models/benchmarks.
//
// Run locally:  npm run sync:local-models
//
// Sources (both Aider leaderboards share the same YAML shape; `pass_rate_2` is
// the headline pass rate):
//   aider-polyglot — Aider-AI/aider → aider/website/_data/polyglot_leaderboard.yml
//                    (multi-language diff edits; entries are full-precision API runs)
//   aider-edit     — Aider-AI/aider → aider/website/_data/edit_leaderboard.yml
//                    (Python Exercism; includes real `ollama/*` GGUF quantized runs)

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const GENERATED_PATH = resolve('packages/llm/src/local-model-benchmarks.generated.ts')

const RAW_BASE = 'https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data'

// Each Aider board → the benchmark id it populates.
const AIDER_BOARDS: ReadonlyArray<{ benchmark: string; url: string }> = [
  { benchmark: 'aider-polyglot', url: `${RAW_BASE}/polyglot_leaderboard.yml` },
  { benchmark: 'aider-edit', url: `${RAW_BASE}/edit_leaderboard.yml` },
]

// leaderboard model name → our catalog id, the benchmark it feeds, and the bits
// per weight it was measured at (16 = full-precision API run; ~4.5 = a Q4_K_M
// GGUF run). Prefer a quantized entry over an fp16 one for the same
// (model, benchmark) — it's the on-device truth. Extend this to widen coverage;
// a leaderboard name with no entry here is ignored.
const ALIASES: ReadonlyArray<{
  leaderboardModel: string
  catalogId: string
  benchmark: string
  measuredBitsPerWeight: number
}> = [
  {
    leaderboardModel: 'Qwen2.5-Coder-32B-Instruct',
    catalogId: 'qwen/qwen2.5-coder-32b',
    benchmark: 'aider-polyglot',
    measuredBitsPerWeight: 16,
  },
  {
    // Real Q4_K_M GGUF run — a measured on-device number, no estimate needed.
    leaderboardModel: 'ollama/qwen2.5-coder:32b',
    catalogId: 'qwen/qwen2.5-coder-32b',
    benchmark: 'aider-edit',
    measuredBitsPerWeight: 4.5,
  },
]

interface Score {
  value: number
  source: string
  asOf: string
  measuredBitsPerWeight: number
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`[sync-local-models] GET ${url} → ${String(res.status)} ${res.statusText}`)
  }
  return res.text()
}

// Aider's leaderboards are a YAML list of flat records (`- key: value` then
// indented `  key: value`, all scalars). We only need a few keys, so a tiny
// line parser avoids a YAML dependency. A record starts at a top-level `- `.
function parseAiderRecords(yaml: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = []
  let current: Record<string, string> | null = null
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '') continue
    const startMatch = /^-\s+([A-Za-z0-9_]+):\s?(.*)$/.exec(line)
    const fieldMatch = /^\s+([A-Za-z0-9_]+):\s?(.*)$/.exec(line)
    if (startMatch) {
      current = {}
      records.push(current)
      current[startMatch[1] as string] = unquote(startMatch[2] as string)
    } else if (fieldMatch && current) {
      current[fieldMatch[1] as string] = unquote(fieldMatch[2] as string)
    }
  }
  return records
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isIsoDate(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Best (highest pass_rate_2) record per aliased model for one Aider board. */
function collectFromBoard(
  records: Array<Record<string, string>>,
  benchmark: string,
  today: string,
): Map<string, Score> {
  const byCatalogId = new Map<string, Score>()
  for (const alias of ALIASES) {
    if (alias.benchmark !== benchmark) continue
    const matching = records.filter((r) => r['model'] === alias.leaderboardModel)
    let best: Score | null = null
    for (const rec of matching) {
      const rate = Number(rec['pass_rate_2'])
      if (!Number.isFinite(rate)) continue
      const dateField = isIsoDate(rec['date'])
        ? rec['date']
        : isIsoDate(rec['_released'])
          ? rec['_released']
          : today
      if (!best || rate > best.value) {
        best = {
          value: rate,
          source: `Aider ${benchmark.replace('aider-', '')} leaderboard (${alias.leaderboardModel})`,
          asOf: dateField,
          measuredBitsPerWeight: alias.measuredBitsPerWeight,
        }
      }
    }
    if (best) byCatalogId.set(alias.catalogId, best)
  }
  return byCatalogId
}

function renderFile(scoresByModel: Map<string, Map<string, Score>>, today: string): string {
  const modelIds = [...scoresByModel.keys()].sort()
  const body = modelIds
    .map((id) => {
      const benchmarks = scoresByModel.get(id)
      if (!benchmarks) throw new Error(`[sync-local-models] missing scores for '${id}'`)
      const inner = [...benchmarks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([bench, s]) =>
            `    '${bench}': { value: ${String(s.value)}, source: '${s.source.replace(/'/g, "\\'")}', asOf: '${s.asOf}', measuredBitsPerWeight: ${String(s.measuredBitsPerWeight)} },`,
        )
        .join('\n')
      return `  '${id}': {\n${inner}\n  },`
    })
    .join('\n')
  return `// AUTO-GENERATED by scripts/sync-local-models.mts. Do not edit by hand.
// Measured benchmark scores for local models, keyed by catalog id. Empty keys
// mean "not yet in any tracked leaderboard", not zero. See the script header for
// sources and the ALIASES join.
// Last synced: ${today}

export interface LocalBenchmarkScore {
  value: number
  source: string
  asOf: string
  measuredBitsPerWeight: number
}

export const LOCAL_MODEL_BENCHMARKS: Record<string, Record<string, LocalBenchmarkScore>> = {
${body}
}
`
}

function runPrettier(): void {
  execFileSync('npx', ['prettier', '--write', GENERATED_PATH], { stdio: 'inherit' })
}

async function main(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const scoresByModel = new Map<string, Map<string, Score>>()

  for (const board of AIDER_BOARDS) {
    const yaml = await fetchText(board.url)
    const collected = collectFromBoard(parseAiderRecords(yaml), board.benchmark, today)
    for (const [catalogId, score] of collected) {
      const map = scoresByModel.get(catalogId) ?? new Map<string, Score>()
      map.set(board.benchmark, score)
      scoresByModel.set(catalogId, map)
    }
  }

  const content = renderFile(scoresByModel, today)
  const existing = await readFile(GENERATED_PATH, 'utf8').catch(() => '')
  const stripSyncDate = (s: string): string =>
    s.replace(/\/\/ Last synced: \d{4}-\d{2}-\d{2}\n/, '')
  if (stripSyncDate(existing) === stripSyncDate(content)) {
    console.log(
      `[sync-local-models] No changes (${String(scoresByModel.size)} models with scores).`,
    )
    return
  }
  await writeFile(GENERATED_PATH, content, 'utf8')
  runPrettier()
  console.log(
    `[sync-local-models] Wrote scores for ${String(scoresByModel.size)} model(s) to ${GENERATED_PATH} (synced ${today}).`,
  )
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
