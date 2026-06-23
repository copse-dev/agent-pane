import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderToolArgs } from './tool-args-format.ts'

describe('renderToolArgs', () => {
  it('renders remote terminal payloads with real multiline output', () => {
    const rendered = renderToolArgs({
      success: {
        command: 'git status && git log --oneline -2',
        stdout: 'On branch main\nnothing to commit\n',
        interleavedOutput: 'On branch main\nnothing to commit\n',
        isBackground: false,
      },
    })

    assert.equal(
      rendered,
      [
        'Command:',
        '  git status && git log --oneline -2',
        'Output:',
        '  On branch main',
        '  nothing to commit',
        'Background: false',
        'Status: success',
      ].join('\n'),
    )
    assert.equal(rendered.includes('\\n'), false)
    assert.equal(rendered.includes('interleavedOutput'), false)
  })

  it('keeps ordinary nested arguments readable', () => {
    assert.equal(
      renderToolArgs({ path: 'src/main.ts', options: { recursive: true } }),
      ['path: src/main.ts', 'options:', '  recursive: true'].join('\n'),
    )
  })

  it('parses JSON-string success fields from remote tool arguments', () => {
    const rendered = renderToolArgs({
      command: 'git submodule status 2>&1 | head -30',
      timeout: 60000,
      isBackground: false,
      success: JSON.stringify({
        command: 'git submodule status 2>&1 | head -30',
        stdout: 'a1 vendor/a\nb2 vendor/b\n',
        interleavedOutput: 'a1 vendor/a\nb2 vendor/b\n',
      }),
    })

    assert.match(rendered, /Command:\n {2}git submodule status/)
    assert.match(rendered, /Output:\n {2}a1 vendor\/a\n {2}b2 vendor\/b/)
    assert.match(rendered, /Timeout: 60000/)
    assert.match(rendered, /Background: false/)
    assert.match(rendered, /Status: success/)
    assert.equal(rendered.includes('\\n'), false)
    assert.equal(rendered.includes('interleavedOutput'), false)
  })

  it('parses JSON-string terminal results from exported transcripts', () => {
    const rendered = renderToolArgs(
      JSON.stringify({
        success: {
          command: 'cd /workspace && git status',
          stdout: 'On branch main\nnothing to commit, working tree clean\n',
          interleavedOutput: 'On branch main\nnothing to commit, working tree clean\n',
          exitCode: 0,
          localExecutionTimeMs: 42,
        },
      }),
    )

    assert.equal(
      rendered,
      [
        'Command:',
        '  cd /workspace && git status',
        'Output:',
        '  On branch main',
        '  nothing to commit, working tree clean',
        'Exit code: 0',
        'Local execution time: 42',
        'Status: success',
      ].join('\n'),
    )
    assert.equal(rendered.includes('\\n'), false)
    assert.equal(rendered.includes('interleavedOutput'), false)
  })
})
