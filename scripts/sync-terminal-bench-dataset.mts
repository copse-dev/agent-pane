import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const sourceFlag = process.argv.indexOf('--source')
const source = sourceFlag >= 0 ? process.argv[sourceFlag + 1] : undefined
if (!source) {
  throw new Error(
    'Pass --source <terminal-bench-2-1 checkout> to regenerate the pinned dataset descriptor.',
  )
}

const sourceRoot = resolve(source)
const tasksRoot = join(sourceRoot, 'tasks')
const upstreamRevision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()

const tasks = readdirSync(tasksRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const path = join(tasksRoot, entry.name, 'task.toml')
    const contents = readFileSync(path)
    const text = contents.toString('utf8')
    const image = text.match(/^docker_image\s*=\s*"([^"]+)"\s*$/m)?.[1]
    if (!image) throw new Error(`Task ${entry.name} does not declare environment.docker_image.`)
    return {
      name: entry.name,
      image,
      configSha256: createHash('sha256').update(contents).digest('hex'),
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

if (tasks.length !== 89) {
  throw new Error(`Expected 89 Terminal-Bench 2.1 tasks, found ${String(tasks.length)}.`)
}

const descriptor = {
  schemaVersion: 1,
  datasetId: 'terminal-bench/terminal-bench-2-1',
  datasetVersion: '2.1',
  upstreamRepository: 'harbor-framework/terminal-bench-2-1',
  upstreamRevision,
  tasks,
}
const target = resolve('benchmarks/terminal_bench/datasets/terminal-bench-2.1.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${JSON.stringify(descriptor, null, 2)}\n`)
console.log(`Wrote ${String(tasks.length)} tasks from ${upstreamRevision} to ${target}`)
