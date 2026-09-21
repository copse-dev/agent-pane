import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const REPO_ROOT = process.cwd()
const CHILD_FILTER = 'scripts/lib/test-filter.test.ts'

type ChildResult = {
  code: number | null
  output: string
}

function runChild(
  extraEnvironment: Record<string, string> = {},
  filter = CHILD_FILTER,
): Promise<ChildResult> {
  return new Promise((resolveResult) => {
    const childEnv = { ...process.env }
    delete childEnv['NODE_TEST_CONTEXT']
    const child = spawn(process.execPath, ['scripts/run-tests.mts', filter], {
      cwd: REPO_ROOT,
      env: {
        ...childEnv,
        CI: '1',
        COPSE_TEST_KEEP_OUTPUT: '1',
        ...extraEnvironment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('close', (code) => {
      resolveResult({ code, output })
    })
  })
}

function isRunMetadata(value: unknown): value is {
  error: null
  outputDir: string
  reportPublished: boolean
  status: number
} {
  if (typeof value !== 'object' || value === null) return false
  if (
    !('error' in value) ||
    !('outputDir' in value) ||
    !('reportPublished' in value) ||
    !('status' in value)
  )
    return false
  return (
    value.error === null &&
    typeof value.outputDir === 'string' &&
    typeof value.reportPublished === 'boolean' &&
    typeof value.status === 'number'
  )
}

function outputDirectory(output: string): string {
  const match = output.match(/\[run-tests\] output directory: (.+)/)
  const directory = match?.[1]
  assert.ok(directory, `child did not report its output directory:\n${output}`)
  return directory
}

describe('normal test runner output isolation', () => {
  it('allows two filtered processes to bundle and complete concurrently', async () => {
    if (process.env['COPSE_TEST_FORCE_FAILURE'] === '1') {
      assert.fail('controlled runner failure')
    }
    const results = await Promise.all([runChild(), runChild()])
    const outputDirectories: string[] = []
    try {
      for (const result of results) {
        assert.equal(result.code, 0, result.output)
        outputDirectories.push(outputDirectory(result.output))
      }
      assert.equal(new Set(outputDirectories).size, 2)

      for (const directory of outputDirectories) {
        const metadataPath = join(directory, 'run-meta.json')
        const tapPath = join(directory, 'unit-tests.tap')
        assert.equal((await stat(metadataPath)).isFile(), true)
        assert.equal((await stat(tapPath)).isFile(), true)
        const metadata: unknown = JSON.parse(await readFile(metadataPath, 'utf8'))
        assert.ok(isRunMetadata(metadata))
        assert.equal(metadata.outputDir, directory)
        assert.equal(metadata.status, 0)
        assert.equal(metadata.reportPublished, true)
        assert.match(await readFile(tapPath, 'utf8'), /# pass [1-9]/)
      }

      const failed = await runChild(
        { COPSE_TEST_FORCE_FAILURE: '1' },
        'scripts/run-tests-concurrency.test.ts',
      )
      assert.notEqual(failed.code, 0, failed.output)
      const failedDirectory = outputDirectory(failed.output)
      outputDirectories.push(failedDirectory)
      const failedTap = await readFile(join(failedDirectory, 'unit-tests.tap'), 'utf8')
      assert.match(failedTap, /# fail 1/)
      assert.match(failedTap, /controlled runner failure/)
      const canonicalTap = await readFile(join(REPO_ROOT, 'unit-tests.tap'), 'utf8')
      assert.match(canonicalTap, /# fail 1/)
      assert.match(canonicalTap, /controlled runner failure/)
    } finally {
      await Promise.all(outputDirectories.map((directory) => rm(directory, { recursive: true })))
    }
  })
})
