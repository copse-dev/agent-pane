import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

function githubYamlFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...githubYamlFiles(path))
    } else if (/\.ya?ml$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function workflowJobBlocks(file: string): Array<{ name: string; text: string }> {
  const lines = readFileSync(file, 'utf8').split('\n')
  const blocks: Array<{ name: string; text: string }> = []
  let inJobs = false
  let currentName: string | undefined
  let currentLines: string[] = []

  const finishCurrent = (): void => {
    if (currentName !== undefined) blocks.push({ name: currentName, text: currentLines.join('\n') })
  }

  for (const line of lines) {
    if (line === 'jobs:') {
      inJobs = true
      continue
    }
    if (!inJobs) continue

    const jobHeader = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line)
    if (jobHeader?.[1] !== undefined) {
      finishCurrent()
      currentName = jobHeader[1]
      currentLines = [line]
    } else if (currentName !== undefined) {
      currentLines.push(line)
    }
  }

  finishCurrent()
  return blocks
}

test('every setup-node action uses .nvmrc as its version source', () => {
  let invocationCount = 0

  for (const file of githubYamlFiles('.github')) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]?.includes('uses: actions/setup-node@')) continue

      invocationCount++
      const location = `${file}:${String(index + 1)}`
      const step = lines.slice(index, index + 8).join('\n')
      assert.match(
        step,
        /node-version-file:\s*['"]?\.nvmrc['"]?/,
        `${location} must specify node-version-file: .nvmrc`,
      )
      assert.doesNotMatch(step, /node-version:\s*/, `${location} must not hardcode a Node version`)
    }
  }

  assert.ok(invocationCount > 0, 'expected at least one setup-node invocation under .github')
})

test('CI-built Node worker images receive their version from .nvmrc', () => {
  const workers = [
    {
      dockerfile: 'benchmarks/terminal_bench/Dockerfile.worker',
      workflow: '.github/workflows/terminal-bench-scaleway.yml',
    },
    {
      dockerfile: 'benchmarks/skillsbench/Dockerfile.worker',
      workflow: '.github/workflows/skillsbench-scaleway-spike.yml',
    },
  ]

  for (const worker of workers) {
    const dockerfile = readFileSync(worker.dockerfile, 'utf8')
    assert.match(dockerfile, /^ARG NODE_VERSION$/m)
    assert.match(dockerfile, /^FROM node:\$\{NODE_VERSION\}-bookworm-slim$/m)
    assert.doesNotMatch(dockerfile, /^FROM node:\d/m)

    const workflow = readFileSync(worker.workflow, 'utf8')
    assert.match(workflow, /version=\$\(cat \.nvmrc\)/)
    assert.match(
      workflow,
      /build-args: NODE_VERSION=\$\{\{ steps\.node-version\.outputs\.version \}\}/,
    )
  }
})

test('every workflow job that executes Node sets it up first', () => {
  const nodeCommand = /(^|[;&|()\s])(node|npm|npx|pnpm)(?=\s|$)/
  let nodeJobCount = 0

  for (const file of githubYamlFiles('.github/workflows')) {
    for (const job of workflowJobBlocks(file)) {
      const executableLines = job.text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n')
      const commandIndex = executableLines.search(nodeCommand)
      if (commandIndex === -1) continue

      nodeJobCount++
      const directSetupIndex = executableLines.indexOf('uses: actions/setup-node@')
      const compositeSetupIndex = executableLines.indexOf('uses: ./.github/actions/setup')
      const setupIndices = [directSetupIndex, compositeSetupIndex].filter((index) => index >= 0)
      const firstSetupIndex = setupIndices.length === 0 ? -1 : Math.min(...setupIndices)
      assert.ok(
        firstSetupIndex >= 0 && firstSetupIndex < commandIndex,
        `${file} job ${job.name} executes Node without setting it up first`,
      )
    }
  }

  assert.ok(nodeJobCount > 0, 'expected at least one workflow job that executes Node')
})
