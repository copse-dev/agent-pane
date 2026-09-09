import { $, browser, expect } from '@wdio/globals'
import { resetUserData, seedE2eViewport, seedEmptyProject } from './helpers/seed-config.ts'
import { saveElementScreenshot } from './helpers/screenshot.ts'

const PERMISSIONS = '.settings-section[data-section="permissions"]'
const TOGGLE = 'input[name="gitCommitSshAgentSocketAccess"]'
const FIELDSET = `${PERMISSIONS} fieldset:has(${TOGGLE})`

describe('native git commit signing permission', function () {
  this.timeout(90_000)

  beforeEach(async () => {
    process.env.COPSE_PANEL_MOCK_LLM = '1'
    process.env.ANTHROPIC_API_KEY = ''
    process.env.OPENAI_API_KEY = ''
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-git-commit-signing-permission')
    seedE2eViewport({ width: 1200, height: 800 }, { theme: 'dark' })
    await browser.reloadSession()
  })

  afterEach(() => {
    resetUserData()
  })

  it('shows the commit-scoped grant off by default with its security boundary', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="permissions"]').click()
    await $(TOGGLE).waitForDisplayed({ timeout: 30_000 })

    expect(await $(TOGGLE).isSelected()).toBe(false)
    const copy = await $(FIELDSET).getText()
    expect(copy).toContain("Copse's native git_commit subprocess")
    expect(copy).toContain('Git hooks')
    expect(copy).toContain('any key it holds')
    expect(copy).toContain('ssh-add -c')

    await saveElementScreenshot(FIELDSET, 'git-commit-signing-permission.png')
  })

  it('takes the grant only after an explicit click', async () => {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('.settings-nav-btn[data-section="permissions"]').click()
    await $(TOGGLE).waitForDisplayed({ timeout: 30_000 })

    await $(TOGGLE).click()
    expect(await $(TOGGLE).isSelected()).toBe(true)
  })
})
