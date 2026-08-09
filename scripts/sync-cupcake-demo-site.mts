import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LANDING_TRACE } from '../src/shared/demo-traces/landing.ts'
import { isRecord } from '../src/shared/unknown-value.mts'

const targetDirectory = resolve('src/shared/demo-sites/cupcakes')
const expectedPaths = ['index.html', 'styles.css', 'script.js'] as const

function traceFiles(): Map<string, string> {
  const files = new Map<string, string>()
  for (const { chunk } of LANDING_TRACE.steps) {
    if (chunk.type !== 'tool_call' || chunk.toolCall.name !== 'write_file') continue
    const args = chunk.toolCall.args
    if (!isRecord(args)) {
      throw new Error(`write_file ${chunk.toolCall.id} has invalid arguments`)
    }
    const path = args['path']
    const content = args['content']
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new Error(`write_file ${chunk.toolCall.id} must contain string path and content fields`)
    }
    if (files.has(path)) throw new Error(`landing trace writes ${path} more than once`)
    files.set(path, content)
  }
  assertExpectedPaths(files.keys())
  return files
}

function assertExpectedPaths(paths: Iterable<string>): void {
  const actual = [...paths].sort()
  const expected = [...expectedPaths].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `cupcake demo must contain exactly ${expected.join(', ')}; found ${actual.join(', ')}`,
    )
  }
}

function check(files: ReadonlyMap<string, string>): void {
  assertExpectedPaths(readdirSync(targetDirectory))
  for (const [path, expected] of files) {
    const actual = readFileSync(resolve(targetDirectory, path), 'utf8')
    if (actual !== expected) {
      throw new Error(
        `${path} differs from the Codex ACP landing trace; run npm run demo:site:sync`,
      )
    }
  }
  console.log('Cupcake site matches the recorded Codex ACP writes')
}

function sync(files: ReadonlyMap<string, string>): void {
  mkdirSync(targetDirectory, { recursive: true })
  for (const [path, content] of files) writeFileSync(resolve(targetDirectory, path), content)
  console.log(`Wrote ${String(files.size)} cupcake demo files to ${targetDirectory}`)
}

const files = traceFiles()
if (process.argv.includes('--check')) check(files)
else sync(files)
