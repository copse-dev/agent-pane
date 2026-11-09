import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { accessSync, mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: { help: { type: 'boolean' }, run: { type: 'string' } },
})
if (values.help) {
  console.log(
    'After quitting the owned Copse app:\nnode .agents/skills/copse-dogfood/scripts/export-thread.mts --run /absolute/path/to/run\nExports all dogfood-reading-list threads into a fresh evidence/export-* directory.',
  )
  process.exit(0)
}
if (!values.run) throw new Error('Pass --run for the isolated journey directory.')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const run = resolve(values.run)
const workspace = join(run, 'profile/workspace')
accessSync(join(workspace, 'dogfood-reading-list'))
const evidence = join(run, 'evidence')
mkdirSync(evidence, { recursive: true })
const output = mkdtempSync(join(evidence, 'export-'))
const helper = join(output, 'export.cjs')
await build({
  absWorkingDir: repo,
  stdin: {
    contents: `import { configureThreadStore } from './packages/thread-store/src/environment.ts'
import { loadProjectThreads } from './packages/thread-store/src/thread-store.ts'
import { threadToJsonl } from './src/shared/threads/export-jsonl.ts'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
async function main() {
  const [workspace, output] = process.argv.slice(2)
  if (!workspace || !output) throw new Error('Missing export arguments')
  configureThreadStore({ workspaceRoot: () => workspace })
  const threads = await loadProjectThreads('dogfood-reading-list')
  if (threads.length === 0) throw new Error('No threads found; this is not a completed live run.')
  const exports = []
  for (const thread of threads) {
    const trace = join(output, thread.id + '.jsonl')
    writeFileSync(trace, threadToJsonl(thread))
    cpSync(join(workspace, 'dogfood-reading-list', thread.id), join(output, thread.id + '-raw'), { recursive: true })
    exports.push({ threadId: thread.id, trace, messages: thread.messages.length })
  }
  writeFileSync(join(output, 'index.json'), JSON.stringify(exports, null, 2) + '\\n')
  console.log(JSON.stringify({ output, exports }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })`,
    resolveDir: repo,
  },
  outfile: helper,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
  tsconfig: join(repo, 'tsconfig.node.json'),
})
execFileSync(process.execPath, [helper, workspace, output], {
  cwd: repo,
  env: { ...process.env, COPSE_DIR: join(run, 'profile'), COPSE_WORKSPACE_DIR: workspace },
  stdio: 'inherit',
})
