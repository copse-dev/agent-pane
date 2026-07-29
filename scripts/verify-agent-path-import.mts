import * as esbuild from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const outputDir = await mkdtemp(resolve('dist-test/agent-path-import-'))
const entry = resolve(outputDir, 'entry.ts')
const bundle = resolve(outputDir, 'entry.cjs')

try {
  await writeFile(
    entry,
    `
      import { createRegistry } from ${JSON.stringify(resolve('src/main/services/registry-bootstrap.ts'))}
      import { buildSystemPrompt } from ${JSON.stringify(resolve('src/main/services/agent-system-prompt.ts'))}
      export { createRegistry, buildSystemPrompt }
    `,
  )

  await esbuild.build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: {
      '@shared': resolve('src/shared'),
      '@copse/agent': resolve('packages/agent/src'),
      '@copse/llm': resolve('packages/llm/src'),
      '@copse/plan-usage': resolve('packages/plan-usage/src'),
    },
    external: ['electron', 'node-pty', 'jsdom', '@mozilla/readability', 'turndown', 'mermaid'],
    logLevel: 'silent',
  })

  const childProgram = `
    const Module = require('node:module')
    const load = Module._load
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') throw new Error('Agent construction imported Electron')
      return load.call(this, request, parent, isMain)
    }
    void (async () => {
      const { createRegistry, buildSystemPrompt } = require(${JSON.stringify(bundle)})
      const registry = createRegistry()
      if (registry.names().length === 0) throw new Error('createRegistry returned no tools')
      const prompt = await buildSystemPrompt({ subagentsEnabled: false, invokedSkills: [] })
      if (prompt.length === 0) throw new Error('buildSystemPrompt returned an empty prompt')
    })()
  `
  const child = spawnSync(process.execPath, ['-e', childProgram], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  if (child.status !== 0) {
    const detail = [child.stdout, child.stderr].filter(Boolean).join('\n')
    throw new Error(`Plain-Node agent construction failed:\n${detail}`)
  }
} finally {
  await rm(outputDir, { recursive: true, force: true })
}
