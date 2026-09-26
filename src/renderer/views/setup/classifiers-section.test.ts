import '../../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type {
  ClassifierProfile,
  ClassifierProfileStatus,
  ClassifierResult,
} from '@copse/llm/classifiers/types.ts'
import { createClassifiersSection } from './classifiers-section.ts'
import { qsRequired } from '../../dom/helpers.ts'
import {
  mountConfirmDialog,
  clickActiveConfirmDialogCancel,
  clickActiveConfirmDialogConfirm,
} from '../confirm-dialog.ts'

const HTTP_PROFILE: ClassifierProfile = {
  id: 'fixture',
  label: 'Fixture classifier',
  model: 'fixture-v1',
  timeoutMs: 30_000,
  connection: {
    type: 'http',
    protocol: 'systemone',
    baseUrl: 'http://127.0.0.1:8009/v1',
    auth: 'bearer',
  },
}
const RESULT: ClassifierResult = {
  profileId: 'fixture',
  adapter: 'systemone',
  requestedModel: 'fixture-v1',
  model: 'fixture-v1',
  elapsedMs: 24,
  answers: { color: { type: 'choice', choice: 'red', probabilities: { red: 0.95, blue: 0.05 } } },
}

function setup(initial: ClassifierProfile[] = [HTTP_PROFILE]): {
  section: ReturnType<typeof createClassifiersSection>
  state: {
    profiles: ClassifierProfileStatus[]
    tests: string[]
    saves: ClassifierProfile[]
    keys: Array<{ id: string; key: string; allowPlaintext: boolean }>
    plaintext: boolean
    plaintextDisabled: boolean
    failure: string | null
    keyFailure: string | null
    removals: string[]
    screening: string | null
    screenings: Array<string | null>
  }
} {
  const state = {
    profiles: initial.map((profile): ClassifierProfileStatus => ({
      profile: structuredClone(profile),
      hasKey: false,
      encrypted: null,
    })),
    screening: null as string | null,
    screenings: new Array<string | null>(),
    tests: new Array<string>(),
    saves: new Array<ClassifierProfile>(),
    keys: new Array<{ id: string; key: string; allowPlaintext: boolean }>(),
    plaintext: false,
    plaintextDisabled: false,
    failure: null as string | null,
    keyFailure: null as string | null,
    removals: new Array<string>(),
  }
  const api: Parameters<typeof createClassifiersSection>[0] = {
    classifiers: {
      list: async () => structuredClone(state.profiles),
      save: async (profile) => {
        if (state.failure) throw new Error(state.failure)
        state.saves.push(structuredClone(profile))
        const existing = state.profiles.find((item) => item.profile.id === profile.id)
        if (existing) existing.profile = structuredClone(profile)
        else
          state.profiles.push({
            profile: structuredClone(profile),
            hasKey: false,
            encrypted: null,
          })
        return structuredClone(state.profiles)
      },
      remove: async (id) => {
        state.removals.push(id)
        state.profiles = state.profiles.filter((item) => item.profile.id !== id)
        if (state.screening === id) state.screening = null
        return structuredClone(state.profiles)
      },
      test: async (id) => {
        state.tests.push(id)
        if (state.failure) throw new Error(state.failure)
        return RESULT
      },
      screening: async () => state.screening,
      setScreening: async (id) => {
        state.screenings.push(id)
        if (state.failure) throw new Error(state.failure)
        state.screening = id
        return state.screening
      },
    },
    settings: {
      setKey: async (id, key, options) => {
        state.keys.push({ id, key, allowPlaintext: options?.allowPlaintext === true })
        if (state.keyFailure) throw new Error(state.keyFailure)
        if (state.plaintextDisabled) return { ok: false, reason: 'plaintext-storage-disabled' }
        if (state.plaintext && !options?.allowPlaintext)
          return { ok: false, reason: 'plaintext-consent-required' }
        const existing = state.profiles.find((item) => `classifier-${item.profile.id}` === id)
        if (existing) {
          existing.hasKey = key.length > 0
          existing.encrypted = key ? !state.plaintext : null
        }
        return { ok: true }
      },
    },
  }
  const section = createClassifiersSection(api)
  document.body.append(section.root)
  return { section, state }
}

function button(root: HTMLElement, name: string): HTMLButtonElement {
  return qsRequired<HTMLButtonElement>(root, `.classifier-${name}`)
}
function field(root: HTMLElement, name: string): HTMLInputElement {
  return qsRequired<HTMLInputElement>(root, `[name="classifier${name}"]`)
}
function enter(root: HTMLElement, name: string, value: string): void {
  const input = field(root, name)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  document.body.replaceChildren()
  mountConfirmDialog()
})

describe('classifier connections settings', () => {
  it('routes safety screening to a saved connection and back without an inference call', async () => {
    const { section, state } = setup([
      HTTP_PROFILE,
      { ...HTTP_PROFILE, id: 'other', label: 'Other' },
      {
        id: 'local-semif',
        label: 'Local SemIf',
        model: '/models/semif',
        timeoutMs: 30_000,
        connection: {
          type: 'semif',
          executable: 'semif-score',
          backend: 'torch',
          revision: 'local',
          mode: 'direct',
        },
      },
    ])
    state.screening = 'other'
    await section.refresh()
    const screening = qsRequired<HTMLSelectElement>(section.root, '[name="classifierScreening"]')
    assert.deepEqual(
      [...screening.options].map((option) => [option.value, option.textContent]),
      [
        ['', 'Instruct / safety model'],
        ['fixture', 'Fixture classifier'],
        ['other', 'Other'],
      ],
    )
    // A per-call SemIf scorer cannot answer within the screening budget.
    assert.equal(screening.value, 'other')

    screening.value = 'fixture'
    screening.dispatchEvent(new Event('change'))
    await setImmediate()
    assert.deepEqual(state.screenings, ['fixture'])
    assert.equal(screening.value, 'fixture')
    assert.match(section.root.textContent, /Safety screening now uses Fixture classifier/)

    screening.value = ''
    screening.dispatchEvent(new Event('change'))
    await setImmediate()
    assert.deepEqual(state.screenings, ['fixture', null])
    assert.equal(screening.value, '')
    assert.match(section.root.textContent, /now uses the Instruct \/ safety model/)
    assert.deepEqual(state.tests, [])
  })

  it('restores the saved screening choice when switching fails', async () => {
    const { section, state } = setup()
    await section.refresh()
    const screening = qsRequired<HTMLSelectElement>(section.root, '[name="classifierScreening"]')
    state.failure = 'Classifier profile is not configured'
    screening.value = 'fixture'
    screening.dispatchEvent(new Event('change'))
    await setImmediate()
    assert.equal(screening.value, '')
    assert.match(
      qsRequired(section.root, '.classifier-status').textContent,
      /Classifier profile is not configured/,
    )
  })

  it('drops a removed connection from the screening choices', async () => {
    const { section, state } = setup()
    await section.refresh()
    state.screening = 'fixture'
    await section.refresh()
    const screening = qsRequired<HTMLSelectElement>(section.root, '[name="classifierScreening"]')
    assert.equal(screening.value, 'fixture')
    button(section.root, 'remove').click()
    await setImmediate()
    assert.deepEqual(
      [...screening.options].map((option) => option.value),
      [''],
    )
    assert.equal(screening.value, '')
  })

  it('never calls inference on refresh, typing, or saving; tests only the saved profile', async () => {
    const { section, state } = setup()
    await section.refresh()
    assert.equal(button(section.root, 'test').disabled, false)
    enter(section.root, 'Model', 'updated-model')
    assert.equal(button(section.root, 'test').disabled, true)
    button(section.root, 'save').click()
    await setImmediate()
    assert.deepEqual(state.tests, [])
    assert.equal(state.saves[0]?.model, 'updated-model')
    assert.equal(button(section.root, 'test').disabled, false)
    button(section.root, 'test').click()
    await setImmediate()
    assert.deepEqual(state.tests, ['fixture'])
    assert.match(section.root.textContent, /Test succeeded · color: red · 24 ms/)
  })

  it('rounds fractional timeout seconds to integer milliseconds', async () => {
    const { section, state } = setup()
    await section.refresh()
    enter(section.root, 'Timeout', '1.005')
    assert.equal(field(section.root, 'Timeout').step, '0.001')
    button(section.root, 'save').click()
    await setImmediate()
    assert.equal(state.saves[0]?.timeoutMs, 1005)
    assert.equal(field(section.root, 'Timeout').value, '1.005')
  })

  for (const mode of ['declined', 'disabled', 'thrown'] as const) {
    it(`keeps a newly persisted profile removable after a ${mode} key save`, async () => {
      const { section, state } = setup([])
      state.plaintext = mode === 'declined'
      state.plaintextDisabled = mode === 'disabled'
      state.keyFailure =
        mode === 'thrown'
          ? 'Error invoking remote method \'settings:set-key\': IpcValidationError: [{"code":"too_big"}]'
          : null
      await section.refresh()
      button(section.root, 'create').click()
      enter(section.root, 'Label', 'Persisted connection')
      enter(section.root, 'Key', 'retry-key')
      button(section.root, 'save').click()
      await setImmediate()
      if (mode === 'declined') {
        clickActiveConfirmDialogCancel()
        await setImmediate()
      }
      const profileId = state.profiles[0]?.profile.id
      assert.ok(profileId)
      assert.equal(state.profiles.length, 1)
      assert.equal(section.root.querySelectorAll('[data-classifier-id]').length, 1)
      assert.equal(button(section.root, 'remove').textContent, 'Remove classifier')
      assert.match(
        qsRequired(section.root, '.classifier-status').textContent,
        /Connection saved; key (?:not saved|save failed)/,
      )
      if (mode === 'thrown') {
        assert.match(
          qsRequired(section.root, '.classifier-status').textContent,
          /Check the field values/,
        )
        assert.equal(section.root.textContent.includes('IpcValidationError'), false)
      }
      assert.equal(field(section.root, 'Key').value, 'retry-key')
      assert.equal(button(section.root, 'test').disabled, true)
      enter(section.root, 'Key', '')
      assert.equal(
        button(section.root, 'test').disabled,
        false,
        'profile edits were saved; only the key was pending',
      )
      button(section.root, 'remove').click()
      await setImmediate()
      assert.deepEqual(state.removals, [profileId])
      assert.equal(state.profiles.length, 0)
      assert.equal(section.root.querySelectorAll('[data-classifier-id]').length, 0)
      await section.refresh()
      assert.equal(section.root.querySelectorAll('[data-classifier-id]').length, 0)
    })
  }

  it('explains key removal when editing a saved destination, but ignores equivalent trailing slashes', async () => {
    const { section, state } = setup()
    const saved = state.profiles[0]
    assert.ok(saved)
    saved.hasKey = true
    saved.encrypted = true
    await section.refresh()
    assert.equal(field(section.root, 'Key').placeholder, 'Leave blank to keep the saved key')
    const note = qsRequired(section.root, '.classifier-destination-note')
    assert.equal(note.hidden, true)
    enter(section.root, 'Url', 'http://127.0.0.1:8009/v1/')
    assert.equal(note.hidden, true)
    enter(section.root, 'Url', 'https://another.example/v1')
    assert.equal(note.hidden, false)
    assert.match(note.textContent, /removes any saved key/)
    assert.match(note.textContent, /replacement key/)
    assert.equal(field(section.root, 'Key').placeholder, 'Enter a key for the new connection')
    enter(section.root, 'Url', 'http://127.0.0.1:8009/v1')
    assert.equal(note.hidden, true)
    field(section.root, 'Auth').value = 'none'
    field(section.root, 'Auth').dispatchEvent(new Event('change'))
    assert.equal(note.hidden, false)
    assert.equal(note.textContent.includes('replacement key'), false)
  })

  it('retains keys after declined plaintext consent and across profile switches', async () => {
    const { section, state } = setup([
      HTTP_PROFILE,
      { ...HTTP_PROFILE, id: 'second', label: 'Second' },
    ])
    state.plaintext = true
    await section.refresh()
    enter(section.root, 'Key', 'secret-draft')
    button(section.root, 'save').click()
    await setImmediate()
    clickActiveConfirmDialogCancel()
    await setImmediate()
    assert.equal(field(section.root, 'Key').value, 'secret-draft')
    assert.match(section.root.textContent, /key not saved/)
    qsRequired<HTMLButtonElement>(section.root, '[data-classifier-id="second"]').click()
    qsRequired<HTMLButtonElement>(section.root, '[data-classifier-id="fixture"]').click()
    assert.equal(field(section.root, 'Key').value, 'secret-draft')
    assert.equal(button(section.root, 'test').disabled, true)
    assert.equal(state.keys.length, 1)
    assert.equal(state.keys[0]?.allowPlaintext, false)
    assert.equal(state.profiles[0]?.hasKey, false)
  })

  it('saves a key through secure IPC only and clears it after explicit plaintext consent', async () => {
    const { section, state } = setup()
    state.plaintext = true
    await section.refresh()
    enter(section.root, 'Key', 'new-key')
    button(section.root, 'save').click()
    await setImmediate()
    clickActiveConfirmDialogConfirm()
    await setImmediate()
    assert.deepEqual(state.keys, [
      { id: 'classifier-fixture', key: 'new-key', allowPlaintext: false },
      { id: 'classifier-fixture', key: 'new-key', allowPlaintext: true },
    ])
    assert.equal(JSON.stringify(state.saves).includes('new-key'), false)
    assert.equal(field(section.root, 'Key').value, '')
    assert.match(section.root.textContent, /Key saved · stored unencrypted/)
    const removal = field(section.root, 'RemoveKey')
    removal.checked = true
    removal.dispatchEvent(new Event('change'))
    button(section.root, 'save').click()
    await setImmediate()
    // The mock models consent for every write, including deletion.
    clickActiveConfirmDialogConfirm()
    await setImmediate()
    assert.equal(state.keys.at(-1)?.key, '')
  })

  it('does not offer consent when plaintext storage is disabled', async () => {
    const { section, state } = setup()
    state.plaintextDisabled = true
    await section.refresh()
    enter(section.root, 'Key', 'keep-me')
    button(section.root, 'save').click()
    await setImmediate()
    assert.equal(document.querySelector('#confirm-dialog[open]'), null)
    assert.match(section.root.textContent, /plaintext storage is disabled/)
    assert.equal(field(section.root, 'Key').value, 'keep-me')
  })

  it('renders process fields for SemIf, clones templates with unique IDs and saves no HTTP fields', async () => {
    const { section, state } = setup([])
    await section.refresh()
    field(section.root, 'Preset').value = 'semif'
    button(section.root, 'create').click()
    assert.equal(section.root.querySelector('[name="classifierUrl"]'), null)
    assert.equal(section.root.querySelector('[name="classifierKey"]'), null)
    assert.equal(field(section.root, 'Executable').value, 'semif-score')
    assert.equal(button(section.root, 'test').disabled, true)
    button(section.root, 'save').click()
    await setImmediate()
    const first = state.saves[0]
    assert.ok(first)
    assert.equal(first.connection.type, 'semif')
    assert.match(first.id, /^semif-/)
    button(section.root, 'add').click()
    field(section.root, 'Preset').value = 'semif'
    button(section.root, 'create').click()
    button(section.root, 'save').click()
    await setImmediate()
    assert.notEqual(state.saves[1]?.id, first.id)
  })

  it('retains an unsaved profile and key when switching tabs, and can discard the draft', async () => {
    const { section, state } = setup()
    await section.refresh()
    button(section.root, 'add').click()
    button(section.root, 'create').click()
    enter(section.root, 'Key', 'draft-secret')
    const chip = qsRequired<HTMLButtonElement>(section.root, '.provider-chip.active')
    const draftId = chip.dataset['classifierId']
    assert.ok(draftId)
    qsRequired<HTMLButtonElement>(section.root, '[data-classifier-id="fixture"]').click()
    qsRequired<HTMLButtonElement>(section.root, `[data-classifier-id="${draftId}"]`).click()
    assert.equal(field(section.root, 'Key').value, 'draft-secret')
    assert.equal(button(section.root, 'test').disabled, true)
    button(section.root, 'remove').click()
    await setImmediate()
    assert.equal(section.root.querySelector(`[data-classifier-id="${draftId}"]`), null)
    assert.equal(state.profiles.length, 1)
  })

  it('shows readable test errors and retains form contents on save failure', async () => {
    const { section, state } = setup()
    await section.refresh()
    state.failure =
      "Error invoking remote method 'classifiers:test': ClassifierError: Error: Classifier endpoint refused the connection"
    button(section.root, 'test').click()
    await setImmediate()
    assert.equal(
      qsRequired(section.root, '.classifier-status').textContent,
      'Classifier endpoint refused the connection',
    )
    enter(section.root, 'Key', 'retry-secret')
    button(section.root, 'save').click()
    await setImmediate()
    assert.equal(field(section.root, 'Key').value, 'retry-secret')
    assert.equal(state.keys.length, 0)
    assert.equal(button(section.root, 'save').disabled, false)
  })

  it('hides irrelevant credentials for keyless endpoints and removes profiles', async () => {
    const { section, state } = setup()
    await section.refresh()
    field(section.root, 'Auth').value = 'none'
    field(section.root, 'Auth').dispatchEvent(new Event('change'))
    assert.equal(qsRequired(section.root, '.classifier-credentials').hidden, true)
    button(section.root, 'save').click()
    await setImmediate()
    assert.equal(state.saves[0]?.connection.type, 'http')
    button(section.root, 'remove').click()
    await setImmediate()
    assert.equal(state.profiles.length, 0)
    assert.equal(section.root.querySelector('.classifier-form'), null)
    assert.match(section.root.textContent, /Classifier and its saved key removed/)
  })
})
