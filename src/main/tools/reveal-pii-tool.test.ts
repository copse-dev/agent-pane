import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../services/settings.ts'
import { setActiveRunThread, clearActiveRunThread } from '../services/thread-models.ts'
import { setApprovalHandler, type ApprovalRequest } from '../services/approval.ts'
import {
  redactUserContent,
  setRampartLoaderForTest,
  PII_REDACTION_ENABLED_SETTING,
  type RampartModule,
  type PiiGuard,
} from '../services/security/pii-redactor.ts'
import { normalizeToolExecuteResult } from '@shared/types'
import { revealPiiTool } from './reveal-pii-tool.ts'

const runReveal = async (placeholder: string): Promise<string> =>
  normalizeToolExecuteResult(await revealPiiTool.execute({ placeholder }, signal)).result

function fakeGuard(): PiiGuard {
  const reverse = new Map<string, string>()
  return {
    protect(text): Promise<{ text: string; placeholders: readonly string[] }> {
      const out = text.replace(/john@example\.com/g, () => {
        reverse.set('[PII_1]', 'john@example.com')
        return '[PII_1]'
      })
      return Promise.resolve({ text: out, placeholders: [...reverse.keys()] })
    },
    reveal(reply): string {
      let out = reply
      for (const [token, value] of reverse) out = out.split(token).join(value)
      return out
    },
  }
}

const fakeModule: RampartModule = { createGuard: () => Promise.resolve(fakeGuard()) }
const signal = new AbortController().signal

describe('reveal_pii tool', () => {
  beforeEach(async () => {
    setRampartLoaderForTest(() => Promise.resolve(fakeModule))
    await setSetting(PII_REDACTION_ENABLED_SETTING, true)
    await redactUserContent('thread-1', 'email john@example.com')
    setActiveRunThread('thread-1')
  })

  afterEach(async () => {
    clearActiveRunThread('thread-1')
    setApprovalHandler(null)
    setRampartLoaderForTest(null)
    await setSetting(PII_REDACTION_ENABLED_SETTING, false)
  })

  it('reveals the value after the user approves', async () => {
    const seen: ApprovalRequest[] = []
    setApprovalHandler((req) => {
      seen.push(req)
      return Promise.resolve({ approved: true, remember: false })
    })
    const out = await runReveal('[PII_1]')
    assert.equal(out, '[PII_1] = john@example.com')
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.type, 'pii')
  })

  it('does not reveal when the user declines', async () => {
    setApprovalHandler(() => Promise.resolve({ approved: false, remember: false }))
    const out = await runReveal('[PII_1]')
    assert.match(out, /declined/)
    assert.doesNotMatch(out, /john@example\.com/)
  })

  it('does not prompt for an unknown placeholder', async () => {
    let prompted = false
    setApprovalHandler(() => {
      prompted = true
      return Promise.resolve({ approved: true, remember: false })
    })
    const out = await runReveal('[PII_9]')
    assert.match(out, /not a known/)
    assert.equal(prompted, false)
  })
})
