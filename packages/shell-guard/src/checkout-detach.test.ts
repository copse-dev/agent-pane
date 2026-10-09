import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectCheckoutDetachingCommand } from './checkout-detach.ts'

function operation(command: string): string | undefined {
  return detectCheckoutDetachingCommand(command)?.operation
}

describe('detectCheckoutDetachingCommand', () => {
  it('refuses a rebase, however it is spelled', () => {
    assert.equal(operation('git rebase main'), 'git rebase')
    assert.equal(operation('git rebase -i HEAD~3'), 'git rebase')
    assert.equal(operation('git rebase --onto main old topic'), 'git rebase')
    assert.equal(operation('git -C sub rebase origin/main'), 'git rebase')
    assert.equal(operation('git -c commit.gpgsign=true rebase main'), 'git rebase')
    assert.equal(operation('cd app && git fetch && git rebase origin/main'), 'git rebase')
    assert.equal(operation('GIT_EDITOR=true git rebase main'), 'git rebase')
    assert.equal(operation('sh -c "git rebase main"'), 'git rebase')
  })

  it('refuses a rebasing pull but not a merging one', () => {
    assert.equal(operation('git pull --rebase'), 'git pull --rebase')
    assert.equal(operation('git pull -r origin main'), 'git pull --rebase')
    assert.equal(operation('git pull --rebase=merges'), 'git pull --rebase')
    assert.equal(operation('git -c pull.rebase=true pull'), 'git pull --rebase')
    assert.equal(operation('git pull --no-rebase'), undefined)
    assert.equal(operation('git pull --rebase=false'), undefined)
    assert.equal(operation('git pull --rebase --no-rebase'), undefined)
    assert.equal(operation('git pull --ff-only'), undefined)
    assert.equal(operation('git -c pull.rebase=true pull --no-rebase'), undefined)
  })

  it('reads every spelling Git accepts for a rebasing pull', () => {
    // Git parses pull.rebase and --rebase=<v> as a boolean, so these all rebase.
    for (const value of [
      'yes',
      'on',
      'true',
      '1',
      '2',
      'YES',
      'True',
      'merges',
      'm',
      'interactive',
      'i',
    ]) {
      assert.equal(operation(`git -c pull.rebase=${value} pull`), 'git pull --rebase', value)
      assert.equal(operation(`git pull --rebase=${value}`), 'git pull --rebase', value)
    }
    // A key with no value is true, and config keys are case-insensitive.
    assert.equal(operation('git -c pull.rebase pull'), 'git pull --rebase')
    assert.equal(operation('git -c Pull.Rebase=yes pull'), 'git pull --rebase')
    // Falsy spellings do not rebase.
    for (const value of ['false', 'no', 'off', '0', 'FALSE']) {
      assert.equal(operation(`git -c pull.rebase=${value} pull`), undefined, value)
      assert.equal(operation(`git pull --rebase=${value}`), undefined, value)
    }
  })

  it('lets the last setting win, as Git does', () => {
    assert.equal(operation('git -c pull.rebase=true -c pull.rebase=false pull'), undefined)
    assert.equal(
      operation('git -c pull.rebase=false -c pull.rebase=true pull'),
      'git pull --rebase',
    )
    assert.equal(operation('git pull --rebase --no-rebase'), undefined)
    assert.equal(operation('git pull --no-rebase --rebase'), 'git pull --rebase')
    // The command line overrides config in both directions.
    assert.equal(operation('git -c pull.rebase=true pull --no-rebase'), undefined)
    assert.equal(operation('git -c pull.rebase=false pull --rebase'), 'git pull --rebase')
  })

  it('refuses starting a bisect and a detached switch', () => {
    assert.equal(operation('git bisect start HEAD HEAD~10'), 'git bisect start')
    assert.equal(operation('git switch --detach HEAD~2'), 'git switch --detach')
    assert.equal(operation('git switch -d v1.0'), 'git switch --detach')
    assert.equal(operation('git checkout --detach origin/main'), 'git checkout --detach')
  })

  it('leaves the way out of an interrupted operation open', () => {
    assert.equal(operation('git rebase --abort'), undefined)
    assert.equal(operation('git rebase --continue'), undefined)
    assert.equal(operation('git rebase --skip'), undefined)
    assert.equal(operation('git rebase --quit'), undefined)
    assert.equal(operation('git bisect reset'), undefined)
    assert.equal(operation('git bisect log'), undefined)
    assert.equal(operation('git bisect good'), undefined)
  })

  it('ignores commands that only mention these words', () => {
    assert.equal(operation('git status'), undefined)
    assert.equal(operation('git merge main'), undefined)
    assert.equal(operation('git switch -c feature'), undefined)
    assert.equal(operation('git checkout main'), undefined)
    assert.equal(operation('git commit -m "rebase the docs"'), undefined)
    assert.equal(operation('echo git rebase main'), undefined)
    assert.equal(operation('grep -rn "git rebase" docs/'), undefined)
    assert.equal(operation('git log --grep=rebase'), undefined)
  })
})
