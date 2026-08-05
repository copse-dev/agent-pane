import '../../../tests/setup-dom.ts'
import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mountModelPicker, mountModelSelectPicker } from './model-picker.ts'
import type { ModelOption } from './model-options.ts'

const OPTIONS: ModelOption[] = [
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Cloud models' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8', group: 'Cloud models' },
  { value: 'lmstudio:qwen', label: 'Qwen', group: 'Local models' },
]

describe('shared model picker', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('filters grouped options and selects from the searchable list', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let current = 'claude-sonnet-4-6'
    const picker = mountModelPicker(
      host,
      () => current,
      (value) => {
        current = value
      },
      async () => OPTIONS,
      { loadOnMount: false },
    )
    await picker.refresh()

    host.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    const filter = host.querySelector<HTMLInputElement>('.model-picker-filter')
    assert.ok(filter)
    filter.value = 'opus'
    filter.dispatchEvent(new Event('input', { bubbles: true }))

    const matches = [...host.querySelectorAll<HTMLButtonElement>('.model-picker-option')]
    assert.deepEqual(
      matches.map((option) => option.textContent),
      ['Claude Opus 4.8'],
    )
    matches[0]?.click()

    assert.equal(current, 'claude-opus-4-8')
    assert.equal(host.querySelector('.model-picker-label')?.textContent, 'Claude Opus 4.8')
    assert.equal(host.querySelector('.model-picker-menu')?.hasAttribute('hidden'), true)
  })

  it('dismisses its own menu on Escape without bubbling to a parent dialog', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let escaped = false
    const onDocumentKeydown = (): void => {
      escaped = true
    }
    document.addEventListener('keydown', onDocumentKeydown)
    const picker = mountModelPicker(
      host,
      () => OPTIONS[0]?.value ?? '',
      () => {},
      async () => OPTIONS,
      {
        loadOnMount: false,
      },
    )
    await picker.refresh()

    host.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    const filter = host.querySelector<HTMLInputElement>('.model-picker-filter')
    assert.ok(filter)
    filter.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    assert.equal(escaped, false)
    assert.equal(host.querySelector('.model-picker-menu')?.hasAttribute('hidden'), true)
    document.removeEventListener('keydown', onDocumentKeydown)
    picker.destroy()
  })

  it('navigates recent -> all on ArrowRight and all -> recent on ArrowLeft', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let current = 'claude-sonnet-4-6'
    const picker = mountModelPicker(
      host,
      () => current,
      (value) => {
        current = value
      },
      async () => OPTIONS,
      {
        loadOnMount: false,
        getRecentValues: () => ['claude-sonnet-4-6', 'claude-opus-4-8'],
      },
    )
    await picker.refresh()

    host.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    const menu = host.querySelector<HTMLDivElement>('.model-picker-menu')
    assert.ok(menu)
    const filter = host.querySelector<HTMLInputElement>('.model-picker-filter')
    assert.ok(filter)

    // In recent view: ArrowRight opens the all-models view with the filter focused.
    menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    assert.equal(filter.hasAttribute('hidden'), false)
    assert.equal(document.activeElement, filter)

    // In all view: ArrowLeft returns to the recent view.
    menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    assert.equal(filter.hasAttribute('hidden'), true)

    picker.destroy()
  })

  it('keeps a hidden select as form state and supports an automatic blank route', async () => {
    const form = document.createElement('form')
    const label = document.createElement('label')
    label.htmlFor = 'review-model'
    label.textContent = 'Review model'
    const select = document.createElement('select')
    select.id = 'review-model'
    select.name = 'reviewModel'
    form.append(label, select)
    document.body.append(form)

    let changes = 0
    select.addEventListener('change', () => {
      changes++
    })
    const picker = mountModelSelectPicker(select, {
      loadOptions: async () => [{ value: '', label: '(auto — prefer on-device)' }, ...OPTIONS],
      loadOnMount: false,
    })
    await picker.refresh('claude-sonnet-4-6')

    assert.equal(select.hidden, true)
    assert.equal(label.htmlFor, form.querySelector('.model-picker-trigger')?.id)
    assert.equal(new window.FormData(form).get('reviewModel'), 'claude-sonnet-4-6')
    form.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    form.querySelector<HTMLButtonElement>('.model-picker-option[data-value=""]')?.click()

    assert.equal(select.value, '')
    assert.equal(new window.FormData(form).get('reviewModel'), '')
    assert.equal(changes, 1)
    assert.equal(
      form.querySelector('.model-picker-label')?.textContent,
      '(auto — prefer on-device)',
    )
  })

  it('rewires wrapping labels to the searchable trigger', async () => {
    const form = document.createElement('form')
    const select = document.createElement('select')
    select.name = 'model'
    const initial = document.createElement('option')
    initial.value = 'claude-sonnet-4-6'
    initial.textContent = 'Claude Sonnet 4.6'
    select.append(initial)
    select.value = 'claude-sonnet-4-6'
    const label = document.createElement('label')
    label.append('Chat model', select)
    form.append(label)
    document.body.append(form)

    const picker = mountModelSelectPicker(select, {
      loadOptions: async () => OPTIONS,
      loadOnMount: false,
    })
    await picker.refresh()

    const trigger = form.querySelector<HTMLButtonElement>('.model-picker-trigger')
    assert.ok(trigger?.id)
    assert.equal(label.htmlFor, trigger.id)
    // happy-dom's label.click() does not always activate htmlFor; assert the
    // association the browser (and Chromium e2e) will honor.
    assert.equal(document.getElementById(label.htmlFor), trigger)
    picker.destroy()
  })

  it('ignores stale refresh results when syncing the native select', async () => {
    const select = document.createElement('select')
    select.name = 'model'
    document.body.append(select)

    let releaseStale: ((options: ModelOption[]) => void) | undefined
    let releaseFresh: ((options: ModelOption[]) => void) | undefined
    let loadCount = 0
    const picker = mountModelSelectPicker(select, {
      loadOptions: async () => {
        loadCount += 1
        if (loadCount === 1) {
          return await new Promise<ModelOption[]>((resolve) => {
            releaseStale = resolve
          })
        }
        return await new Promise<ModelOption[]>((resolve) => {
          releaseFresh = resolve
        })
      },
      loadOnMount: false,
    })

    const staleRefresh = picker.refresh('claude-sonnet-4-6')
    const freshRefresh = picker.refresh('claude-opus-4-8')
    assert.ok(releaseStale)
    assert.ok(releaseFresh)
    releaseFresh(OPTIONS.filter((opt) => opt.value === 'claude-opus-4-8'))
    await freshRefresh
    releaseStale(OPTIONS.filter((opt) => opt.value === 'claude-sonnet-4-6'))
    await staleRefresh

    assert.equal(select.value, 'claude-opus-4-8')
    assert.deepEqual(
      [...select.options].map((option) => option.value),
      ['claude-opus-4-8'],
    )
    picker.destroy()
  })

  it('focuses the active recent option when the catalog lands after the menu opened', async () => {
    // Opening before `loadOptions` resolves leaves only the "Loading models…"
    // status to focus, and the later render rebuilds every option anyway — so
    // without re-applying focus the arrow keys have nowhere to start.
    const host = document.createElement('div')
    document.body.append(host)
    let release: ((options: ModelOption[]) => void) | undefined
    const picker = mountModelPicker(
      host,
      () => 'claude-sonnet-4-6',
      () => {},
      async () =>
        await new Promise<ModelOption[]>((resolve) => {
          release = resolve
        }),
      { loadOnMount: false, getRecentValues: () => ['claude-sonnet-4-6'] },
    )
    const pending = picker.refresh()
    host.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    assert.equal(host.querySelector('.model-picker-option'), null, 'no options yet')

    assert.ok(release)
    release(OPTIONS)
    await pending

    const active = host.querySelector<HTMLElement>('.model-picker-option.is-active')
    assert.ok(active, 'an active option renders once the catalog lands')
    assert.equal(document.activeElement, active)
    picker.destroy()
  })

  it('leaves focus alone when the catalog lands while the user is already in the menu', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    let release: ((options: ModelOption[]) => void) | undefined
    const picker = mountModelPicker(
      host,
      () => 'claude-sonnet-4-6',
      () => {},
      async () =>
        await new Promise<ModelOption[]>((resolve) => {
          release = resolve
        }),
      { loadOnMount: false, getRecentValues: () => ['claude-sonnet-4-6'] },
    )
    const pending = picker.refresh()
    host.querySelector<HTMLButtonElement>('.model-picker-trigger')?.click()
    const browse = host.querySelector<HTMLButtonElement>('.model-picker-browse')
    assert.ok(browse)
    browse.focus()

    assert.ok(release)
    release(OPTIONS)
    await pending

    assert.equal(document.activeElement, browse)
    picker.destroy()
  })

  it('drops document listeners when the host is cleared without destroy()', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const picker = mountModelPicker(
      host,
      () => OPTIONS[0]?.value ?? '',
      () => {},
      async () => OPTIONS,
      { enableShortcut: true, loadOnMount: false },
    )
    await picker.refresh()

    const shortcutEvent = (): KeyboardEvent =>
      new window.KeyboardEvent('keydown', {
        key: 'm',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })

    const whileMounted = shortcutEvent()
    document.dispatchEvent(whileMounted)
    assert.equal(whileMounted.defaultPrevented, true)
    assert.equal(host.querySelector('.model-picker-menu')?.hasAttribute('hidden'), false)

    host.innerHTML = ''
    // MutationObserver cleanup is queued as a microtask in happy-dom.
    await Promise.resolve()
    await Promise.resolve()

    const afterClear = shortcutEvent()
    document.dispatchEvent(afterClear)
    assert.equal(afterClear.defaultPrevented, false)
    picker.destroy()
  })

  it('gives every picker its own anchor name', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const mount = (): void => {
      mountModelPicker(
        host,
        () => 'claude-sonnet-4-6',
        () => {},
        async () => OPTIONS,
        { variant: 'field', loadOnMount: false },
      )
    }
    mount()
    mount()
    await Promise.resolve()

    const names = [...host.querySelectorAll<HTMLElement>('.model-picker')].map((wrap) =>
      wrap.style.getPropertyValue('--model-picker-anchor'),
    )
    assert.equal(names.length, 2)
    // Chromium resolves a duplicated anchor-name to another element carrying
    // it, which would anchor one menu to the other picker's trigger.
    assert.equal(new Set(names).size, 2)
    for (const name of names) assert.match(name, /^--model-picker-\d+$/)
  })
})
