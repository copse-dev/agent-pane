// Extract the real shell commands an agent ran from YOUR local Copse store into a
// private dataset: one row per unique (working directory, command), with any
// Guarded YOLO outcome recorded for it. The output stays on this machine under the
// git-ignored bench-results/ directory; never commit it.
//
//   node benchmarks/escalation-review/scripts/extract.mjs [--copse-dir ~/.copse] [--out DIR]
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repository } from './guard.mjs'

/** Test-fixture projects that e2e and headless runs write into the same store. */
export const FIXTURE_PROJECT =
  /^(e2e-|headless-project-|proj-|project-|copse-apple-smoke$|tmp$|_global$)/
const SHELL_TOOLS = new Set(['run_shell', 'mcp__copse__run_shell'])

function readJsonLines(path) {
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A torn final line from a live writer is not evidence either way.
    }
  }
  return out
}

function gitRemotes(path, cache) {
  if (!path || !existsSync(path)) return []
  if (!cache.has(path)) {
    try {
      const out = execFileSync('git', ['-C', path, 'remote'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      cache.set(path, [...new Set(out.split(/\s+/).filter(Boolean))].sort())
    } catch {
      cache.set(path, [])
    }
  }
  return cache.get(path)
}

/** Rows keyed by working directory and command, from every non-fixture thread. */
export function extract(copseDir) {
  const workspace = join(copseDir, 'workspace')
  const config = JSON.parse(readFileSync(join(copseDir, 'user-data', 'config.json'), 'utf8'))
  const projectRoots = new Map(
    (config.projects ?? []).filter((p) => p.id && p.path).map((p) => [p.id, p.path]),
  )
  const rows = new Map()
  const remotes = new Map()
  for (const project of readdirSync(workspace)) {
    if (FIXTURE_PROJECT.test(project)) continue
    const projectDir = join(workspace, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const thread of readdirSync(projectDir)) {
      const events = join(projectDir, thread, 'events.jsonl')
      if (!existsSync(events)) continue
      let meta = {}
      try {
        meta = JSON.parse(readFileSync(join(projectDir, thread, 'meta.json'), 'utf8'))
      } catch {
        // Threads without metadata still carry their commands.
      }
      const projectRoot = projectRoots.get(project) ?? null
      const worktree = meta.worktree?.path ?? null
      const cwd = worktree ?? projectRoot
      const lines = readJsonLines(events)
      const outcomes = new Map()
      for (const line of lines) {
        if (line.type !== 'permission_decision' || typeof line.originalCommand !== 'string')
          continue
        const key = `${line.sandboxState}:${line.harmDecision}:${line.userResponse}`
        const counts = outcomes.get(line.originalCommand) ?? {}
        counts[key] = (counts[key] ?? 0) + 1
        outcomes.set(line.originalCommand, counts)
      }
      for (const line of lines) {
        for (const call of line.toolCalls ?? []) {
          if (!SHELL_TOOLS.has(call.name)) continue
          const command = call.args?.command
          if (typeof command !== 'string' || !command.trim()) continue
          const id = createHash('sha256').update(`${cwd}\0${command}`).digest('hex').slice(0, 16)
          const row = rows.get(id) ?? {
            id,
            command,
            cwd,
            projectRoot,
            worktree: Boolean(worktree),
            tool: call.name,
            occurrences: 0,
            threads: new Set(),
            recorded: {},
            configuredRemotes: gitRemotes(cwd, remotes),
          }
          row.occurrences += 1
          // A thread's Guarded YOLO outcomes for this command are counted once,
          // however many times the command appears in that thread.
          if (!row.threads.has(thread)) {
            for (const [key, count] of Object.entries(outcomes.get(command) ?? {})) {
              row.recorded[key] = (row.recorded[key] ?? 0) + count
            }
          }
          row.threads.add(thread)
          rows.set(id, row)
        }
      }
    }
  }
  return [...rows.values()].map(({ threads, ...row }) => ({ ...row, threads: threads.size }))
}

export async function main(argv = process.argv.slice(2)) {
  const option = (name, fallback) => {
    const index = argv.indexOf(name)
    return index === -1 ? fallback : argv[index + 1]
  }
  const copseDir = resolve(
    option('--copse-dir', process.env.COPSE_DIR ?? join(homedir(), '.copse')),
  )
  const out = resolve(
    option(
      '--out',
      join(repository, 'bench-results', 'escalation-review', new Date().toISOString().slice(0, 10)),
    ),
  )
  const rows = extract(copseDir)
  await mkdir(out, { recursive: true, mode: 0o700 })
  await writeFile(
    join(out, 'dataset.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    {
      mode: 0o600,
    },
  )
  const recorded = rows.filter((r) => Object.keys(r.recorded).length > 0).length
  console.log(
    `${rows.length} unique commands (${recorded} with a recorded Guarded YOLO outcome) -> ${out}`,
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
