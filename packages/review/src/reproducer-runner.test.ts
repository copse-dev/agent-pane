import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHostProcessBackend } from './host-process-backend.ts'
import { cellEnvironment, type ExecutionCell } from './isolation.ts'
import { createVerifierToolExecutor, type VerifierToolExecutor } from './verifier-tools.ts'

describe('supported reproducer runner', () => {
  let scratch: string
  let head: string
  let base: string
  let cell: ExecutionCell

  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'review-ts-repro-'))
    head = join(scratch, 'head')
    base = join(scratch, 'base')
    const esbuild = dirname(createRequire(import.meta.url).resolve('esbuild/package.json'))
    for (const [root, value] of [
      [head, 2],
      [base, 1],
    ] as const) {
      await mkdir(join(root, 'src'), { recursive: true })
      await mkdir(join(root, 'node_modules'))
      await symlink(esbuild, join(root, 'node_modules/esbuild'), 'junction')
      await writeFile(join(root, 'package.json'), '{"type":"commonjs"}')
      await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { paths: { '@fixture/*': ['./src/*'] } } }),
      )
      await writeFile(join(root, 'src/value.ts'), `export const value: number = ${String(value)}\n`)
    }
    cell = await createHostProcessBackend().createCell({
      checkouts: { head, base },
      scratchDir: scratch,
      readOnlyPaths: [],
      env: cellEnvironment(process.env),
    })
  })

  after(async () => {
    await cell.destroy()
    await rm(scratch, { recursive: true, force: true })
  })

  function executor(shellDecision: 'allow' | 'deny' = 'allow'): VerifierToolExecutor {
    return createVerifierToolExecutor({
      headCheckout: head,
      baseCheckout: base,
      cell,
      shellDecision,
      prepareBase: () => Promise.resolve(),
      scrub: (text) => text,
      context: {
        mergeBase: 'a'.repeat(40),
        headCommit: 'b'.repeat(40),
        dirtyWorkingTree: false,
        files: [],
        instructions: [],
        testMap: [],
        budgetChars: 0,
        usedChars: 0,
      },
    })
  }

  it('runs a TS behavioral test on both old revisions, resolving aliases and external packages', async () => {
    const tools = executor()
    const result = await tools.execute(
      'write_reproducer',
      {
        path: '.copse-review/value.test.ts',
        argv: ['copse-test'],
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { transformSync } from 'esbuild';",
          "import { value } from '@fixture/value';",
          "test('value remains one', () => {",
          "  assert.ok(transformSync('const n: number = 1', { loader: 'ts' }).code);",
          '  assert.equal(value, 1);',
          '});',
        ].join('\n'),
      },
      new AbortController().signal,
      'ts-proof',
    )
    assert.match(result, /exit codes separate head from base/)
    assert.equal(tools.reproducer()?.head.exitCode, 1)
    assert.equal(tools.reproducer()?.base.exitCode, 0)
    assert.match(tools.reproducer()?.head.output ?? '', /2 !== 1/)
    assert.match(result, /not confirmation/)
    assert.deepEqual(await readdir(join(base, '.copse-review')), [])
    assert.deepEqual(await readdir(join(head, '.copse-review')), ['value.test.ts'])
  })

  it('identifies setup failures on both revisions without claiming a reproduction', async () => {
    const tools = executor()
    await tools.execute(
      'write_reproducer',
      {
        path: '.copse-review/missing.test.ts',
        argv: ['copse-test'],
        content: "import '../does-not-exist.ts'",
      },
      new AbortController().signal,
      'bad-import',
    )
    const run = tools.reproducer()
    assert.ok(run)
    assert.equal(run.separates, false)
    assert.equal(run.head.exitCode, 2)
    assert.equal(run.base.exitCode, 2)
    assert.match(run.head.output, /Test setup failed; this is not evidence/)
  })

  it('does not let the shortcut run another path or bypass the execution policy', async () => {
    const tools = executor()
    const signal = new AbortController().signal
    assert.match(
      await tools.execute(
        'write_reproducer',
        {
          path: '../escaped.ts',
          content: 'throw 1',
          argv: ['copse-test'],
        },
        signal,
        'escape',
      ),
      /must live under/,
    )
    assert.match(
      await tools.execute(
        'write_reproducer',
        {
          path: '.copse-review/test.ts',
          content: 'throw 1',
          argv: ['copse-test', '../escaped.ts'],
        },
        signal,
        'extra-path',
      ),
      /path comes from path/,
    )
    assert.equal(tools.reproducer(), null)
    const denied = executor('deny')
    assert.match(
      await denied.execute(
        'write_reproducer',
        {
          path: '.copse-review/denied.ts',
          content: 'throw 1',
          argv: ['copse-test'],
        },
        signal,
        'denied',
      ),
      /commands cannot run/,
    )
    assert.equal(denied.reproducer(), null)
  })
})
