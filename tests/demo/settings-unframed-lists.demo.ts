import assert from 'node:assert/strict'
import { $, browser } from '@wdio/globals'
import { saveElementScreenshot } from '../e2e/helpers/screenshot.ts'

// Settings lists sit on the page: tool groups, MCP server rows and the agents
// list have no card frame, fill or rules between rows, and the space between
// items does the separating (docs/ui-taste.md, "Containment is a plate").

async function openSection(section: string): Promise<void> {
  await browser.url('/?scenario=settings-footer')
  await $('.prompt-input').waitForExist()
  await $('[aria-label="Settings"]').click()
  await $('#settings-dialog').$(`button[data-section="${section}"]`).click()
}

describe('Settings lists without frames', () => {
  it('shows tool permission groups as rows, with their facts as text', async () => {
    await openSection('permissions')
    await $('.tool-permission-group').waitForDisplayed()
    const styles = await browser.execute(() => {
      const group = document.querySelector('.tool-permission-group')
      const list = document.querySelector('.tool-permission-list')
      const secondRow = document.querySelectorAll('.tool-permission-row')[1]
      const status = document.querySelector('.tool-permission-group-status')
      const count = document.querySelector('.tool-permission-count')
      if (!group || !list || !secondRow || !status || !count) return null
      const probe = document.createElement('span')
      probe.style.color = 'var(--success)'
      document.body.append(probe)
      const success = getComputedStyle(probe).color
      probe.remove()
      return {
        groupBorder: getComputedStyle(group).borderTopWidth,
        groupFill: getComputedStyle(group).backgroundColor,
        listRule: getComputedStyle(list).borderTopWidth,
        rowRule: getComputedStyle(secondRow).borderTopWidth,
        countBorder: getComputedStyle(count).borderTopWidth,
        statusBorder: getComputedStyle(status).borderTopWidth,
        statusIsSuccess: getComputedStyle(status).color === success,
      }
    })
    assert.deepEqual(styles, {
      groupBorder: '0px',
      groupFill: 'rgba(0, 0, 0, 0)',
      listRule: '0px',
      rowRule: '0px',
      countBorder: '0px',
      statusBorder: '0px',
      statusIsSuccess: true,
    })
    const overflow = await browser.execute(() => {
      const panel = document.querySelector('.tool-permissions-panel')
      return panel ? panel.scrollWidth - panel.clientWidth : -1
    })
    assert.equal(overflow, 0, 'the gutter the groups carry stays inside the panel')
    await saveElementScreenshot(
      '[data-group-id="mcp:project:proton-mcp"]',
      'settings-tool-groups-unframed.png',
    )
  })

  it('lists MCP servers as rows under a shorter intro', async () => {
    await openSection('mcp')
    await $('#mcp-server-list .mcp-server-row').waitForDisplayed()
    const intro = await $('[data-section="mcp"] > .settings-section-desc').getText()
    assert.match(intro, /^Servers that give the agent external tools/)
    assert.match(intro, /~\/\.cursor\/mcp\.json/)
    assert.doesNotMatch(intro, /whole picture/)
    const row = await browser.execute(() => {
      const el = document.querySelector('#mcp-server-list .mcp-server-row')
      return el ? { border: getComputedStyle(el).borderTopWidth } : null
    })
    assert.deepEqual(row, { border: '0px' })
    await saveElementScreenshot(
      '.settings-section[data-section="mcp"] > .settings-section-desc',
      'settings-mcp-intro.png',
    )
    await saveElementScreenshot('#mcp-server-list', 'settings-mcp-server-rows.png')
  })

  it('sets the agents list and the Models subsections on the page', async () => {
    await openSection('general')
    await $('[data-testid="models-agents-list"] .acp-row').waitForExist()
    const styles = await browser.execute(() => {
      const list = document.querySelector('.acp-list')
      const row = document.querySelector('.acp-row')
      const hosts = [
        '#settings-model-routing-host',
        '#settings-model-maker-block-host',
        '#settings-model-parameters-host',
      ].map((id) => document.querySelector(id))
      const fields = document.querySelectorAll(
        '.ui-field + .ui-field, copse-ui-field + copse-ui-field',
      )
      if (!list || !row) return null
      return {
        listBorder: getComputedStyle(list).borderTopWidth,
        listFill: getComputedStyle(list).backgroundColor,
        rowRule: getComputedStyle(row).borderBottomWidth,
        hostRules: hosts.map((host) => (host ? getComputedStyle(host).borderTopWidth : 'missing')),
        fieldRules: [...fields].map((field) => getComputedStyle(field).borderTopWidth),
      }
    })
    assert.ok(styles, 'the agents list rendered')
    assert.equal(styles.listBorder, '0px')
    assert.equal(styles.listFill, 'rgba(0, 0, 0, 0)')
    assert.equal(styles.rowRule, '0px')
    assert.deepEqual(styles.hostRules, ['0px', '0px', '0px'])
    assert.ok(
      styles.fieldRules.every((width) => width === '0px'),
      'no rule above stacked kit fields',
    )
    await saveElementScreenshot(
      '[data-testid="models-agents-fieldset"]',
      'settings-agents-list-unframed.png',
    )
    await saveElementScreenshot('#settings-model-maker-block-host', 'settings-model-subsection.png')
  })

  it("paints a focused agent action's ring in full at the list's edge", async () => {
    await openSection('general')
    await $('[data-testid="models-agents-list"] .acp-row').waitForExist()
    // Reach the first row's last action the way a keyboard user does: focus
    // what comes before it and press Tab, so the action matches :focus-visible.
    const target = await browser.execute(() => {
      const head = document.querySelector('.acp-list .acp-row-head')
      const actions = head ? [...head.querySelectorAll<HTMLButtonElement>(':scope > button')] : []
      const last = actions.at(-1)
      const before =
        actions.at(-2) ??
        document.querySelector<HTMLButtonElement>('[data-testid="connections-rescan"]')
      if (!last || !before) return null
      last.scrollIntoView({ block: 'center' })
      before.focus()
      return last.textContent
    })
    assert.ok(target, 'the first agents row has an action')
    await browser.keys('Tab')
    const ring = await browser.execute(() => {
      const action = document.activeElement
      const list = document.querySelector('.acp-list')
      if (!(action instanceof HTMLElement) || !list?.contains(action)) return null
      const style = getComputedStyle(action)
      // Chromium paints an `auto` ring a few px outside the border box,
      // whatever width it declares.
      const width = Number.parseFloat(style.outlineWidth)
      const reach =
        Number.parseFloat(style.outlineOffset) +
        (style.outlineStyle === 'auto' ? Math.max(width, 3) : width)
      const box = action.getBoundingClientRect()
      const clippedBy: string[] = []
      for (let node = action.parentElement; node; node = node.parentElement) {
        const own = getComputedStyle(node)
        if (own.overflowX === 'visible' && own.overflowY === 'visible') continue
        const frame = node.getBoundingClientRect()
        const left = frame.left + node.clientLeft
        const top = frame.top + node.clientTop
        if (
          box.left - reach < left ||
          box.top - reach < top ||
          box.right + reach > left + node.clientWidth ||
          box.bottom + reach > top + node.clientHeight
        ) {
          clippedBy.push(node.id ? `#${node.id}` : `.${node.classList.item(0) ?? node.tagName}`)
        }
      }
      return {
        label: action.textContent,
        focusVisible: action.matches(':focus-visible'),
        outline: style.outlineStyle,
        flush: Math.abs(list.getBoundingClientRect().right - box.right) <= 1,
        clippedBy,
      }
    })
    assert.ok(ring, 'Tab moved focus to an action in the agents list')
    assert.equal(ring.label, target)
    assert.equal(ring.focusVisible, true)
    assert.notEqual(ring.outline, 'none', 'the focused action draws a ring')
    assert.equal(ring.flush, true, 'the action ends at the list edge, where a clip would cut it')
    assert.deepEqual(ring.clippedBy, [], 'nothing around the list clips the focus ring')
    // The section's own box ends at the list's edge too, so capture the panel
    // around it to show the whole ring.
    await saveElementScreenshot('.settings-content', 'settings-agents-action-focus.png')
  })

  it('shows an example as the custom instructions placeholder', async () => {
    await openSection('agent')
    const field = $('textarea[name="customInstructions"]')
    await field.waitForExist()
    assert.equal(
      await field.getAttribute('placeholder'),
      'e.g. Prefer small commits. Use British spelling.',
    )
  })
})
