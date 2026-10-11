import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyChunks, parsePatch, planPatch, seekSequence, summarizePatch } from './apply-patch.ts'
import type { PatchHunk } from './apply-patch.ts'

function patch(...lines: string[]): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
}

function parsed(text: string): PatchHunk[] {
  const result = parsePatch(text)
  assert.ok(result.ok, result.ok ? '' : result.error)
  return result.hunks
}

function parseError(text: string): string {
  const result = parsePatch(text)
  assert.ok(!result.ok, 'expected a parse error')
  return result.error
}

function filesystem(files: Record<string, string>): (path: string) => Promise<string | null> {
  return (path) => Promise.resolve(Object.hasOwn(files, path) ? (files[path] ?? null) : null)
}

describe('parsePatch', () => {
  it('parses add, delete, update and move together', () => {
    const hunks = parsed(
      patch(
        '*** Add File: a/new.py',
        '+abc',
        '+def',
        '*** Delete File: old.py',
        '*** Update File: src/f.py',
        '*** Move to: src/g.py',
        '@@ def f():',
        '-    pass',
        '+    return 123',
      ),
    )
    assert.deepEqual(hunks, [
      { kind: 'add', path: 'a/new.py', contents: 'abc\ndef\n' },
      { kind: 'delete', path: 'old.py' },
      {
        kind: 'update',
        path: 'src/f.py',
        movePath: 'src/g.py',
        chunks: [
          {
            contexts: ['def f():'],
            oldLines: ['    pass'],
            newLines: ['    return 123'],
            isEndOfFile: false,
          },
        ],
      },
    ])
  })

  it('allows the first chunk to omit @@ and treats a bare empty line as blank context', () => {
    const hunks = parsed(patch('*** Update File: f.txt', ' one', '', '-two', '+2'))
    assert.deepEqual(hunks[0], {
      kind: 'update',
      path: 'f.txt',
      movePath: null,
      chunks: [
        {
          contexts: [],
          oldLines: ['one', '', 'two'],
          newLines: ['one', '', '2'],
          isEndOfFile: false,
        },
      ],
    })
  })

  it('starts a new chunk at each @@ that follows changes', () => {
    const hunks = parsed(patch('*** Update File: f', '@@ a', '-1', '+2', '@@ b', '-3', '+4'))
    assert.equal(hunks[0]?.kind === 'update' ? hunks[0].chunks.length : 0, 2)
  })

  it('nests consecutive @@ lines as successive contexts', () => {
    const hunks = parsed(patch('*** Update File: f', '@@ class A', '@@   def m():', '-x', '+y'))
    const chunk = hunks[0]?.kind === 'update' ? hunks[0].chunks[0] : undefined
    assert.deepEqual(chunk?.contexts, ['class A', '  def m():'])
  })

  it('marks end-of-file and ignores blank lines after it', () => {
    const hunks = parsed(patch('*** Update File: f', ' tail', '+more', '*** End of File', ''))
    const chunk = hunks[0]?.kind === 'update' ? hunks[0].chunks : []
    assert.equal(chunk.length, 1)
    assert.equal(chunk[0]?.isEndOfFile, true)
  })

  it('accepts a heredoc wrapper and CRLF patches', () => {
    const inner = patch('*** Add File: x', '+hi')
    assert.equal(parsed(`apply_patch <<'EOF'\n${inner}\nEOF`).length, 1)
    assert.equal(parsed(inner.replace(/\n/g, '\r\n')).length, 1)
  })

  it('normalises ./ prefixes and surrounding whitespace in paths', () => {
    const hunks = parsed(patch('*** Delete File:  ./src/a.ts '))
    assert.deepEqual(hunks[0], { kind: 'delete', path: 'src/a.ts' })
  })

  it('reports a missing Begin/End marker', () => {
    assert.match(parseError('bad'), /first line of the patch must be '\*\*\* Begin Patch'/)
    assert.match(
      parseError('*** Begin Patch\n*** Delete File: a'),
      /last line .* '\*\*\* End Patch'/,
    )
  })

  it('rejects an empty patch, an empty update and an unknown header with its line', () => {
    assert.match(parseError(patch()), /no file changes/)
    assert.match(parseError(patch('*** Update File: test.py')), /line 2.*contains no changes/)
    assert.match(
      parseError(patch('*** Delete File: a', '*** Frobnicate: b')),
      /line 3.*not a valid hunk header/,
    )
  })

  it('rejects a new-file line that lacks the + prefix', () => {
    assert.match(parseError(patch('*** Add File: a', '+ok', 'oops')), /must start with '\+'/)
  })

  it('rejects an unprefixed line inside an update hunk', () => {
    assert.match(
      parseError(patch('*** Update File: f', '@@ x', '-a', 'bare text')),
      /Unexpected line in Update File f: 'bare text'/,
    )
  })
})

describe('seekSequence', () => {
  it('prefers an exact match over an earlier whitespace-insensitive one', () => {
    const lines = ['  foo', 'x', 'foo']
    assert.equal(seekSequence(lines, ['foo'], 0, false), 2)
  })

  it('falls back to trailing-whitespace, trim and unicode-punctuation matches', () => {
    assert.equal(seekSequence(['a  ', 'b'], ['a'], 0, false), 0)
    assert.equal(seekSequence(['\tindented'], ['indented'], 0, false), 0)
    assert.equal(seekSequence(['say “hi” – ok'], ['say "hi" - ok'], 0, false), 0)
  })

  it('searches from the end first for an end-of-file hunk', () => {
    assert.equal(seekSequence(['x', 'a', 'x', 'a'], ['a'], 0, true), 3)
    assert.equal(seekSequence(['x', 'a', 'x', 'a'], ['a'], 0, false), 1)
  })

  it('never matches before start or with an over-long pattern', () => {
    assert.equal(seekSequence(['a', 'b'], ['a'], 1, false), null)
    assert.equal(seekSequence(['a'], ['a', 'b'], 0, false), null)
  })
})

describe('applyChunks', () => {
  const apply = (original: string, ...lines: string[]): string => {
    const hunk = parsed(patch('*** Update File: f', ...lines))[0]
    assert.ok(hunk?.kind === 'update')
    const result = applyChunks(original, hunk.chunks, 'f')
    assert.ok(result.ok, result.ok ? '' : result.error)
    return result.content
  }

  it('replaces lines matched through context', () => {
    assert.equal(apply('a\nb\nc\n', ' a', '-b', '+B', ' c'), 'a\nB\nc\n')
  })

  it('applies several hunks in order', () => {
    const original = 'one\ntwo\nthree\nfour\nfive\n'
    assert.equal(
      apply(original, '@@', '-one', '+1', '@@ four', '-five', '+5'),
      '1\ntwo\nthree\nfour\n5\n',
    )
  })

  it('uses an @@ line to pick the right one of two identical blocks', () => {
    const original = 'fn a() {\n  return 1\n}\nfn b() {\n  return 1\n}\n'
    assert.equal(
      apply(original, '@@ fn b() {', '-  return 1', '+  return 2'),
      'fn a() {\n  return 1\n}\nfn b() {\n  return 2\n}\n',
    )
  })

  it('accepts an @@ line that is only the start of the signature line', () => {
    const original = 'export function greet(): string {\n  return 1\n}\n'
    assert.equal(
      apply(original, '@@ export function greet', '-  return 1', '+  return 2'),
      'export function greet(): string {\n  return 2\n}\n',
    )
  })

  it('inserts after the @@ line when the hunk only adds', () => {
    assert.equal(apply('a\nb\n', '@@ a', '+inserted'), 'a\ninserted\nb\n')
  })

  it('appends at the end when a pure addition has no context', () => {
    assert.equal(apply('a\n', '+z'), 'a\nz\n')
  })

  it('matches despite differing indentation and keeps the new text as written', () => {
    assert.equal(apply('\tfoo();\n', '-foo();', '+bar();'), 'bar();\n')
  })

  it('applies an end-of-file hunk at the last occurrence', () => {
    assert.equal(apply('a\nb\na\nb\n', ' a', '-b', '+B', '*** End of File'), 'a\nb\na\nB\n')
  })

  it('preserves CRLF line endings and a missing final newline', () => {
    assert.equal(apply('a\r\nb\r\n', '-a', '+A'), 'A\r\nb\r\n')
    assert.equal(apply('a\nb', ' a', '-b', '+B'), 'a\nB')
  })

  it('keeps an insertion ahead of a replacement that starts on the same line', () => {
    assert.equal(apply('a\nb\nc\n', '@@ a', '+x', '@@', '-b', '+B'), 'a\nx\nB\nc\n')
  })

  it('rewrites only the touched lines of a mixed-EOL file', () => {
    assert.equal(apply('a\nb\nc\r\n', '-a', '+A'), 'A\nb\nc\r\n')
    assert.equal(apply('a\r\nb\r\nc\n', '-a', '+A1', '+A2'), 'A1\r\nA2\r\nb\r\nc\n')
  })

  it('tolerates a trailing blank line in the hunk that the file lacks', () => {
    assert.equal(apply('a\nb', ' a', '-b', '+B', ''), 'a\nB')
  })

  it('names the hunk and shows the missing lines when nothing matches', () => {
    const hunk = parsed(patch('*** Update File: f', ' a', '-nope', '+x'))[0]
    const result = applyChunks('a\nb\n', hunk?.kind === 'update' ? hunk.chunks : [], 'f.ts')
    assert.ok(!result.ok)
    assert.match(result.error, /Hunk 1 of 1 for f\.ts failed: could not find the expected lines/)
    assert.match(result.error, /\n {2}a\n {2}nope\n/)
    assert.match(result.error, /read_file/)
  })

  it('names a missing @@ context line', () => {
    const hunk = parsed(patch('*** Update File: f', '@@ ghost', '-a', '+b'))[0]
    const result = applyChunks('a\n', hunk?.kind === 'update' ? hunk.chunks : [], 'f')
    assert.ok(!result.ok)
    assert.match(result.error, /could not find the @@ context line "ghost"/)
  })

  it('says when a hunk is out of file order and where it really is', () => {
    const hunk = parsed(patch('*** Update File: f', '@@', '-c', '+C', '@@', '-a', '+A'))[0]
    const result = applyChunks('a\nb\nc\n', hunk?.kind === 'update' ? hunk.chunks : [], 'f')
    assert.ok(!result.ok)
    assert.match(result.error, /Hunk 2 of 2/)
    assert.match(
      result.error,
      /exist at line 1, before the previous hunk ended; hunks must be listed in file order/,
    )
  })
})

describe('planPatch', () => {
  it('plans adds, updates, deletes and a move with edits', async () => {
    const plan = await planPatch(
      parsed(
        patch(
          '*** Add File: new.txt',
          '+hello',
          '*** Update File: a.txt',
          '-1',
          '+one',
          '*** Delete File: gone.txt',
          '*** Update File: old.txt',
          '*** Move to: moved.txt',
          '-x',
          '+y',
        ),
      ),
      filesystem({ 'a.txt': '1\n', 'gone.txt': 'bye\n', 'old.txt': 'x\n' }),
    )
    assert.ok(plan.ok, plan.ok ? '' : plan.error)
    assert.deepEqual(Object.fromEntries(plan.changes.map((c) => [c.path, [c.before, c.after]])), {
      'new.txt': [null, 'hello\n'],
      'a.txt': ['1\n', 'one\n'],
      'gone.txt': ['bye\n', null],
      'old.txt': ['x\n', null],
      'moved.txt': [null, 'y\n'],
    })
  })

  it('lets later entries see earlier ones (add then update the same file)', async () => {
    const plan = await planPatch(
      parsed(patch('*** Add File: n', '+a', '+b', '*** Update File: n', ' a', '-b', '+B')),
      filesystem({}),
    )
    assert.ok(plan.ok, plan.ok ? '' : plan.error)
    assert.deepEqual(plan.changes, [{ path: 'n', before: null, after: 'a\nB\n' }])
  })

  it('refuses to add over an existing file and points at Update File', async () => {
    const plan = await planPatch(parsed(patch('*** Add File: a', '+x')), filesystem({ a: 'y\n' }))
    assert.ok(!plan.ok)
    assert.match(plan.error, /a already exists\. Use '\*\*\* Update File: a'/)
  })

  it('refuses to update or delete a missing file', async () => {
    const update = await planPatch(parsed(patch('*** Update File: m', '-a', '+b')), filesystem({}))
    assert.ok(!update.ok)
    assert.match(update.error, /m does not exist/)
    const del = await planPatch(parsed(patch('*** Delete File: m')), filesystem({}))
    assert.ok(!del.ok)
    assert.match(del.error, /m does not exist/)
  })

  it('refuses to move onto an existing file', async () => {
    const plan = await planPatch(
      parsed(patch('*** Update File: a', '*** Move to: b', '-1', '+2')),
      filesystem({ a: '1\n', b: 'taken\n' }),
    )
    assert.ok(!plan.ok)
    assert.match(plan.error, /cannot move to b, which already exists/)
  })

  it('fails as a whole: an unappliable second entry yields no changes at all', async () => {
    const plan = await planPatch(
      parsed(patch('*** Update File: a', '-1', '+2', '*** Update File: b', '-nope', '+x')),
      filesystem({ a: '1\n', b: 'real\n' }),
    )
    assert.ok(!plan.ok)
    assert.match(plan.error, /Hunk 1 of 1 for b failed/)
  })

  it('reports a patch that changes nothing', async () => {
    const plan = await planPatch(
      parsed(patch('*** Update File: a', '-1', '+1')),
      filesystem({ a: '1\n' }),
    )
    assert.ok(!plan.ok)
    assert.match(plan.error, /No change/)
  })
})

describe('summarizePatch', () => {
  it('counts per-file additions and deletions and tags moves', () => {
    assert.deepEqual(
      summarizePatch(
        patch(
          '*** Add File: n.ts',
          '+a',
          '+b',
          '*** Update File: u.ts',
          '*** Move to: v.ts',
          '@@',
          ' keep',
          '-old',
          '+new',
          '+more',
          '*** Delete File: d.ts',
        ),
      ),
      [
        { path: 'n.ts', op: 'add', additions: 2, deletions: 0 },
        { path: 'u.ts', op: 'move', movePath: 'v.ts', additions: 2, deletions: 1 },
        { path: 'd.ts', op: 'delete', additions: 0, deletions: 0 },
      ],
    )
  })

  it('accepts an incomplete patch and never throws', () => {
    assert.deepEqual(summarizePatch('*** Begin Patch\n*** Update File: x.ts\n@@\n-a'), [
      { path: 'x.ts', op: 'update', additions: 0, deletions: 1 },
    ])
    assert.deepEqual(summarizePatch(''), [])
  })
})
