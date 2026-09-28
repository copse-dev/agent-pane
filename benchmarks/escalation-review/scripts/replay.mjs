// Run Copse's deterministic shell analysis over an extracted dataset: scope
// verdict, auto-approval at each tier, the outside-read proof and the Guarded YOLO
// harm gate (with the gate's own script reader).
//
//   node benchmarks/escalation-review/scripts/replay.mjs <run-dir>
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyze, loadGuard } from './guard.mjs'

export async function replay(runDir) {
  const guard = await loadGuard()
  const rows = (await readFile(join(runDir, 'dataset.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const out = rows.map((row) => ({
    id: row.id,
    ...analyze(guard, row.command, row.cwd, { configuredRemotes: row.configuredRemotes }),
  }))
  await writeFile(
    join(runDir, 'deterministic.jsonl'),
    out.map((r) => JSON.stringify(r)).join('\n') + '\n',
    { mode: 0o600 },
  )
  return out
}

export async function main(argv = process.argv.slice(2)) {
  const [runDir] = argv
  if (!runDir) {
    console.error('Usage: replay.mjs <run-dir containing dataset.jsonl>')
    return 2
  }
  const out = await replay(runDir)
  const count = (pick) => out.reduce((m, r) => ({ ...m, [pick(r)]: (m[pick(r)] ?? 0) + 1 }), {})
  console.log(
    'scope',
    count((r) => r.scope),
  )
  console.log(
    'auto-approval (read tier)',
    count((r) => r.autoApproval.read ?? 'prompt'),
  )
  console.log(
    'harm gate',
    count((r) => r.harm),
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
