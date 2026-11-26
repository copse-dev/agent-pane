// Add the deterministic gates' verdicts to generated rows, so the red-team and adversarial
// studies can be rerun from their committed generators.
//
//   node benchmarks/risk-classifier/join_verdicts.mjs <rows.jsonl> --main <checkout of main> \
//     --out <joined.jsonl>
//
// Each row keeps its fields and gains `harm` and `scope` from this checkout's gates and
// `harm_main` from the main checkout's (a `git worktree add` of origin/main works), the gate
// before this study's rules. A row's `files` are written into a throwaway workspace first, so
// the gates read the scripts the row ships; `/Users/dev` in a command points at that home.
//
// The red-team set (`redteam_gen.py`) feeds `host-train.sh --family-holdout`; the adversarial
// set (#4531's generator) feeds `host-train.sh --adversarial`. Both read the joined file from
// bench-results/risk-classifier/data/.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const input = args.find((arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'))
const main = flag('--main')
const out = flag('--out')
if (!input || !main || !out) {
  console.error(
    'Usage: join_verdicts.mjs <rows.jsonl> --main <checkout of main> --out <joined.jsonl>',
  )
  process.exit(2)
}

/** Load a checkout's own guard bundle, so each side judges with its own source. */
async function guardFrom(checkout) {
  const module = await import(
    pathToFileURL(resolve(checkout, 'benchmarks/escalation-review/scripts/guard.mjs')).href
  )
  return { analyze: module.analyze, guard: await module.loadGuard() }
}

const repo = resolve(import.meta.dirname, '../..')
const here = await guardFrom(repo)
const before = await guardFrom(main)

const rows = (await readFile(input, 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

// Not the OS temp directory: under /var the harm gate reads every redirect as a write into a
// system tree, which would turn ordinary rows into prompts.
const scratch = join(repo, 'bench-results/risk-classifier/tmp')
await mkdir(scratch, { recursive: true })
const joined = []
for (const row of rows) {
  const root = await mkdtemp(join(scratch, 'join-'))
  const home = join(root, 'Users/dev')
  const workspace = (row.workspace ?? '/Users/dev/project').replace(/^\/Users\/dev/, home)
  await mkdir(workspace, { recursive: true })
  for (const [path, text] of Object.entries(row.files ?? {})) {
    const target = resolve(workspace, path.replace(/^(?:~|\/Users\/dev)\//, `${home}/`))
    if (!target.startsWith(`${root}/`)) continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, text, { mode: 0o755 })
  }
  const command = row.command.replaceAll('/Users/dev', home)
  const options = { homeDir: home }
  const now = here.analyze(here.guard, command, workspace, options)
  const then = before.analyze(before.guard, command, workspace, options)
  joined.push({ ...row, harm: now.harm, scope: now.scope, harm_main: then.harm })
  await rm(root, { recursive: true, force: true })
}

await writeFile(out, joined.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
const misses = (key) => joined.filter((row) => row.label !== 'safe' && row[key] === 'allow').length
console.log(
  `${joined.length} rows; must-ask rows allowed: ${misses('harm_main')} by main, ${misses('harm')} by this checkout`,
)
