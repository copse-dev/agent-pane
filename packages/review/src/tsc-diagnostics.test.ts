import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticKey, newDiagnostics, parseTscDiagnostics } from './tsc-diagnostics.ts'

describe('parseTscDiagnostics', () => {
  it('reads both tsc line formats and ignores everything else', () => {
    const output = [
      '> copse-panel@0.0.0 typecheck',
      '> tsc --noEmit -p tsconfig.node.json',
      '',
      "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      "\u001b[96msrc/b.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'x'.",
      '',
      '3 const y = x',
      '            ~',
      'Found 2 errors in 2 files.',
      'ELIFECYCLE Command failed with exit code 2.',
    ].join('\n')
    assert.deepEqual(parseTscDiagnostics(output), [
      {
        path: 'src/a.ts',
        line: 12,
        column: 5,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
      { path: 'src/b.ts', line: 3, column: 1, code: 'TS2304', message: "Cannot find name 'x'." },
    ])
  })

  it('keeps paths that contain parentheses, such as Next.js route groups', () => {
    const output = [
      'app/(auth)/page.tsx(3,7): error TS2322: bad',
      "app/(marketing)/layout.tsx:9:2 - error TS2304: Cannot find name 'y'.",
    ].join('\n')
    assert.deepEqual(
      parseTscDiagnostics(output).map((d) => `${d.path}:${String(d.line)}:${String(d.column)}`),
      ['app/(auth)/page.tsx:3:7', 'app/(marketing)/layout.tsx:9:2'],
    )
  })

  it('returns nothing for output with no diagnostics', () => {
    assert.deepEqual(parseTscDiagnostics('all good\n'), [])
    assert.deepEqual(parseTscDiagnostics(''), [])
  })
})

describe('newDiagnostics', () => {
  const moved = { path: 'src/a.ts', line: 40, column: 1, code: 'TS2322', message: 'same' }
  const original = { ...moved, line: 12 }
  const fresh = { path: 'src/a.ts', line: 41, column: 1, code: 'TS2339', message: 'new' }

  it('ignores a diagnostic that only moved, keeps one that is genuinely new, and dedupes', () => {
    assert.equal(diagnosticKey(moved), diagnosticKey(original))
    assert.deepEqual(newDiagnostics([original], [moved, fresh, fresh]), [fresh])
  })
})
