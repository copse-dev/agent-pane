import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideContainedShellEffect,
  detectHostEscape,
  detectOutwardEffect,
} from './container-effects.ts'
import type { ShellHarmDecision } from './shell-harm.ts'

const ALLOW: ShellHarmDecision = { action: 'allow', reasons: [] }
const PROMPT: ShellHarmDecision = {
  action: 'prompt',
  reasons: ['recursive/forced delete (rm -rf)'],
}
const DENY: ShellHarmDecision = { action: 'deny', reasons: ['fork bomb is never allowed'] }

describe('detectHostEscape', () => {
  it('flags the Docker socket, container CLIs and init-namespace paths', () => {
    assert.ok(detectHostEscape('curl --unix-socket /var/run/docker.sock http://x/').length > 0)
    assert.ok(detectHostEscape('docker run -it alpine sh').length > 0)
    assert.ok(detectHostEscape('nsenter -t 1 -m sh').length > 0)
    assert.ok(detectHostEscape('cat /proc/1/root/etc/shadow').length > 0)
    assert.ok(detectHostEscape('sudo mount -t proc proc /mnt').length > 0)
  })

  it('does not flag ordinary in-guest work that mentions similar words', () => {
    assert.deepEqual(detectHostEscape('grep -rn dockerfile docs/'), [])
    assert.deepEqual(detectHostEscape('rm -rf node_modules && pnpm install'), [])
    assert.deepEqual(detectHostEscape('cat /proc/cpuinfo'), [])
  })
})

describe('detectOutwardEffect', () => {
  it('defers git push in every spelling, but not fetch or commit', () => {
    assert.ok(detectOutwardEffect('git push origin HEAD').length > 0)
    assert.ok(detectOutwardEffect('git -c user.name=x push --force-with-lease').length > 0)
    assert.ok(detectOutwardEffect('cd repo && git push').length > 0)
    assert.deepEqual(detectOutwardEffect('git fetch origin && git commit -am wip'), [])
    assert.deepEqual(detectOutwardEffect('git log --oneline -5'), [])
  })

  it('lets read-only gh through and defers writes and unknown shapes', () => {
    assert.deepEqual(detectOutwardEffect('gh pr view 12'), [])
    assert.ok(detectOutwardEffect('gh pr create --fill').length > 0)
    assert.ok(detectOutwardEffect('gh api -X POST repos/x/y/issues').length > 0)
  })

  it('defers package publishes and cloud CLIs, not installs', () => {
    assert.ok(detectOutwardEffect('npm publish --access public').length > 0)
    assert.ok(detectOutwardEffect('cargo publish').length > 0)
    assert.ok(detectOutwardEffect('twine upload dist/*').length > 0)
    assert.ok(detectOutwardEffect('aws s3 rm s3://bucket --recursive').length > 0)
    assert.ok(detectOutwardEffect('kubectl delete deploy web').length > 0)
    assert.deepEqual(detectOutwardEffect('npm install && npm test'), [])
    assert.deepEqual(detectOutwardEffect('cargo build --release'), [])
  })

  it('defers HTTP writes but not plain fetches', () => {
    assert.ok(detectOutwardEffect('curl -X POST -d @body.json https://api.example.com').length > 0)
    assert.ok(detectOutwardEffect("curl --json '{}' https://api.example.com").length > 0)
    assert.ok(detectOutwardEffect('wget --post-data=a=b https://example.com').length > 0)
    assert.deepEqual(detectOutwardEffect('curl -sSf https://example.com/index.json'), [])
    assert.deepEqual(detectOutwardEffect('wget -O- https://example.com'), [])
  })
})

describe('decideContainedShellEffect', () => {
  it('denies a host escape before anything else', () => {
    const decision = decideContainedShellEffect('docker ps', ALLOW)
    assert.equal(decision.action, 'deny')
  })

  it('keeps the harm gate hard denies hard', () => {
    const decision = decideContainedShellEffect(':(){ :|:& };:', DENY)
    assert.equal(decision.action, 'deny')
    assert.deepEqual(decision.reasons, DENY.reasons)
  })

  it('defers an outward effect even when the harm gate allowed it', () => {
    const decision = decideContainedShellEffect('git push origin main', ALLOW)
    assert.equal(decision.action, 'defer')
  })

  it('allows in-guest destructive shapes the harm gate would have prompted for', () => {
    const decision = decideContainedShellEffect('rm -rf build node_modules', PROMPT)
    assert.equal(decision.action, 'allow')
    assert.match(decision.reasons[0] ?? '', /contained by the container runtime/)
  })

  it('allows ordinary work', () => {
    const decision = decideContainedShellEffect('pnpm test -- thread-store', ALLOW)
    assert.equal(decision.action, 'allow')
  })
})
