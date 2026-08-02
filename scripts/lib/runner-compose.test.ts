import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runnerComposeStartupCommands } from './runner-compose.mts'

describe('runnerComposeStartupCommands', () => {
  it('probes bubblewrap before starting runners', () => {
    assert.deepEqual(runnerComposeStartupCommands(2), [
      'docker compose build --pull',
      'docker compose run --rm --no-deps --entrypoint bwrap runner --new-session --die-with-parent --ro-bind / / --unshare-net --unshare-pid --unshare-user --cap-drop ALL --proc /proc -- /usr/bin/true',
      'docker compose up -d --no-build --scale runner=2',
      'docker compose ps',
    ])
  })

  it('rejects invalid runner counts', () => {
    assert.throws(() => runnerComposeStartupCommands(0), /positive safe integer/)
    assert.throws(() => runnerComposeStartupCommands(1.5), /positive safe integer/)
  })
})
