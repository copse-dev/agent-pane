import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  type Finding,
  checkPlanFor,
  editedPathsFromPayload,
  hookOutput,
  isHookDialect,
  lintSkipped,
  oxlintErrorLines,
  oxlintFindings,
  parseHookArgs,
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

  it('keeps a diagnostic whose span oxlint could not place, at an unknown position', () => {
    // oxlint writes `"line": null, "column": null` for such a label. Rejecting the
    // whole report over it would drop every other finding with it.
    const unplaced = {
      ...diagnostic,
      labels: [{ span: { offset: 0, length: 0, line: null, column: null } }],
    }
    const lines = oxlintErrorLines(report([unplaced, diagnostic])) ?? []
    assert.equal(lines.length, 2)
    assert.match(lines[0] ?? '', /^ {2}17:3 /)
    assert.match(lines[1] ?? '', /^ {2}\?:\? /)
  })

  it('rejects output that is not an oxlint report', () => {
    assert.equal(oxlintErrorLines('No files found to lint.'), null)
    assert.equal(oxlintErrorLines(JSON.stringify({ diagnostics: [{ message: 1 }] })), null)
  })
})

describe('oxlintFindings', () => {
  const errorReport = JSON.stringify({
    diagnostics: [
      {
        message: 'Unexpected any.',
        code: 'typescript(no-explicit-any)',
        severity: 'error',
        labels: [{ span: { line: 3, column: 9 } }],
      },
    ],
  })

  it('is clean on exit 0, whatever stdout holds', () => {
    assert.deepEqual(oxlintFindings('src/a.ts', { code: 0, stdout: 'anything', stderr: '' }), [])
  })

  it("turns exit 1 with a report into one finding with oxlint's fix command", () => {
    const findings = oxlintFindings('src/a.ts', { code: 1, stdout: errorReport, stderr: '' })
    assert.equal(findings.length, 1)
    const [finding] = findings
    assert.ok(finding)
    assert.equal(finding.tool, 'oxlint')
    assert.match(finding.detail, /3:9 {2}Unexpected any\. {2}typescript\(no-explicit-any\)/)
    assert.equal(finding.fix, 'npx oxlint --type-aware src/a.ts')
  })

  it('reports a run that checked nothing as skipped, quoting what oxlint said', () => {
    // A bad config: oxlint exits 1 with text on stdout and no JSON report.
    const [badConfig] = oxlintFindings('src/a.ts', {
      code: 1,
      stdout: 'Failed to parse oxlint configuration file.',
      stderr: '',
    })
    assert.match(badConfig?.detail ?? '', /skipped — oxlint exited 1: Failed to parse oxlint/)
    // A crash: a code oxlint never uses for findings, the reason on stderr.
    const [crash] = oxlintFindings('src/a.ts', { code: 101, stdout: '', stderr: 'panicked' })
    assert.match(crash?.detail ?? '', /skipped — oxlint exited 101: panicked/)
    // Killed by a signal: no exit code at all.
    const [killed] = oxlintFindings('src/a.ts', { code: null, stdout: '', stderr: '' })
    assert.match(killed?.detail ?? '', /skipped — oxlint was killed$/)
  })
})

describe('parseHookArgs', () => {
  it('reads the dialect, the flags and the paths', () => {
    assert.deepEqual(parseHookArgs(['--dialect', 'copse', '--fix', '--no-lint', 'src/a.ts']), {
      dialect: 'copse',
      files: ['src/a.ts'],
      fix: true,
      lint: false,
    })
  })

  it('lints and does not rewrite unless told otherwise', () => {
    assert.deepEqual(parseHookArgs(['src/a.ts']), {
      dialect: 'cli',
      files: ['src/a.ts'],
      fix: false,
      lint: true,
    })
  })

  it('ignores an unknown dialect or flag rather than refusing to run', () => {
    const args = parseHookArgs(['--dialect', 'vim', '--verbose', 'src/a.ts'])
    assert.equal(args.dialect, 'cli')
    assert.deepEqual(args.files, ['src/a.ts'])
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

  it('still reports a rewrite when the lint itself was skipped', () => {
    // The format step runs first; a lint that could not run must not swallow its report.
    const skipped = lintSkipped('oxlint is not installed in this checkout', 'pnpm install')
    const out = report('src/a.ts', [skipped], ['oxfmt'])
    assert.match(out, /rewritten on disk by oxfmt/)
    assert.match(out, /Re-read it before your next edit/)
    assert.match(out, /skipped — oxlint is not installed in this checkout/)
    assert.match(out, /fix: pnpm install/)
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
