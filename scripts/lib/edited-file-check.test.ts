import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type Finding,
  checkPlanFor,
  editedPathsFromPayload,
  hookOutput,
  isHookDialect,
  renderReport,
  siblingTestCandidates,
} from './edited-file-check.mts'

describe('checkPlanFor', () => {
  it('lints and formats source files', () => {
    assert.deepEqual(checkPlanFor('src/main/app-init.ts'), { lint: true, format: true })
    assert.deepEqual(checkPlanFor('scripts/build.mts'), { lint: true, format: true })
  })

  it('formats but does not lint the non-code files prettier owns', () => {
    assert.deepEqual(checkPlanFor('docs/testing-strategy.md'), { lint: false, format: true })
    assert.deepEqual(checkPlanFor('package.json'), { lint: false, format: true })
    assert.deepEqual(checkPlanFor('src/renderer/styles/global/base.css'), {
      lint: false,
      format: true,
    })
  })

  it('returns null for files neither tool can say anything about', () => {
    assert.equal(checkPlanFor('assets/icon.png'), null)
    assert.equal(checkPlanFor('LICENSE'), null)
  })

  it('normalises windows separators before matching', () => {
    assert.deepEqual(checkPlanFor('src\\main\\app-init.ts'), { lint: true, format: true })
  })
})

describe('editedPathsFromPayload', () => {
  it('reads the top-level file_path copse and cursor send', () => {
    assert.deepEqual(
      editedPathsFromPayload({ hook_event_name: 'afterFileEdit', file_path: 'src/a.ts' }),
      ['src/a.ts'],
    )
  })

  it('reads the tool_input Claude Code nests the edit under', () => {
    assert.deepEqual(
      editedPathsFromPayload({ tool_name: 'Edit', tool_input: { file_path: 'src/b.ts' } }),
      ['src/b.ts'],
    )
  })

  it('reads a notebook edit', () => {
    assert.deepEqual(
      editedPathsFromPayload({
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: 'n.ipynb' },
      }),
      ['n.ipynb'],
    )
  })

  it('does not repeat a path echoed back in tool_response', () => {
    assert.deepEqual(
      editedPathsFromPayload({
        tool_input: { file_path: 'src/c.ts' },
        tool_response: { filePath: 'src/c.ts' },
      }),
      ['src/c.ts'],
    )
  })

  it('yields nothing rather than a wrong path for an unrecognised payload', () => {
    assert.deepEqual(
      editedPathsFromPayload({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
      [],
    )
    assert.deepEqual(editedPathsFromPayload(null), [])
    assert.deepEqual(editedPathsFromPayload('nope'), [])
    assert.deepEqual(editedPathsFromPayload({ file_path: '' }), [])
  })
})

describe('siblingTestCandidates', () => {
  it('points at the *.test.ts beside a source file', () => {
    assert.deepEqual(siblingTestCandidates('src/shared/tools/tool-display.ts'), [
      'src/shared/tools/tool-display.test.ts',
    ])
  })

  it('offers .test.ts for a .mts module, since the suite only bundles *.test.ts', () => {
    assert.deepEqual(siblingTestCandidates('scripts/lib/test-filter.mts'), [
      'scripts/lib/test-filter.test.mts',
      'scripts/lib/test-filter.test.ts',
    ])
  })

  it('returns a test file itself, so editing a test still names a test to run', () => {
    assert.deepEqual(siblingTestCandidates('src/a/b.test.ts'), ['src/a/b.test.ts'])
  })

  it('has no opinion about non-TypeScript files', () => {
    assert.deepEqual(siblingTestCandidates('src/a/b.css'), [])
    assert.deepEqual(siblingTestCandidates('README.md'), [])
  })
})

describe('renderReport', () => {
  const findings: Finding[] = [
    { tool: 'eslint', detail: '  1:7  no-unused-vars', fix: 'npx eslint src/a.ts' },
    { tool: 'prettier', detail: '  file is not formatted', fix: 'npx prettier --write src/a.ts' },
  ]

  it('names the file, the count, and each tool with its fix', () => {
    const report = renderReport('src/a.ts', findings, null)
    assert.match(report, /^src\/a\.ts: 2 issue\(s\)/)
    assert.match(report, /\[eslint\]/)
    assert.match(report, /fix: npx prettier --write src\/a\.ts/)
  })

  it('states that the check is a subset, so it is never read as a full green', () => {
    const report = renderReport('src/a.ts', findings, null)
    assert.match(report, /fast subset/)
    assert.match(report, /npm run check/)
  })

  it('names the covering test only when there is one', () => {
    assert.match(
      renderReport('src/a.ts', findings, 'src/a.test.ts'),
      /Covering unit test: npm test -- src\/a\.test\.ts/,
    )
    assert.doesNotMatch(renderReport('src/a.ts', findings, null), /Covering unit test/)
  })
})

describe('hookOutput', () => {
  it('is silent and clean when there is nothing to report', () => {
    for (const dialect of ['claude', 'copse', 'cursor', 'cli'] as const) {
      assert.deepEqual(hookOutput(dialect, null), { stdout: '', stderr: '', exitCode: 0 })
    }
  })

  it('exits 2 with stderr for Claude Code — its only channel back to the model', () => {
    assert.deepEqual(hookOutput('claude', 'report'), {
      stdout: '',
      stderr: 'report',
      exitCode: 2,
    })
  })

  it('emits a stdout queueMessage for Copse, the one route back to the agent', () => {
    const out = hookOutput('copse', 'report')
    assert.equal(out.exitCode, 0)
    assert.deepEqual(JSON.parse(out.stdout), { queueMessage: { text: 'report' } })
  })

  it('exits 0 for Cursor, where a non-zero exit means the hook itself failed', () => {
    // Findings are a successful run of the check; badging the hook as broken
    // in Settings → Sources every time it works would be backwards.
    assert.deepEqual(hookOutput('cursor', 'report'), { stdout: '', stderr: 'report', exitCode: 0 })
  })

  it('exits non-zero on the command line, as a check command should', () => {
    assert.equal(hookOutput('cli', 'report').exitCode, 1)
  })
})

describe('isHookDialect', () => {
  it('accepts the four dialects and rejects anything else', () => {
    assert.equal(isHookDialect('copse'), true)
    assert.equal(isHookDialect('claude'), true)
    assert.equal(isHookDialect('nope'), false)
  })
})
