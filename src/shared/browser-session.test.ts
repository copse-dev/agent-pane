import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BROWSER_AGENT_SESSION_PARTITION,
  BROWSER_SESSION_PARTITION,
  isBrowserSessionPartition,
  isVisibleBrowserSessionForThread,
  isVisibleBrowserSessionPartition,
  browserSessionPartition,
  browserThreadScope,
} from './browser-session.ts'

describe('browser-session', () => {
  it('recognizes both isolated browser partitions', () => {
    assert.equal(isBrowserSessionPartition(BROWSER_SESSION_PARTITION), true)
    assert.equal(isBrowserSessionPartition(BROWSER_AGENT_SESSION_PARTITION), true)
    assert.equal(isBrowserSessionPartition(''), false)
    assert.equal(isBrowserSessionPartition('persist:other'), false)
  })

  it('uses distinct partitions for the pane and the agent', () => {
    assert.notEqual(BROWSER_SESSION_PARTITION, BROWSER_AGENT_SESSION_PARTITION)
  })
  it('allows only visible profiles for window-owned sharing', () => {
    assert.equal(isVisibleBrowserSessionPartition(BROWSER_SESSION_PARTITION), true)
    assert.equal(
      isVisibleBrowserSessionPartition(
        browserSessionPartition(BROWSER_SESSION_PARTITION, browserThreadScope('project', 'task')),
      ),
      true,
    )
    assert.equal(isVisibleBrowserSessionPartition(BROWSER_AGENT_SESSION_PARTITION), false)
    assert.equal(
      isVisibleBrowserSessionPartition(
        browserSessionPartition(
          BROWSER_AGENT_SESSION_PARTITION,
          browserThreadScope('project', 'task'),
        ),
      ),
      false,
    )
    assert.equal(
      isVisibleBrowserSessionPartition(`${BROWSER_SESSION_PARTITION}:thread:%bad`),
      false,
    )
  })
  it('fails closed for another task, legacy profiles, and malformed task ownership', () => {
    const partition = browserSessionPartition(
      BROWSER_SESSION_PARTITION,
      browserThreadScope('project', 'task'),
    )
    assert.equal(isVisibleBrowserSessionForThread(partition, 'task'), true)
    assert.equal(isVisibleBrowserSessionForThread(partition, 'other-task'), false)
    assert.equal(isVisibleBrowserSessionForThread(BROWSER_SESSION_PARTITION, 'task'), false)
    assert.equal(
      isVisibleBrowserSessionForThread(`${BROWSER_SESSION_PARTITION}:thread:%bad`, 'task'),
      false,
    )
    assert.equal(
      isVisibleBrowserSessionForThread(
        browserSessionPartition(
          BROWSER_AGENT_SESSION_PARTITION,
          browserThreadScope('project', 'task'),
        ),
        'task',
      ),
      false,
    )
  })
})
