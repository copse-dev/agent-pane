import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
import { PII_REDACTION_PACK_ID } from '@copse/agent/packs/pii-redaction-pack.ts'
import { runWithActiveRunIdentity, setActiveRunThread } from '../services/thread-models.ts'
import { setApprovalHandler, type ApprovalRequest } from '../services/approval.ts'
import {
  redactUserContent,
  setRampartLoaderForTest,
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
    // `copse.pii-redaction` ships off (`defaultEnabled: false`), so opt in
    // explicitly — the enabled pack is what arms the input rewrite below.
    const registry = createFirstPartyPackRegistry()
    registry.enable(PII_REDACTION_PACK_ID)
    setDefaultPackRegistry(registry)
    await redactUserContent('thread-1', 'email john@example.com')
  })

  afterEach(() => {
    setApprovalHandler(null)
    setRampartLoaderForTest(null)
    setDefaultPackRegistry(null)
  })

  it('reveals the value after the user approves', async () => {
    const seen: ApprovalRequest[] = []
    setApprovalHandler((req) => {
      seen.push(req)
      return Promise.resolve({ approved: true, remember: false })
    })
    const out = await runWithActiveRunIdentity('thread-1', () => {
      setActiveRunThread('thread-1')
      return runReveal('[PII_1]')
    })
    assert.equal(out, '[PII_1] = john@example.com')
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.type, 'pii')
  })

  it('does not reveal when the user declines', async () => {
    setApprovalHandler(() => Promise.resolve({ approved: false, remember: false }))
    const out = await runWithActiveRunIdentity('thread-1', () => {
      setActiveRunThread('thread-1')
      return runReveal('[PII_1]')
    })
    assert.match(out, /declined/)
    assert.doesNotMatch(out, /john@example\.com/)
  })

  it('does not prompt for an unknown placeholder', async () => {
    let prompted = false
    setApprovalHandler(() => {
      prompted = true
      return Promise.resolve({ approved: true, remember: false })
    })
    const out = await runWithActiveRunIdentity('thread-1', () => {
      setActiveRunThread('thread-1')
      return runReveal('[PII_9]')
    })
    assert.match(out, /not a known/)
    assert.equal(prompted, false)
  })
})
