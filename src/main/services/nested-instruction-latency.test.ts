import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  activateNestedInstructionSources,
  createNestedInstructionTurn,
} from './project-instructions.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { runWithWorkspaceTrust } from './security/workspace-trust.ts'

it('measures turn-start discovery against a 10,000-directory fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'copse-nested-latency-'))
  const restore = setWorkspaceRootForTest(root)
  try {
    for (let group = 0; group < 100; group++) {
      await Promise.all(
        Array.from({ length: 100 }, (_, leaf) =>
          mkdir(
            join(
              root,
              `group-${String(group).padStart(3, '0')}`,
              `leaf-${String(leaf).padStart(3, '0')}`,
            ),
            { recursive: true },
          ),
        ),
      )
    }
    await writeFile(join(root, 'group-000', 'AGENTS.md'), 'Use the scoped instructions.')
    const rounds = []
    for (let round = 0; round < 5; round++) {
      const turn = createNestedInstructionTurn()
      const activate = (): ReturnType<typeof activateNestedInstructionSources> =>
        runWithWorkspaceTrust(root, true, () =>
          activateNestedInstructionSources(
            ['group-000/leaf-000/example.ts'],
            new Set(),
            new Set(),
            0,
            turn,
          ),
        )
      const start = performance.now()
      const result = await activate()
      const firstMs = performance.now() - start
      assert.equal(result.injectedNames[0], 'group-000/AGENTS.md')
      const again = performance.now()
      await activate()
      rounds.push({ firstMs, memoMs: performance.now() - again })
    }
    console.log(
      'NESTED_INSTRUCTION_LATENCY',
      JSON.stringify({ platform: process.platform, node: process.version, rounds }),
    )
  } finally {
    restore()
    await rm(root, { recursive: true, force: true })
  }
})
