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
