import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeReadOutsideProject,
  describeReadOutsideTargets,
  formatReadOutsideProjectPromptParts,
  readOutsideProjectGrantTargets,
  sensitiveTargetReason,
} from './read-outside-project.ts'

const ROOT = '/work/project'
const HOME = '/home/dev'

function analyze(
  command: string,
  root: string | null = ROOT,
): ReturnType<typeof analyzeReadOutsideProject> {
  return analyzeReadOutsideProject(command, root, { homeDir: HOME })
}

describe('analyzeReadOutsideProject — eligible reads', () => {
  it('accepts a listing of a home-directory folder', () => {
    const analysis = analyze('ls -la ~/.copse')
    assert.equal(analysis.eligible, true)
    assert.deepEqual(analysis.targets, ['~/.copse'])
  })

  it('accepts the compound read the sandbox prompt was reported for', () => {
    const analysis = analyze(
      'echo "=== ~/.copse top ==="; ls -la ~/.copse 2>/dev/null; echo; ' +
        'find ~/.copse -maxdepth 2 2>/dev/null | head -100',
    )
    assert.equal(analysis.eligible, true, analysis.blockers.join('; '))
    assert.deepEqual(analysis.targets, ['~/.copse'])
  })

  it('accepts absolute and $HOME-rooted reads outside the project', () => {
    assert.equal(analyze('cat /etc/hosts').eligible, true)
    assert.equal(analyze('cat $HOME/.copse/config.json').eligible, true)
    assert.equal(analyze('grep -n proxy ${HOME}/.gitconfig').eligible, true)
  })

  it('accepts a read-only git command against a checkout outside the project', () => {
    assert.equal(analyze('git log --oneline -5 ../sibling-repo').eligible, true)
  })

  it('reports every distinct outside target it reads', () => {
    const analysis = analyze('cat /etc/hosts ~/.gitconfig')
    assert.deepEqual(analysis.targets, ['/etc/hosts', '~/.gitconfig'])
  })
})

describe('analyzeReadOutsideProject — ineligible commands', () => {
  const ineligible = (command: string, expected: RegExp): void => {
    const analysis = analyze(command)
    assert.equal(analysis.eligible, false, `expected ${command} to be ineligible`)
    assert.match(analysis.blockers.join('; '), expected)
  }

  it('rejects commands that read nothing outside the project', () => {
    ineligible('cat src/index.ts', /nothing outside the project/)
    ineligible('ls -la', /nothing outside the project/)
  })

  it('rejects anything that is not a plain read', () => {
    ineligible('curl https://example.com/x > ~/out.txt', /not a plain read/)
    ineligible('cp ~/.gitconfig /tmp/x', /not a plain read/)
    ineligible('git push origin ~/x', /not a plain read/)
    ineligible('node ~/script.js', /not a plain read/)
  })

  it('rejects writes, even from a read command', () => {
    ineligible('cat ~/.gitconfig > ~/copy', /writes to/)
    ineligible('sort -o ~/sorted ~/.gitconfig', /asked to write/)
    ineligible('find ~/notes -delete', /find -delete|asked to write/)
    ineligible('find ~/notes -exec rm {} ;', /asked to execute/)
  })

  it('rejects text it cannot resolve to a path', () => {
    ineligible('cat $(which node)', /command substitution/)
    ineligible('cat "$CONFIG_PATH"', /variable expansion/)
    ineligible('cat `ls ~`', /command substitution/)
  })

  it('rejects privilege and environment wrappers even around a read', () => {
    ineligible('sudo cat /etc/shadow', /changes how the command runs|credential file/)
    ineligible('env PATH=/evil cat ~/.gitconfig', /changes how the command runs/)
    ineligible('xargs cat < ~/list', /changes how the command runs|writes to/)
  })

  it('rejects destructive shapes the sandbox itself would still prompt for', () => {
    ineligible('cat ~/.gitconfig | sh', /interpreter/)
  })

  it('has nothing to compare against without a project root', () => {
    const analysis = analyze('cat ~/.gitconfig', null)
    assert.equal(analysis.eligible, false)
    assert.deepEqual(analysis.blockers, ['no project root'])
  })
})

describe('analyzeReadOutsideProject — contained', () => {
  const contained = (command: string): ReturnType<typeof analyzeReadOutsideProject> =>
    analyzeReadOutsideProject(command, ROOT, { homeDir: HOME, contained: true })

  it('accepts an unrecognised head the seatbelt will bound anyway', () => {
    const analysis = contained('yq .name ~/.copse/config.yaml')
    assert.equal(analysis.eligible, true, analysis.blockers.join('; '))
    assert.deepEqual(analysis.targets, ['~/.copse/config.yaml'])
    // Same command without a sandbox to bound it keeps prompting as before.
    assert.match(analyze('yq .name ~/.copse/config.yaml').blockers.join('; '), /not a plain read/)
  })

  it('accepts exec flags, whose child inherits the same seatbelt', () => {
    assert.equal(contained('fd -x head ~/notes').eligible, true)
    assert.equal(contained('rg --pre ~/bin/strip TODO ~/notes').eligible, true)
    assert.match(analyze('fd -x head ~/notes').blockers.join('; '), /asked to execute/)
  })

  it('leaves `find -exec` refused, on the containment guard rather than the flag', () => {
    // The relaxed flag check no longer objects, but `-exec` reads as dynamic
    // execution to the scope analysis, so containment is not offered for it at
    // all. Belt and braces, and the belt is the one that holds.
    const analysis = contained('find ~/notes -name "*.md" -exec head -1 {} ;')
    assert.equal(analysis.eligible, false)
    assert.deepEqual(analysis.blockers, ['needs more than reads outside the project'])
  })

  it('still refuses writes, which the seatbelt permits inside the workspace', () => {
    assert.equal(contained('sort -o out.txt ~/.gitconfig').eligible, false)
    assert.equal(contained('cat ~/.gitconfig > notes.txt').eligible, false)
    assert.equal(contained('find ~/notes -delete').eligible, false)
    assert.equal(contained('git commit -m x ~/elsewhere').eligible, false)
  })

  it('still refuses credential and whole-machine targets, which build the overlay', () => {
    assert.equal(contained('jq . ~/.aws/credentials').eligible, false)
    assert.equal(contained('anything ~/.ssh/id_rsa').eligible, false)
    assert.equal(contained('ls ~').eligible, false)
    assert.equal(contained('ls /').eligible, false)
  })

  it('still refuses wrappers and hidden expansions', () => {
    assert.equal(contained('sudo jq . ~/.copse/config.json').eligible, false)
    assert.equal(contained('jq . $(find ~ -name config.json)').eligible, false)
    assert.equal(contained('jq . "$CONFIG"').eligible, false)
  })

  it('refuses a relaxed head that needs more than an outside read', () => {
    // Without this, an unrecognised head carrying a URL reads as a plain read at
    // the gate, and the tool then runs it UNSANDBOXED on that answer because it
    // declines to contain a network command.
    assert.equal(contained('curl https://example.com --config ~/.curlrc').eligible, false)
    assert.equal(contained('node ~/script.js').eligible, false)
  })
})

describe('analyzeReadOutsideProject — credentials and breadth', () => {
  const refused = (command: string): void => {
    const analysis = analyze(command)
    assert.equal(analysis.eligible, false, `expected ${command} to be refused`)
  }

  it('refuses credential files by name, including dotenv variants and globs', () => {
    refused('cat ~/.env')
    refused('cat ~/projects/other/.env.production')
    refused('cat ~/.env*')
    refused('cat ~/deploy.pem')
    refused('cat ~/.netrc')
    refused('cat ~/service-credentials.json')
  })

  it('refuses credential directories whole', () => {
    refused('ls -la ~/.ssh')
    refused('cat ~/.ssh/id_ed25519')
    refused('cat ~/.aws/config')
    refused('cat ~/.config/gh/hosts.yml')
    refused('ls ~/Library/Keychains')
  })

  it('refuses targets so broad that a grant is indistinguishable from the machine', () => {
    refused('ls -la ~')
    refused('ls -la $HOME')
    refused('find / -maxdepth 1')
  })

  it('still allows an ordinary directory under home', () => {
    assert.equal(analyze('ls ~/notes').eligible, true)
  })
})

describe('sensitiveTargetReason', () => {
  it('reports the reason a target is refused, or null for an ordinary file', () => {
    assert.match(sensitiveTargetReason('~/.env', `${HOME}/.env`) ?? '', /credential file/)
    assert.match(
      sensitiveTargetReason('~/.ssh/known_hosts', `${HOME}/.ssh/known_hosts`) ?? '',
      /credential directory/,
    )
    assert.equal(sensitiveTargetReason('~/notes/todo.md', `${HOME}/notes/todo.md`), null)
  })
})

describe('readOutsideProjectGrantTargets', () => {
  it('returns the resolved paths a seatbelt can name, not the tokens as written', () => {
    assert.deepEqual(readOutsideProjectGrantTargets('ls -la ~/.copse', ROOT, { homeDir: HOME }), [
      `${HOME}/.copse`,
    ])
  })

  it('resolves every distinct target of a compound read', () => {
    const targets = readOutsideProjectGrantTargets(
      'ls -la ~/.copse 2>/dev/null; cat ~/notes/todo.md',
      ROOT,
      { homeDir: HOME },
    )
    assert.deepEqual(targets, [`${HOME}/.copse`, `${HOME}/notes/todo.md`])
  })

  it('refuses a command the read analysis will not account for', () => {
    // Credential target, command substitution, and a writing head each keep the
    // command on its normal routing — no grant, so nothing to relax.
    assert.equal(readOutsideProjectGrantTargets('cat ~/.ssh/config', ROOT, { homeDir: HOME }), null)
    assert.equal(
      readOutsideProjectGrantTargets('cat $(find ~/x -type f)', ROOT, { homeDir: HOME }),
      null,
    )
    assert.equal(readOutsideProjectGrantTargets('rm -rf ~/.copse', ROOT, { homeDir: HOME }), null)
  })

  it('refuses a command with any network signal, so containment cannot break it', () => {
    // Two independent guards have to agree before a seatbelt is widened: the read
    // shape (`curl` is not a read head) and `externalOnlyForOutsidePath` (a read
    // head composed with a network command is still a network command).
    assert.equal(readOutsideProjectGrantTargets('curl https://x.test', ROOT), null)
    assert.equal(
      readOutsideProjectGrantTargets('cat ~/notes.md && curl https://x.test', ROOT, {
        homeDir: HOME,
      }),
      null,
    )
  })

  it('refuses a read that stays inside the project (nothing to widen)', () => {
    assert.equal(readOutsideProjectGrantTargets('cat src/index.ts', ROOT), null)
    assert.equal(readOutsideProjectGrantTargets('cat ~/notes.md', null), null)
  })
})

describe('read-outside prompt copy', () => {
  it('keeps the sensitive-locations warning and says what the grant covers', () => {
    const analysis = analyze('ls -la ~/.copse')
    const parts = formatReadOutsideProjectPromptParts('ls -la ~/.copse', analysis)
    assert.equal(parts.command, 'ls -la ~/.copse')
    assert.match(parts.bodyAdvice ?? '', /~\/\.copse/)
    assert.match(parts.bodyAdvice ?? '', /read from sensitive locations on your computer/)
    assert.match(parts.bodyFooter ?? '', /rest of this thread/)
    assert.match(parts.bodyFooter ?? '', /credential/)
  })

  it('summarises a long target list rather than listing all of it', () => {
    assert.equal(describeReadOutsideTargets(['a', 'b']), 'a, b')
    assert.equal(describeReadOutsideTargets(['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 more')
  })
})
