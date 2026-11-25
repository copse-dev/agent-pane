import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type Finding,
  checkPlanFor,
  editedPathsFromPayload,
  hookOutput,
  isHookDialect,
  oxlintErrorLines,
  renderReport,
  siblingTestCandidates,
} from './edited-file-check.mts'

describe('checkPlanFor', () => {
  it('lints and formats source files', () => {
    assert.deepEqual(checkPlanFor('src/main/app-init.ts'), { lint: true, format: true })
    assert.deepEqual(checkPlanFor('scripts/build.mts'), { lint: true, format: true })
  })

  it('formats but does not lint the non-code files the formatter owns', () => {
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

describe('oxlintErrorLines', () => {
  // Trimmed from real `oxlint --type-aware --format=json` output (oxlint 1.94).
  const diagnostic = {
    message: 'Promises must be awaited, end with a call to .catch, or end with a call to .then.',
    code: 'typescript(no-floating-promises)',
    severity: 'error',
    url: 'https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-floating-promises.html',
    help: 'The promise must end with a call to .catch.',
    filename: 'src/a.ts',
    labels: [{ span: { offset: 486, length: 9, line: 17, column: 3 } }],
  }
  const report = (diagnostics: unknown[]): string =>
    JSON.stringify({ diagnostics, number_of_files: 1, number_of_rules: 142 })

  it('prints each error as position, message and rule', () => {
    assert.deepEqual(oxlintErrorLines(report([diagnostic])), [
      '  17:3  Promises must be awaited, end with a call to .catch, or end with a call to .then.  typescript(no-floating-promises)',
    ])
  })

  it('orders errors by position, not by the rule oxlint grouped them under', () => {
    const at = (line: number, column: number): unknown => ({
      ...diagnostic,
      labels: [{ span: { offset: 0, length: 1, line, column } }],
    })
    const lines = oxlintErrorLines(report([at(9, 1), at(2, 5), at(2, 1)])) ?? []
    assert.deepEqual(
      lines.map((line) => line.trim().split(' ')[0]),
      ['2:1', '2:5', '9:1'],
    )
  })

  it('is empty for a clean file', () => {
    assert.deepEqual(oxlintErrorLines(report([])), [])
  })

  it('drops warnings, because the hook reports what would fail the gate', () => {
    assert.deepEqual(oxlintErrorLines(report([{ ...diagnostic, severity: 'warning' }])), [])
  })

  it('keeps a diagnostic with no rule or position instead of dropping it', () => {
    const bare = { message: 'Unused eslint-disable directive.', severity: 'error' }
    assert.deepEqual(oxlintErrorLines(report([bare])), ['  0:0  Unused eslint-disable directive.'])
  })

  it('reads past the notice oxlint prints when the only path is ignored', () => {
    // Verbatim shape of oxlint 1.94's stdout for an ignored file under --type-aware.
    const stdout =
      'No files found to lint. Please check your paths and ignore patterns.\n' +
      '{ "diagnostics": [],\n  "number_of_files": 0,\n  "number_of_rules": 142\n}\n'
    assert.deepEqual(oxlintErrorLines(stdout), [])
  })

  it('rejects output that is not an oxlint report', () => {
    assert.equal(oxlintErrorLines('No files found to lint.'), null)
    assert.equal(oxlintErrorLines(JSON.stringify({ diagnostics: [{ message: 1 }] })), null)
  })
})

describe('renderReport', () => {
  const lintFinding: Finding = {
    tool: 'oxlint',
    detail: '  1:7  no-unused-vars',
    fix: 'npx oxlint --type-aware src/a.ts',
  }
  const formatFinding: Finding = {
    tool: 'oxfmt',
    detail: '  file is not formatted',
    fix: 'npx oxfmt --write src/a.ts',
  }
  const findings: Finding[] = [lintFinding, formatFinding]

  /** renderReport returns null only when clean; every other case has text. */
  function report(
    file: string,
    f: Finding[],
    repaired: string[],
    hint: string | null = null,
  ): string {
    const out = renderReport(file, f, repaired, hint)
    assert.ok(out !== null, 'expected a report')
    return out
  }

  it('names the file, the count, and each tool with its fix', () => {
    const out = report('src/a.ts', findings, [])
    assert.match(out, /src\/a\.ts: 2 issue\(s\)/)
    assert.match(out, /\[oxlint\]/)
    assert.match(out, /fix: npx oxfmt --write src\/a\.ts/)
  })

  it('states that the check is a subset, so it is never read as a full green', () => {
    const out = report('src/a.ts', findings, [])
    assert.match(out, /fast subset/)
    assert.match(out, /npm run check:local.*minimum gate/)
    // The hook lints with oxlint while ESLint stays the gate, so the footer must
    // not let a silent hook read as "ESLint passed".
    assert.match(out, /ESLint, which remains the lint gate/)
    assert.match(out, /npm run check.*complete suite/)
  })

  it('names the covering test only when there is one', () => {
    assert.match(
      report('src/a.ts', findings, [], 'src/a.test.ts'),
      /Covering unit test: npm test -- src\/a\.test\.ts/,
    )
    assert.doesNotMatch(report('src/a.ts', findings, []), /Covering unit test/)
  })

  it('is silent only when nothing was found and nothing was repaired', () => {
    assert.equal(renderReport('src/a.ts', [], [], null), null)
    assert.equal(renderReport('src/a.ts', [], [], 'src/a.test.ts'), null)
  })

  it('reports an auto-fix even with no findings, so the agent knows its copy is stale', () => {
    // A silent rewrite is worse than none: the agent would later match an edit
    // against text the file no longer holds.
    const out = report('src/a.ts', [], ['oxfmt'])
    assert.match(out, /rewritten on disk by oxfmt/)
    assert.match(out, /Re-read it before your next edit/)
  })

  it('leads with the rewrite when a repair and a finding coincide', () => {
    const out = report('src/a.ts', [lintFinding], ['oxfmt'])
    assert.ok(out.indexOf('rewritten on disk') < out.indexOf('[oxlint]'))
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
