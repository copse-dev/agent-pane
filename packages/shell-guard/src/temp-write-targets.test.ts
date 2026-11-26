import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tempWriteTargets } from './temp-write-targets.ts'

const root = '/Users/dev/project'

describe('tempWriteTargets', () => {
  it('names the literal /tmp paths of a command that is otherwise contained', () => {
    assert.deepEqual(
      tempWriteTargets(
        'curl -s -c /tmp/rider_cookies.txt -b /tmp/rider_cookies.txt "http://localhost:3000/api/me"',
        root,
      ),
      ['/tmp/rider_cookies.txt'],
    )
    assert.deepEqual(
      tempWriteTargets(
        'cd xmas && (node src/server.js > /tmp/xmas-server.log 2>&1 &) ; sleep 1; cat /tmp/xmas-server.log',
        root,
      ),
      ['/tmp/xmas-server.log'],
    )
    assert.deepEqual(
      tempWriteTargets(
        'BASE=http://localhost:3000\nJAR=/tmp/jar.txt\ncurl -s -c "$JAR" "$BASE/x"',
        root,
      ),
      ['/tmp/jar.txt'],
    )
    assert.deepEqual(tempWriteTargets('mkdir -p /private/tmp/shots/', root), ['/private/tmp/shots'])
  })

  it('refuses anything it cannot pin to named /tmp paths', () => {
    for (const command of [
      'ls',
      'echo x > /tmp',
      'cat /tmp/*.log',
      'cp a "/tmp/$NAME"',
      'cp a /tmp/../etc/x',
      'cp a /var/tmp/x',
      'curl https://example.com -o /tmp/x',
      'cp ~/.ssh/id_rsa /tmp/k',
      'rm -rf /tmp/build',
    ])
      assert.equal(tempWriteTargets(command, root), null, command)
    assert.equal(tempWriteTargets('touch /tmp/x', null), null)
  })
})
