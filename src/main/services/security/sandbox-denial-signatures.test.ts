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

  it('degrades to the generic egress label when the git command sits in an unresolved branch', () => {
    const output = "fatal: unable to access '...': CONNECT tunnel failed, response 403"
    const command = 'if [ -f lockfile ]; then\n  echo skip\nelse\n  git fetch origin\nfi'
    const match = classifySandboxDenial(output, command)
    assert.ok(match)
    assert.equal(match.operation, 'network access through the egress proxy')
    assert.doesNotMatch(match.operation, /git/)
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
    assert.equal(operationDescriptorForCommand("bash -o pipefail -c 'git fetch'"), 'git fetch')
    assert.equal(operationDescriptorForCommand("zsh -lc 'gh pr view 42'"), 'read ~/.config/gh')
    assert.equal(operationDescriptorForCommand('pnpm build; gh pr view 42'), 'read ~/.config/gh')
    assert.equal(operationDescriptorForCommand('env GH_PAGER= gh pr list'), 'read ~/.config/gh')
    assert.equal(operationDescriptorForCommand("pwsh -Command 'git fetch origin'"), 'git fetch')
    assert.equal(
      operationDescriptorForCommand("powershell -Command 'gh pr view 42'"),
      'read ~/.config/gh',
    )
  })

  it('returns null when a matched git/gh invocation sits in an unresolved conditional or loop branch', () => {
    // The git fetch here only runs on the `else` branch — this module cannot know which
    // branch would actually execute without running it, so it must not confidently claim one.
    assert.equal(
      operationDescriptorForCommand(
        'if [ -f lockfile ]; then\n  echo skip\nelse\n  git fetch origin\nfi',
      ),
      null,
    )
    assert.equal(
      operationDescriptorForCommand(
        'case "$1" in\n  start) git fetch ;;\n  stop) echo stop ;;\nesac',
      ),
      null,
    )
    assert.equal(operationDescriptorForCommand('for f in *.git; do git -C "$f" fetch; done'), null)
  })

  it('does not derive a git or gh operation from program names that are only data', () => {
    assert.equal(operationDescriptorForCommand('grep -rn "git fetch" docs'), null)
    assert.equal(operationDescriptorForCommand('grep -rn "then git fetch origin" docs'), null)
    assert.equal(operationDescriptorForCommand("rg 'gh pr' src"), null)
    assert.equal(operationDescriptorForCommand('echo git push'), null)
    assert.equal(operationDescriptorForCommand('git log --grep fetch'), null)
  })

  it('does not read a -c after the script operand as inline shell code', () => {
    // Options end at the first operand: here `-c` and `git fetch` are arguments to the script.
    assert.equal(operationDescriptorForCommand("bash script.sh -c 'git fetch'"), null)
    assert.equal(operationDescriptorForCommand("sh -- -c 'git push'"), null)
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
