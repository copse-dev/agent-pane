import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { el } from '../dom/helpers.ts'
import { uiPaneTab, uiPaneTabsShell } from './pane-tabs.ts'

describe('uiPaneTabsShell', () => {
  it('assembles a header, title, tab list, and body with caller class names', () => {
    const shell = uiPaneTabsShell({
      title: 'Tabs',
      headerClassName: 'browser-tabs-list-header',
      listClassName: 'browser-tabs-list',
      bodyClassName: 'browser-body',
    })
    assert.equal(shell.titleEl.textContent, 'Tabs')
    assert.ok(shell.listHeader.classList.contains('pane-header'))
    assert.ok(shell.listHeader.classList.contains('browser-tabs-list-header'))
    assert.ok(shell.listHeader.contains(shell.titleEl))
    assert.ok(shell.tabsWrap.classList.contains('browser-tabs-list'))
    assert.ok(shell.body.classList.contains('browser-body'))
  })
})

describe('uiPaneTab', () => {
  function buildTab(id: string): { tabBtn: HTMLElement; panel: HTMLElement } {
    const closeBtn = el('span', { class: 'browser-tabs-tab-close' }, '×')
    const tabBtn = el(
      'button',
      { type: 'button', class: 'browser-tabs-tab', 'data-tab-id': id },
      el('span', {}, `Tab ${id}`),
      closeBtn,
    )
    const panel = el('div', { class: 'browser-tab-panel', 'data-tab-id': id })
    return { tabBtn, panel }
  }

  it('selects on a tab click but not on a close click', () => {
    const { tabBtn, panel } = buildTab('a')
    let selected = 0
    let closed = 0
    uiPaneTab({
      tabBtn,
      panel,
      closeSelector: '.browser-tabs-tab-close',
      onSelect: () => {
        selected += 1
      },
      onClose: () => {
        closed += 1
      },
    })

    tabBtn.click()
    assert.equal(selected, 1)
    assert.equal(closed, 0)

    const closeBtn = tabBtn.querySelector('.browser-tabs-tab-close')
    assert.ok(closeBtn instanceof HTMLElement)
    closeBtn.click()
    assert.equal(selected, 1)
    assert.equal(closed, 1)
  })

  it('mirrors is-active onto both the button and the panel', () => {
    const { tabBtn, panel } = buildTab('b')
    const tab = uiPaneTab({
      tabBtn,
      panel,
      closeSelector: '.browser-tabs-tab-close',
      onSelect: () => undefined,
      onClose: () => undefined,
    })

    tab.setActive(true)
    assert.ok(tabBtn.classList.contains('is-active'))
    assert.ok(panel.classList.contains('is-active'))

    tab.setActive(false)
    assert.ok(!tabBtn.classList.contains('is-active'))
    assert.ok(!panel.classList.contains('is-active'))
  })

  it('removes the button and panel from the DOM', () => {
    const { tabBtn, panel } = buildTab('c')
    const root = el('div', {}, tabBtn, panel)
    document.body.append(root)
    const tab = uiPaneTab({
      tabBtn,
      panel,
      closeSelector: '.browser-tabs-tab-close',
      onSelect: () => undefined,
      onClose: () => undefined,
    })

    tab.remove()
    assert.equal(root.contains(tabBtn), false)
    assert.equal(root.contains(panel), false)
    root.remove()
  })
})
