import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

// #2320: letting a sandboxed agent reach ssh-agent is a real capability grant —
// it can ask the agent to *use* any key it holds, for anything. A writable
// config key is not consent, so the grant has a discoverable, explicit opt-in in
// Settings › Permissions that states what it hands over. This pins that the
// control is reachable, off by default, and shown with its warning copy.
const PERMISSIONS = '.settings-section[data-section="permissions"]'
const TOGGLE = 'input[name="agentSshAgentSocketAccess"]'
// The screenshot helper re-centres its capture on the element it is given, so a
// shot of the whole (scrollable, much taller) Permissions pane lands on the
// fieldsets above this one. Frame the grant's own fieldset instead.
const FIELDSET = `${PERMISSIONS} fieldset:has(${TOGGLE})`

describe('ssh-agent commit-signing consent', function () {
  this.timeout(90_000)

  before(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-ssh-agent-consent')
    seedE2eViewport({ width: 1200, height: 800 }, { theme: 'dark' })
    await browser.reloadSession()
  })

  after(() => {
    resetUserData()
  })

  it('offers the grant in Permissions, off by default, with what it grants stated', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="permissions"]').click()
    await $(TOGGLE).waitForDisplayed({ timeout: 30_000 })

    // Default off: the capability is never granted by merely opening Settings.
    expect(await $(TOGGLE).isSelected()).toBe(false)

    // The copy has to say what is handed over, not just that something is — a
    // bare label ("use your ssh-agent") reads like a convenience toggle.
    const copy = await $(PERMISSIONS).getText()
    expect(copy).toContain('any key it holds')
    expect(copy).toContain('ssh-add -c')

    await saveElementScreenshot(FIELDSET, 'ssh-agent-consent-permissions.png')
  })

  it('takes the grant only from an explicit click', async () => {
    await $(TOGGLE).click()
    expect(await $(TOGGLE).isSelected()).toBe(true)
  })
})
