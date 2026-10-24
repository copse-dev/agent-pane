import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySandboxDenial,
  operationDescriptorForCommand,
  prefixWithSandboxCacheSkipNote,
  prefixWithSandboxRetryNote,
  SANDBOX_DENIAL_CACHE_SKIP_NOTE,
  SANDBOX_DENIAL_RETRY_NOTE,
  sandboxDenialRetryClassification,
  sandboxForwardEscalationMaySkipApproval,
  sandboxRetryMaySkipApproval,
} from './sandbox-denial-signatures.ts'

describe('classifySandboxDenial (issue #1436)', () => {
  it('classifies the git fetch CONNECT-tunnel denial and names the git subcommand, not "the network"', () => {
    const output =
      "fatal: unable to access 'https://github.com/copse-dev/agent-pane.git/': CONNECT tunnel " +
      'failed, response 403'
    const match = classifySandboxDenial(output, 'git fetch origin main')
    assert.ok(match)
    assert.equal(match.operation, 'git fetch')
    assert.match(match.advice, /git fetch/)
    assert.doesNotMatch(match.advice, /\bthe network is blocked\b/i)
  })

  it('classifies the gh config-read denial and names the specific path, not a category', () => {
    const output = 'open /home/user/.config/gh/config.yml: operation not permitted'
    const match = classifySandboxDenial(output, 'gh pr create --title "fix" --body "..."')
    assert.ok(match)
    assert.equal(match.operation, 'read ~/.config/gh')
    assert.match(match.advice, /~\/\.config\/gh/)
  })

  it('classifies the Socket Firewall binary-prep denial and names it as one-time setup', () => {
    const output = '[sfw] Failed to prepare firewall binary: EPERM'
    const match = classifySandboxDenial(output, 'npx prettier --write .')
    assert.ok(match)
    assert.equal(match.operation, 'prepare firewall binary (sfw)')
    assert.match(match.advice, /one-time setup/)
  })

  it('returns null for an unrecognised failure, unchanged', () => {
    assert.equal(classifySandboxDenial('bash: foo: command not found', 'foo'), null)
    assert.equal(classifySandboxDenial('Error: 3 tests failed', 'pnpm test'), null)
  })

  it('a different git subcommand names itself, not the one that actually failed', () => {
    const output = "fatal: unable to access '...': CONNECT tunnel failed, response 403"
    assert.equal(classifySandboxDenial(output, 'git push origin HEAD')?.operation, 'git push')
    assert.equal(classifySandboxDenial(output, 'git fetch origin main')?.operation, 'git fetch')
  })

  it('does not label a non-git CONNECT-tunnel denial as git network access', () => {
    const output = 'curl: (56) CONNECT tunnel failed, response 403'
    for (const command of [
      'curl -sS https://example.com',
      'grep -rn "then git fetch origin" docs && curl https://example.com',
    ]) {
      const match = classifySandboxDenial(output, command)
      assert.ok(match)
      assert.equal(match.operation, 'network access through the egress proxy')
      assert.doesNotMatch(match.operation, /git/)
      assert.doesNotMatch(match.advice, /\bgit\b/)
    }
  })

  it('keeps the generic git label for a git command outside the named subcommands', () => {
    const output = "fatal: unable to access '...': CONNECT tunnel failed, response 403"
    assert.equal(
      classifySandboxDenial(output, 'git remote update')?.operation,
      'git network access',
    )
  })
})

describe('sandboxDenialRetryClassification (issue #1436 point 1)', () => {
  const fetchOutput = "fatal: unable to access '...': CONNECT tunnel failed, response 403"

  it('classifies a matching denial from a sandbox-contained attempt', () => {
    const match = sandboxDenialRetryClassification(fetchOutput, 'git fetch origin main')
    assert.ok(match)
    assert.equal(match.operation, 'git fetch')
  })

  it('returns null for an unrecognised failure', () => {
    assert.equal(sandboxDenialRetryClassification('boom', 'run-tests.sh'), null)
  })
})

describe('sandbox retry approval boundary', () => {
  it('does not let Guarded YOLO turn forgeable command output into an automatic escape', () => {
    assert.equal(sandboxRetryMaySkipApproval('signature', true, false), false)
  })

  it('preserves Guarded YOLO auto-retry for runner-verified sandbox evidence', () => {
    assert.equal(sandboxRetryMaySkipApproval('runner', true, false), true)
  })

  it('can retry either evidence kind inside the same unattended container', () => {
    assert.equal(sandboxRetryMaySkipApproval('runner', false, true), true)
    assert.equal(sandboxRetryMaySkipApproval('signature', false, true), true)
  })

  it('requires ordinary runs to ask for approval for either evidence kind', () => {
    assert.equal(sandboxRetryMaySkipApproval('runner', false, false), false)
    assert.equal(sandboxRetryMaySkipApproval('signature', false, false), false)
  })

  it('does not let Guarded YOLO turn a cached forgeable denial into an automatic escape', () => {
    assert.equal(sandboxForwardEscalationMaySkipApproval('denial-cache', true, false), false)
  })

  it('preserves Guarded YOLO auto-escalation for an explicit model hint', () => {
    assert.equal(sandboxForwardEscalationMaySkipApproval('model-hint', true, false), true)
  })

  it('can advance either source inside the same unattended container', () => {
    assert.equal(sandboxForwardEscalationMaySkipApproval('model-hint', false, true), true)
    assert.equal(sandboxForwardEscalationMaySkipApproval('denial-cache', false, true), true)
  })

  it('requires ordinary runs to ask for approval for either forward source', () => {
    assert.equal(sandboxForwardEscalationMaySkipApproval('model-hint', false, false), false)
    assert.equal(sandboxForwardEscalationMaySkipApproval('denial-cache', false, false), false)
  })
})

describe('operationDescriptorForCommand', () => {
  it('derives the operation from a git fetch/push/pull command shape alone', () => {
    assert.equal(operationDescriptorForCommand('git fetch origin main'), 'git fetch')
    assert.equal(operationDescriptorForCommand('git push origin HEAD'), 'git push')
    assert.equal(operationDescriptorForCommand('cd repo && git pull'), 'git pull')
  })

  it('derives the gh config-read operation from any gh invocation', () => {
    assert.equal(operationDescriptorForCommand('gh pr create --title x'), 'read ~/.config/gh')
    assert.equal(operationDescriptorForCommand('gh pr view 42'), 'read ~/.config/gh')
  })

  it('keeps the descriptor for git/gh in command position behind separators, wrappers and options', () => {
    assert.equal(operationDescriptorForCommand('cd x && git fetch'), 'git fetch')
    assert.equal(operationDescriptorForCommand('env FOO=1 git push'), 'git push')
    assert.equal(operationDescriptorForCommand('git -C dir fetch'), 'git fetch')
    assert.equal(operationDescriptorForCommand('git -c http.version=HTTP/1.1 push'), 'git push')
    assert.equal(operationDescriptorForCommand('timeout 30 git ls-remote origin'), 'git ls-remote')
    assert.equal(operationDescriptorForCommand("bash -c 'git fetch origin'"), 'git fetch')
    assert.equal(
      operationDescriptorForCommand("bash -lc 'cd repo && git fetch origin'"),
      'git fetch',
    )
    assert.equal(operationDescriptorForCommand("sh -ec 'git push origin HEAD'"), 'git push')
    assert.equal(operationDescriptorForCommand("bash -e -c 'git fetch'"), 'git fetch')
    assert.equal(operationDescriptorForCommand("zsh -lc 'gh pr view 42'"), 'read ~/.config/gh')
    assert.equal(operationDescriptorForCommand('pnpm build; gh pr view 42'), 'read ~/.config/gh')
    assert.equal(operationDescriptorForCommand('env GH_PAGER= gh pr list'), 'read ~/.config/gh')
  })

  it('does not derive a git or gh operation from program names that are only data', () => {
    assert.equal(operationDescriptorForCommand('grep -rn "git fetch" docs'), null)
    assert.equal(operationDescriptorForCommand('grep -rn "then git fetch origin" docs'), null)
    assert.equal(operationDescriptorForCommand("rg 'gh pr' src"), null)
    assert.equal(operationDescriptorForCommand('echo git push'), null)
    assert.equal(operationDescriptorForCommand('git log --grep fetch'), null)
  })

  it('returns null for a command shape with no predicted operation', () => {
    assert.equal(operationDescriptorForCommand('npx prettier --write .'), null)
    assert.equal(operationDescriptorForCommand('pnpm test'), null)
  })
})

describe('retry/cache-skip observability notes (issue #1436)', () => {
  it('prefixes a successful retry with the greppable one-line note', () => {
    const prefixed = prefixWithSandboxRetryNote('done')
    assert.match(prefixed, new RegExp(`^\\[${SANDBOX_DENIAL_RETRY_NOTE}\\]\\n`))
    assert.match(prefixed, /done$/)
  })

  it('prefixes a cache-driven skip with its own distinct note', () => {
    const prefixed = prefixWithSandboxCacheSkipNote('done')
    assert.match(prefixed, new RegExp(`^\\[${SANDBOX_DENIAL_CACHE_SKIP_NOTE}\\]\\n`))
  })
})
