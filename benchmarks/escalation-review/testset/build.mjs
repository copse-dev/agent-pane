// Assemble the public command test set from its anonymised sources and reference labels.
//
//   node benchmarks/escalation-review/testset/build.mjs [--check]
//   node benchmarks/escalation-review/testset/build.mjs --batches <dir> [--batch-size 100]
//
// Sources, all anonymised to the regression set's machine (home /Users/dev, workspace
// /Users/dev/project):
// - regression: every case in ../regression/cases.jsonl, with its script files and hosts;
// - shell-scope: the 200-command corpus in benchmarks/shell-scope, paths moved onto the
//   anonymised machine, keeping its reviewed sandbox/external label and dev/holdout split;
// - authored: sources/authored.jsonl, written for this set;
// - hf: sources/hf-*.jsonl, sampled by sample-hf.mjs.
// - history: sources/history-*.jsonl, anonymised slices of real history from
//   import-history.mjs, always in the holdout split.
//
// labels.jsonl holds the reference tier for every row (rubric.md). The build writes
// cases.jsonl and fixtures/tier-{dev,holdout}.jsonl for `pnpm run eval:classifier`. With
// --check it only verifies those files are current. --batches writes blind labelling rows.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TIER_QUESTION } from '../scripts/prepare.mjs'
import { TIERS } from '../scripts/score.mjs'
import { loadCases } from '../regression/run.mjs'
import { HOME, TESTSET, WORKSPACE } from './paths.mjs'

const SHELL_SCOPE_CORPUS = resolve(TESTSET, '../../shell-scope/inputs/corpus.jsonl')
const SPLITS = ['dev', 'holdout']

export const jsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))

/** The shell-scope corpus's fixture machine, moved onto the anonymised one. */
export function relocateShellScope(command) {
  return command
    .replaceAll('/workspace/project', WORKSPACE)
    .replaceAll('/workspace/other', `${HOME}/other`)
    .replaceAll('/home/user', HOME)
}

// Heads whose subcommand, not the program, decides what the command does.
const SUBCOMMAND_HEADS = new Set([
  'git',
  'gh',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'brew',
  'aws',
  'gcloud',
  'launchctl',
  'security',
  'defaults',
])

/** The command family that keeps near-duplicates in one split. */
export function family(command) {
  const words = command
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/u, '')
    .split(/\s+/u)
  const head = (words[0] ?? '').replace(/^.*\//u, '')
  const sub = words.slice(1).find((word) => !word.startsWith('-'))
  return SUBCOMMAND_HEADS.has(head) && sub ? `${head} ${sub}` : head
}

export function splitFor(key) {
  return SPLITS[createHash('sha256').update(key).digest()[0] % 2]
}

/** Every row of the test set before labels: what a labeller or approver may see, plus provenance. */
export function collect() {
  const rows = []
  for (const c of loadCases()) {
    rows.push({
      id: `reg-${c.id}`,
      source: 'regression',
      command: c.command,
      workspace: Object.hasOwn(c, 'workspace') ? c.workspace : WORKSPACE,
      ...(c.files ? { files: c.files } : {}),
      ...(c.trustedSshHosts ? { trustedSshHosts: c.trustedSshHosts } : {}),
      ...(c.expect.scope ? { scope: c.expect.scope } : {}),
    })
  }
  const [corpus] = jsonl(SHELL_SCOPE_CORPUS)
  for (const c of corpus.cases) {
    rows.push({
      id: `scope-${c.id}`,
      source: 'shell-scope',
      command: relocateShellScope(c.command),
      workspace: WORKSPACE,
      scope: c.label,
      split: c.split,
    })
  }
  for (const c of jsonl(join(TESTSET, 'sources', 'authored.jsonl'))) {
    rows.push({ ...c, source: 'authored', workspace: c.workspace ?? WORKSPACE })
  }
  for (const name of ['hf-shell-safety-v2.jsonl', 'hf-nl2sh-alfa.jsonl']) {
    for (const c of jsonl(join(TESTSET, 'sources', name))) rows.push({ ...c, workspace: WORKSPACE })
  }
  // Anonymised slices of real history join the holdout only, in the order they were taken,
  // so no prompt, threshold or gate rule is ever chosen on them before they are scored.
  const history = readdirSync(join(TESTSET, 'sources'))
    .filter((name) => /^history-[\w.-]+\.jsonl$/.test(name))
    .sort()
  for (const name of history) {
    for (const c of jsonl(join(TESTSET, 'sources', name))) {
      rows.push({ ...c, workspace: WORKSPACE, split: 'holdout' })
    }
  }
  return rows.map((row) => ({ ...row, split: row.split ?? splitFor(family(row.command)) }))
}

/** What a blind labeller sees: no source, source label or split. */
export function blind(row) {
  return {
    id: row.id,
    workspace: row.workspace,
    projectRoot: row.workspace,
    command: row.command,
    ...(row.files ? { files: row.files } : {}),
    ...(row.trustedSshHosts ? { trustedSshHosts: row.trustedSshHosts } : {}),
  }
}

export function fixture(row) {
  return {
    id: row.id,
    state: {
      workspace: row.workspace ?? 'unknown',
      projectRoot: row.workspace ?? 'unknown',
      command: row.command,
      ...(row.files ? { files: row.files } : {}),
      ...(row.trustedSshHosts ? { trustedSshHosts: row.trustedSshHosts } : {}),
    },
    questions: { tier: TIER_QUESTION },
    expected: { tier: row.tier, ...(row.scope ? { scope: row.scope } : {}) },
  }
}

export function build() {
  const rows = collect()
  const ids = new Set()
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`Duplicate test-set id ${row.id}`)
    ids.add(row.id)
  }
  const labels = new Map(jsonl(join(TESTSET, 'labels.jsonl')).map((label) => [label.id, label]))
  for (const id of labels.keys()) {
    if (!ids.has(id)) throw new Error(`labels.jsonl names ${id}, which no source provides`)
  }
  const cases = rows.map((row) => {
    const label = labels.get(row.id)
    if (!label) throw new Error(`${row.id} has no reference label`)
    if (!TIERS.includes(label.tier)) throw new Error(`${row.id}: unknown tier ${label.tier}`)
    return {
      ...row,
      tier: label.tier,
      effects: label.effects,
      rationale: label.rationale,
      labellers: label.labellers,
    }
  })
  const line = (value) => JSON.stringify(value)
  const text = (values) => values.map(line).join('\n') + '\n'
  return {
    'cases.jsonl': text(cases),
    ...Object.fromEntries(
      SPLITS.map((split) => [
        `fixtures/tier-${split}.jsonl`,
        text(cases.filter((c) => c.split === split).map(fixture)),
      ]),
    ),
  }
}

/** Deterministic shuffle (prepare.mjs's) so batches mix sources for the labeller. */
function shuffled(rows) {
  const out = [...rows].sort((a, b) => a.id.localeCompare(b.id))
  let seed = 11
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31
    const j = seed % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function writeBatches(dir, size = 100) {
  mkdirSync(dir, { recursive: true })
  const rows = shuffled(collect()).map(blind)
  let n = 0
  for (let i = 0; i < rows.length; i += size, n++) {
    writeFileSync(
      join(dir, `batch-${String(n).padStart(2, '0')}.jsonl`),
      rows
        .slice(i, i + size)
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    )
  }
  return n
}

export function main(argv = process.argv.slice(2)) {
  const batchIndex = argv.indexOf('--batches')
  if (batchIndex !== -1) {
    const sizeIndex = argv.indexOf('--batch-size')
    const count = writeBatches(
      argv[batchIndex + 1],
      sizeIndex === -1 ? 100 : Number(argv[sizeIndex + 1]),
    )
    console.log(`${count} blind labelling batches`)
    return 0
  }
  const outputs = build()
  const stale = Object.entries(outputs).filter(([name, content]) => {
    try {
      return readFileSync(join(TESTSET, name), 'utf8') !== content
    } catch {
      return true
    }
  })
  if (argv.includes('--check')) {
    for (const [name] of stale) console.error(`${name} is stale: run testset/build.mjs`)
    return stale.length ? 1 : 0
  }
  mkdirSync(join(TESTSET, 'fixtures'), { recursive: true })
  for (const [name, content] of stale) writeFileSync(join(TESTSET, name), content)
  const cases = jsonl(join(TESTSET, 'cases.jsonl'))
  const count = (pick) => cases.reduce((m, c) => ({ ...m, [pick(c)]: (m[pick(c)] ?? 0) + 1 }), {})
  console.log(
    `${cases.length} cases`,
    count((c) => c.split),
  )
  console.log(
    'by source',
    count((c) => c.source.replace(/@.*/u, '')),
  )
  console.log(
    'by tier',
    count((c) => c.tier),
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main()
}
