// Sample the Hugging Face sources blended into the test set, at pinned revisions,
// into sources/hf-*.jsonl. This is the only test-set script that uses the network;
// build, gates and scoring read the committed samples.
//
//   node benchmarks/escalation-review/testset/sample-hf.mjs
//
// - tomngdev/shell-safety-v2 (MIT): synthetic allow/ask/deny shell commands. POSIX rows of
//   the test split, stratified by (label, category). Its labels follow its own policy, so
//   they are kept as `sourceLabel` for comparison and never used as the reference tier.
// - westenfelder/NL2SH-ALFA (MIT): the manually verified natural-language-to-Bash test set.
//   Its working directory `/testbed` becomes the anonymised workspace.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TESTSET, WORKSPACE } from './paths.mjs'

export const SOURCES = {
  shellSafety: {
    dataset: 'tomngdev/shell-safety-v2',
    revision: '3258db497dae218f23d1d648ef2eb7cb6ab5e70c',
    file: 'test.jsonl',
    target: 160,
  },
  nl2sh: {
    dataset: 'westenfelder/NL2SH-ALFA',
    revision: 'a99cb5784cf5c2a42b1cc26c1903d9c3b35206ba',
    file: 'test.csv',
    perDifficulty: 40,
  },
}

const url = ({ dataset, revision, file }) =>
  `https://huggingface.co/datasets/${dataset}/resolve/${revision}/${file}`

/** The prepare.mjs LCG, so a sample is reproducible from the pinned revision alone. */
export function shuffle(items, seed = 7) {
  const out = [...items]
  let state = seed
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2 ** 31
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** RFC 4180 CSV: quoted fields may hold commas, newlines and doubled quotes. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field || row.length) rows.push([...row, field])
  const [header, ...body] = rows
  return body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ''])))
}

/** Stratified sample: every (label, category) group keeps its share, and at least one row. */
export function sampleShellSafety(rows, target) {
  const seen = new Set()
  const groups = new Map()
  rows.forEach((row, index) => {
    if (row.shell !== 'posix' || seen.has(row.command)) return
    seen.add(row.command)
    const key = `${row.label}/${row.category}`
    groups.set(key, [...(groups.get(key) ?? []), { ...row, index }])
  })
  const total = [...groups.values()].reduce((sum, group) => sum + group.length, 0)
  const picked = []
  for (const key of [...groups.keys()].sort()) {
    const group = shuffle(groups.get(key))
    picked.push(...group.slice(0, Math.max(1, Math.round((target * group.length) / total))))
  }
  return picked
    .sort((a, b) => a.index - b.index)
    .map((row) => {
      // The synthetic ssh user is the dataset author's handle; use the anonymised one.
      const command = row.command.replaceAll('tom@', 'dev@')
      return {
        id: `ss2-${String(row.index).padStart(4, '0')}`,
        source: `hf:${SOURCES.shellSafety.dataset}@${SOURCES.shellSafety.revision.slice(0, 12)}:test#${row.index}`,
        command,
        ...(command === row.command ? {} : { rewritten: true }),
        sourceLabel: row.label,
        sourceCategory: row.category,
        sourceReason: row.reason,
      }
    })
}

export function sampleNl2sh(rows, perDifficulty) {
  const seen = new Set()
  const picked = []
  for (const difficulty of ['0', '1', '2']) {
    const pool = rows
      .map((row, index) => ({ ...row, index }))
      .filter((row) => row.difficulty === difficulty && row.bash.trim())
    let taken = 0
    for (const row of shuffle(pool)) {
      if (taken === perDifficulty) break
      if (seen.has(row.bash)) continue
      seen.add(row.bash)
      picked.push(row)
      taken++
    }
  }
  return picked
    .sort((a, b) => a.index - b.index)
    .map((row) => {
      const command = row.bash.replaceAll('/testbed', WORKSPACE)
      return {
        id: `nl2sh-${String(row.index).padStart(4, '0')}`,
        source: `hf:${SOURCES.nl2sh.dataset}@${SOURCES.nl2sh.revision.slice(0, 12)}:test#${row.index}`,
        command,
        ...(command === row.bash ? {} : { rewritten: true }),
        instruction: row.nl.replaceAll('/testbed', WORKSPACE),
        difficulty: Number(row.difficulty),
      }
    })
}

async function download(source) {
  const response = await fetch(url(source))
  if (!response.ok) throw new Error(`${url(source)}: HTTP ${response.status}`)
  return response.text()
}

export async function main() {
  const shellSafety = sampleShellSafety(
    (await download(SOURCES.shellSafety))
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)),
    SOURCES.shellSafety.target,
  )
  const nl2sh = sampleNl2sh(parseCsv(await download(SOURCES.nl2sh)), SOURCES.nl2sh.perDifficulty)
  const write = (name, rows) =>
    writeFile(
      join(TESTSET, 'sources', name),
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    )
  await write('hf-shell-safety-v2.jsonl', shellSafety)
  await write('hf-nl2sh-alfa.jsonl', nl2sh)
  console.log(`shell-safety-v2: ${shellSafety.length} rows; NL2SH-ALFA: ${nl2sh.length} rows`)
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
