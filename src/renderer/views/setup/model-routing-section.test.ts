import '../../../../tests/setup-dom.ts'
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { createModelRoutingSection } from './model-routing-section.ts'

describe('saved model-role editor', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('initializes every role from one snapshot without reading or saving ordinary preferences', async () => {
    const base = createFakeApi()
    const reads: string[] = []
    const writes: string[] = []
    const api = {
      ...base,
      settings: {
        ...base.settings,
        get: async (key: string): Promise<unknown> => {
          reads.push(key)
          return undefined
        },
        set: async (key: string): Promise<void> => {
          writes.push(key)
        },
      },
    }
    const section = createModelRoutingSection(api, { modelScope: 'all' })
    document.body.append(section.root)
    await section.refresh({
      roleModels: { docs: 'removed-provider:docs', research: 'gpt-5-mini' },
      safetyModel: 'removed-provider:safety',
    })
    for (const name of [
      'roleModels',
      'localDefaultModel',
      'subagentModel',
      'safetyModel',
      'reviewModel',
    ])
      assert.equal(reads.includes(name), false, name)
    assert.deepEqual(writes, [])
    assert.equal(
      qsRequired<HTMLSelectElement>(section.root, 'select[name="role:docs"]').value,
      'removed-provider:docs',
    )
    assert.equal(
      qsRequired<HTMLSelectElement>(section.root, 'select[name="subagentModel"]').value,
      'gpt-5-mini',
    )
    assert.equal(
      qsRequired<HTMLSelectElement>(section.root, 'select[name="safetyModel"]').value,
      'removed-provider:safety',
    )
    assert.equal(
      qsRequired(section.root, '[data-model-setting-target="role:docs"]').tagName,
      'BUTTON',
    )
    assert.equal(section.readRoleModels(), undefined)
  })

  it('contributes only edited assignments so parent Save cannot overwrite another role', async () => {
    const section = createModelRoutingSection(createFakeApi(), { modelScope: 'all' })
    document.body.append(section.root)
    await section.refresh({ roleModels: { docs: 'removed-provider:docs', planner: 'gpt-5-mini' } })
    const docs = qsRequired<HTMLSelectElement>(section.root, 'select[name="role:docs"]')
    docs.value = ''
    docs.dispatchEvent(new Event('change', { bubbles: true }))
    assert.deepEqual(section.readRoleModels(), { docs: '' })
    await section.refresh({ roleModels: { docs: '', planner: 'gpt-5-mini' } })
    assert.equal(section.readRoleModels(), undefined)
  })

  it('keeps onboarding scoped to its four local fields', async () => {
    const section = createModelRoutingSection(createFakeApi(), { modelScope: 'local' })
    document.body.append(section.root)
    await section.refresh({ localDefaultModel: 'qwen/qwen3.6-35b-a3b' })
    assert.equal(section.root.querySelectorAll('select').length, 4)
    assert.equal(section.root.querySelector('.routing-additional-roles'), null)
    assert.equal(section.readRoleModels(), undefined)
  })
})
