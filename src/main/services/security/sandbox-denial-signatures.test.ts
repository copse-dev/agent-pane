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
  sandboxGitHubReadShape,
  sandboxRetryMaySkipApproval,
} from './sandbox-denial-signatures.ts'
import { SANDBOX_GITHUB_READ_ONLY_NOTE } from '../github/sandbox-github-reads.ts'

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

  it('classifies an install whose download proxy cannot listen as a needed download', () => {
    const output =
      '[safe-install] cannot listen on loopback here (EPERM); package downloads are disabled for this command\n' +
      'npm error code ECONNREFUSED'
    const match = classifySandboxDenial(output, 'npx prettier --write .')
    assert.ok(match)
    assert.equal(match.operation, 'download packages')
    assert.match(match.advice, /needs network access outside the sandbox/)
  })

  it('classifies an install that cannot reach a registry the same way', () => {
    const output =
      '[safe-install] could not reach registry.npmjs.org: connect ENETUNREACH\nnpm error 502'
    assert.equal(classifySandboxDenial(output, 'npx cowsay hi')?.operation, 'download packages')
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

describe('sandboxed GitHub read route refusals', () => {
  const gitPush =
    'remote: Copse refused this request: pushing is not allowed from the project sandbox. ' +
    `${SANDBOX_GITHUB_READ_ONLY_NOTE}\n` +
    "fatal: unable to access 'http://s0123456789abcdef.github.copse.internal/o/r.git/': " +
    'The requested URL returned error: 403'
  const ghWrite =
    'HTTP 403: Copse refused this request: GraphQL mutations are writes or streams, not reads. ' +
    `${SANDBOX_GITHUB_READ_ONLY_NOTE} (https://api.github.com/graphql)`

  it('turns a refused write into the ordinary outside-sandbox retry question', () => {
    const push = sandboxDenialRetryClassification(gitPush, 'git push origin main')
    assert.ok(push)
    assert.equal(push.operation, 'git push (GitHub write)')
    assert.match(push.advice, /Nothing was sent to GitHub/)
    const pr = sandboxDenialRetryClassification(ghWrite, 'gh pr create --fill')
    assert.equal(pr?.operation, 'GitHub write')
    // Signature evidence never skips the prompt, in Guarded YOLO or not.
    assert.equal(sandboxRetryMaySkipApproval('signature', true, false), false)
  })

  it('does not match an ordinary GitHub error or a refusal without the read-only note', () => {
    assert.equal(
      classifySandboxDenial('HTTP 404: Not Found (https://api.github.com/x)', 'gh api x'),
      null,
    )
    assert.equal(
      classifySandboxDenial(
        'Copse refused this request: pushing is not allowed from a container run.',
        'git push',
      ),
      null,
    )
  })

  it('recognises SSH failing to authenticate from inside the sandbox', () => {
    for (const output of [
      'Received disconnect from 140.82.121.3 port 22:2: client did not offer an authentication method',
      'Received disconnect from 140.82.121.3 port 22:14: No supported authentication methods available [preauth]',
    ]) {
      assert.equal(classifySandboxDenial(output, 'git fetch origin')?.operation, 'git fetch')
    }
  })

  it('names the shapes the route serves from the command alone', () => {
    const macos = { gh: true }
    for (const command of [
      'gh pr view 12',
      'cd x && gh api user',
      'git fetch origin',
      'git ls-remote origin',
    ]) {
      assert.equal(sandboxGitHubReadShape(command, macos), true, command)
    }
    for (const command of ['git push origin', 'git status', 'echo gh', 'ghost run']) {
      assert.equal(sandboxGitHubReadShape(command, macos), false, command)
    }
  })

  it('leaves gh out where the route does not carry it (Linux)', () => {
    const linux = { gh: false }
    assert.equal(sandboxGitHubReadShape('gh pr view 12', linux), false)
    assert.equal(sandboxGitHubReadShape('cd x && gh api user', linux), false)
    assert.equal(sandboxGitHubReadShape('git fetch origin', linux), true)
  })
})
