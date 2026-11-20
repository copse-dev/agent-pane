import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  debugPortFromCapabilities,
  parseNetTcp,
  parseProcStat,
  parseTimelineLine,
  quitTimelineDir,
  summariseRelaunch,
  type TimelineLine,
} from '../tests/e2e/helpers/quit-timeline.ts'

describe('quit timeline /proc parsing', () => {
  it('reads pid, comm, state and ppid, even when comm holds spaces and parentheses', () => {
    assert.deepEqual(parseProcStat('4242 (git (x) y) S 4100 4242 4242 0 -1 4194560 3 0'), {
      pid: 4242,
      comm: 'git (x) y',
      state: 'S',
      ppid: 4100,
    })
    assert.equal(parseProcStat('garbage'), null)
  })

  it('keeps only sockets whose local port is the devtools port, and drops unowned ones', () => {
    // 0x2328 = 9000, 0x2329 = 9001.
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 111 1',
      '   1: 0100007F:2328 0100007F:B000 01 00000000:00000000 00:00000000 00000000  1001        0 222 1',
      '   2: 0100007F:B000 0100007F:2328 01 00000000:00000000 00:00000000 00000000  1001        0 333 1',
      '   3: 0100007F:2328 0100007F:B001 06 00000000:00000000 00:00000000 00000000     0        0 0 3',
      '   4: 0100007F:2329 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 444 1',
    ].join('\n')
    assert.deepEqual(parseNetTcp(table, 9000), [
      { inode: '111', state: 'LISTEN' },
      { inode: '222', state: 'ESTABLISHED' },
    ])
  })

  it('reads the devtools port from W3C and flat capabilities', () => {
    const args = ['--app=x', '--remote-debugging-port=9512']
    assert.equal(
      debugPortFromCapabilities({ browserName: 'chrome', 'goog:chromeOptions': { args } }),
      9512,
    )
    assert.equal(
      debugPortFromCapabilities({
        alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args } },
      }),
      9512,
    )
    assert.equal(debugPortFromCapabilities({ browserName: 'chrome' }), null)
    assert.equal(debugPortFromCapabilities(null), null)
  })

  it('writes outside the checkout unless told otherwise', () => {
    assert.equal(quitTimelineDir({ COPSE_E2E_QUIT_TIMELINE_DIR: '/x/y' }), '/x/y')
    assert.ok(!quitTimelineDir({}).startsWith(process.cwd()))
  })
})

describe('quit timeline summary', () => {
  const t0 = Date.parse('2026-11-20T00:00:00.000Z')
  const line = (offsetMs: number, source: string, event: string, detail = ''): TimelineLine => ({
    at: t0 + offsetMs,
    source,
    event,
    detail,
  })

  it('parses a timeline line and rejects one without a timestamp', () => {
    assert.deepEqual(parseTimelineLine('2026-11-20T00:00:01.000Z app before-quit #1'), {
      at: t0 + 1_000,
      source: 'app',
      event: 'before-quit',
      detail: '#1',
    })
    assert.equal(parseTimelineLine('not a time app before-quit'), null)
  })

  it('reports each milestone relative to the pre-close and flags a slow quit', () => {
    const summary = summariseRelaunch({
      seq: 3,
      spec: 'scroll-to-bottom.e2e.ts',
      pid: 4100,
      port: 9512,
      t0,
      lines: [
        line(0, 'harness', 'markQuit:start'),
        line(10, 'harness', 'closeWindow:start'),
        line(40, 'app', 'window-close', 'id=1'),
        line(60, 'app', 'before-quit', '#1'),
        line(70, 'app', 'console', '[shutdown] cleanup:start deadline=30000ms'),
        line(90, 'app', 'console', '[shutdown] step:end stopAllAgentRuns 1.2ms ok'),
        line(29_000, 'app', 'child', 'deadline-0.5s pid=5000 ppid=4100 state=S comm=git argv=git'),
        line(29_001, 'app', 'child', 'deadline-0.5s pid=5001 ppid=4100 state=S comm=git argv=git'),
        line(
          30_060,
          'app',
          'console',
          '[shutdown] deadline: open steps disposeAllAcpSessions(29900ms)',
        ),
        line(30_070, 'app', 'console', '[shutdown] cleanup:outcome timed-out'),
        line(30_071, 'app', 'app.exit-called', 'code=0'),
        line(30_080, 'app', 'loop-stall', '450ms'),
        line(30_100, 'app', 'process-exit', 'code=0'),
        line(45_010, 'harness', 'pre-close:error', 'WebDriverError: invalid session id'),
        line(31_000, 'harness', 'port-holders', '4100:electron[LISTEN:1] 5000:git[ESTABLISHED:1]'),
        line(45_200, 'harness', 'pid-gone', 'state=gone'),
        line(45_210, 'harness', 'port-holders', '5000:git[ESTABLISHED:1]'),
        line(45_300, 'harness', 'port-free'),
      ],
    })
    assert.equal(summary.slow, true)
    assert.match(summary.text, /^SLOW #3 scroll-to-bottom\.e2e\.ts pid=4100 port=9512 /)
    assert.match(summary.text, / closeWindow=45000ms\(error\) /)
    assert.match(summary.text, / before-quit=\+60ms /)
    assert.match(summary.text, / cleanup=timed-out@\+30070ms /)
    assert.match(summary.text, / exit-call=app\.exit@\+30071ms /)
    assert.match(summary.text, / pid-gone=\+45200ms port-free=\+45300ms /)
    assert.match(summary.text, / holders-after-exit=\[5000:git\[ESTABLISHED:1\]\] /)
    assert.match(summary.text, / slowest=\[stopAllAgentRuns:1ms\] /)
    assert.match(summary.text, / open@deadline=\[disposeAllAcpSessions\(29900ms\)\] /)
    assert.match(summary.text, / children@deadline=\[gitx2\] /)
    assert.match(summary.text, / stalls=1\/max450ms$/)
  })

  it('does not flag a quick relaunch, and says so when the quit never started', () => {
    const summary = summariseRelaunch({
      seq: 1,
      spec: 'a.e2e.ts',
      pid: 1,
      port: 2,
      t0,
      lines: [
        line(10, 'harness', 'closeWindow:start'),
        line(900, 'harness', 'closeWindow:end'),
        line(1_000, 'harness', 'pid-gone', 'state=gone'),
        line(1_100, 'harness', 'port-free'),
      ],
    })
    assert.equal(summary.slow, false)
    assert.match(summary.text, / before-quit=none cleanup=none@none exit-call=none /)
  })
})
