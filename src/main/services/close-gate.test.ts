import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createCloseGate } from './close-gate.ts'

function fakeEvent(): { event: { preventDefault: () => void }; prevented: () => number } {
  let count = 0
  return {
    event: {
      preventDefault: (): void => {
        count += 1
      },
    },
    prevented: () => count,
  }
}

/** Let the gate's confirmation promise chain settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createCloseGate', () => {
  it('holds the close, then re-issues it once the user confirms', async () => {
    let reissued = 0
    const gate = createCloseGate({ requestConfirmation: () => Promise.resolve(true) })
    const first = fakeEvent()

    assert.equal(
      gate.defer(first.event, () => {
        reissued += 1
      }),
      true,
    )
    assert.equal(first.prevented(), 1)
    assert.equal(reissued, 0)

    await flush()
    assert.equal(reissued, 1)
    assert.equal(gate.isApproved(), true)

    // The re-issued close must sail through rather than ask again.
    const second = fakeEvent()
    assert.equal(
      gate.defer(second.event, () => {
        reissued += 1
      }),
      false,
    )
    assert.equal(second.prevented(), 0)
  })

  it('keeps the app up when the user refuses, and asks again next time', async () => {
    let asked = 0
    let reissued = 0
    let answer = false
    const gate = createCloseGate({
      requestConfirmation: () => {
        asked += 1
        return Promise.resolve(answer)
      },
    })

    const refused = fakeEvent()
    gate.defer(refused.event, () => {
      reissued += 1
    })
    await flush()
    assert.equal(reissued, 0)
    assert.equal(gate.isApproved(), false)

    answer = true
    const retried = fakeEvent()
    assert.equal(
      gate.defer(retried.event, () => {
        reissued += 1
      }),
      true,
    )
    await flush()
    assert.equal(asked, 2)
    assert.equal(reissued, 1)
  })

  it('asks once when closes pile up while the prompt is open', async () => {
    let asked = 0
    let reissued = 0
    const release: ((confirmed: boolean) => void)[] = []
    const gate = createCloseGate({
      requestConfirmation: () => {
        asked += 1
        return new Promise<boolean>((resolve) => {
          release.push(resolve)
        })
      },
    })

    const reissue = (): void => {
      reissued += 1
    }
    gate.defer(fakeEvent().event, reissue)
    gate.defer(fakeEvent().event, reissue)
    gate.defer(fakeEvent().event, reissue)
    assert.equal(asked, 1)

    release[0]?.(true)
    await flush()
    // One answer, but each held close is released — all of them re-issue against
    // an already-approved gate, so the app goes down once.
    assert.equal(reissued, 3)
    assert.equal(gate.isApproved(), true)
  })

  it('never asks once approved (signal quits skip the prompt)', () => {
    let asked = 0
    const gate = createCloseGate({
      requestConfirmation: () => {
        asked += 1
        return Promise.resolve(false)
      },
    })

    gate.approve()
    const event = fakeEvent()
    assert.equal(
      gate.defer(event.event, () => {}),
      false,
    )
    assert.equal(event.prevented(), 0)
    assert.equal(asked, 0)
  })
})
