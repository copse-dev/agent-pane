import { $, browser, expect } from '@wdio/globals'

/** Open Settings → Experimental, where the Mobile Companion lives, unless it is already showing. */
async function openMobileCompanionSettings(): Promise<void> {
  if (await $('.mobile-companion-name').isDisplayed()) return
  await $('[aria-label="Settings"]').click()
  await $('.settings-nav-btn[data-section="experimental"]').click()
  await $('.mobile-companion-name').waitForDisplayed({ timeout: 15_000 })
}

/**
 * Leave Settings open on a Mac that holds the trusted name `hostname` with a
 * valid certificate the Mobile Companion is serving, redeeming `invite` first
 * if it holds none. A test that needs the name calls this itself, so it passes
 * when run alone as well as after the test that registers it.
 */
export async function ensureTrustedName(invite: string, hostname: string): Promise<void> {
  await openMobileCompanionSettings()
  const card = $('.mobile-companion-name')
  await card.scrollIntoView({ block: 'center' })
  const inviteInput = card.$('input[name="mobileCompanionInvite"]')
  const named = async (): Promise<boolean> => /Certificate valid until/.test(await card.getText())
  await browser.waitUntil(async () => (await inviteInput.isDisplayed()) || (await named()), {
    timeout: 15_000,
    timeoutMsg: 'the trusted-name card never settled',
  })
  if (!(await named())) {
    await inviteInput.setValue(invite)
    await card.$('button=Get a name').click()
  }
  await browser.waitUntil(named, {
    timeout: 30_000,
    timeoutMsg: 'the certificate never arrived',
  })
  // The connection block leads with the name once the server presents its certificate.
  await expect($('.mobile-companion-connection')).toHaveText(
    expect.stringContaining(`https://${hostname}:42773`),
    { wait: 15_000 },
  )
}
