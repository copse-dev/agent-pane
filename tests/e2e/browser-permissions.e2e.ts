/** Requires Electron: observes production session callbacks and real guest APIs. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { $, $$, browser, expect } from '@wdio/globals'
import { navigateActiveBrowserTab } from './helpers/browser-address.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { listenOnFixturePort } from './helpers/fixture-server.ts'
import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { E2E_SCREENSHOT_DIR } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject, seedStableWorkspace } from './helpers/seed-config.ts'
import { waitForAgentIdle } from './helpers.ts'

const permissionEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.enum(['request', 'check']),
    permission: z.string(),
    allowed: z.boolean(),
    contentsType: z.string(),
    url: z.string(),
    mediaTypes: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('results'),
    contentsType: z.string(),
    results: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal('installed'), handler: z.string() }),
  z.object({ type: z.literal('host-copy'), text: z.string() }),
  z.object({ type: z.literal('error'), error: z.string() }),
])

const page = `<!doctype html><title>Browser permission boundary</title>
<style>body{font:16px system-ui;margin:24px;background:#f3f5ef;color:#23332d}main{max-width:560px;background:white;padding:24px;border:1px solid #c7d0c8}h1{font-size:22px}li{margin:8px 0}a{display:inline-block;padding:12px;background:#edf3ef}</style>
<main><h1>Browser permission boundary</h1><p id="status">Checking guest permissions…</p>
<a id="copy-target" href="/copied-link">Copy this link with Copse's context menu</a>
<ul id="results"></ul><button id="clipboard-sanitized-write-probe">Write clipboard</button><button id="fullscreen-probe">Enter fullscreen</button><label>Browser form <input id="entry"></label><button onclick="document.querySelector('#form-status').textContent=document.querySelector('#entry').value">Apply</button><p id="form-status"></p></main>
<script>
window.runPermissionProbes = async () => {
  const probes = {
    'display-capture': () => navigator.mediaDevices.getDisplayMedia({video:true}),
    media: () => navigator.mediaDevices.getUserMedia({audio:true,video:true}),
    geolocation: () => new Promise((resolve,reject) => navigator.geolocation.getCurrentPosition(resolve,reject)),
    notifications: () => Notification.requestPermission(),
    'clipboard-read': () => navigator.clipboard.readText(),
    'clipboard-read-query': () => navigator.permissions.query({name:'clipboard-read'}).then(permission=>permission.state),
    'clipboard-write-query': () => navigator.permissions.query({name:'clipboard-write'}).then(permission=>permission.state),
    'persistent-storage': () => navigator.storage.persist(),
  };
  const entries = await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
    let timeout;
    try {
      const value = await Promise.race([probe(), new Promise(resolve => {timeout=setTimeout(()=>resolve('timed out'),3000)})]);
      if (value && typeof value.getTracks === 'function') value.getTracks().forEach(track=>track.stop());
      return [name, String(value)];
    } catch(error) { return [name, error.name || String(error)]; }
    finally {clearTimeout(timeout);}
  }));
  const results = Object.fromEntries(entries);
  document.querySelector('#results').replaceChildren(...entries.map(([name,result]) => {
    const row=document.createElement('li'); row.textContent=name+': '+result; return row;
  }));
  document.querySelector('#status').textContent='Permission probes complete';
  return results;
};
window.runAffordanceProbe = async name => {
  const probes = {
    'clipboard-sanitized-write': async () => { await navigator.clipboard.writeText('guest write probe'); return 'allowed'; },
    fullscreen: async () => { await document.documentElement.requestFullscreen(); await document.exitFullscreen(); return 'allowed'; },
  };
  let timeout;
  try {
    return await Promise.race([probes[name](), new Promise(resolve => {timeout=setTimeout(()=>resolve('timed out'),3000)})]);
  } catch(error) { return error.name || String(error); }
  finally { clearTimeout(timeout); }
};
window.affordanceResults = {};
for (const name of ['clipboard-sanitized-write', 'fullscreen']) {
  document.querySelector('#' + name + '-probe').addEventListener('click', async () => {
    window.affordanceResults[name] = await window.runAffordanceProbe(name);
  });
}
</script>`

describe('browser guest permission policy', function () {
  this.timeout(120_000)
  let fixtureDir = ''
  let server: Server | undefined
  let origin = ''

  async function runTool(
    name: string,
    args: Record<string, unknown>,
    reply: string,
  ): Promise<void> {
    const scenario = await prepareMockToolTurn(reply, { name, args }, reply)
    await $('.submit-btn').click()
    await expectAssistantReply(reply)
    await waitForAgentIdle()
    await scenario.assertComplete()
  }

  async function snapshotText(): Promise<string> {
    const rollups = await $$('.tool-card-rollup').getElements()
    const latest = rollups.at(-1)
    assert.ok(latest)
    await latest.$(':scope > summary').click()
    await latest.$('[data-tool-id] > summary').click()
    return latest.$('.tool-result').getText()
  }

  function events(): z.infer<typeof permissionEvent>[] {
    const file = join(fixtureDir, 'events.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const event = safeJsonParse(line, decodeWithSchema(permissionEvent))
        assert.ok(event, `invalid permission observation: ${line}`)
        return event
      })
  }

  async function expectPermissionPolicy(
    contentsType: string,
    allowedPermissions: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    await browser.waitUntil(
      () =>
        events().some((event) => event.type === 'results' && event.contentsType === contentsType),
      {
        timeout: 15_000,
        timeoutMsg: `missing completed probes in ${contentsType}`,
      },
    )
    const observations = events()
    assert.deepEqual(
      observations.filter((event) => event.type === 'error'),
      [],
    )
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen',
      'persistent-storage',
    ]) {
      const decisions = observations.filter(
        (event) =>
          (event.type === 'request' || event.type === 'check') &&
          event.contentsType === contentsType &&
          event.permission === permission,
      )
      assert.ok(
        decisions.length > 0,
        `${contentsType}: ${permission} must reach a production callback: ${JSON.stringify(observations)}`,
      )
      for (const decision of decisions) {
        assert.ok(decision.type === 'request' || decision.type === 'check')
        assert.equal(
          decision.allowed,
          allowedPermissions.has(permission),
          `${contentsType}: ${permission}`,
        )
      }
    }
    const result = observations.find(
      (event) => event.type === 'results' && event.contentsType === contentsType,
    )
    assert.ok(result?.type === 'results')
    // Electron 44 can report screen capture as media with no camera/mic types.
    // Newer runtimes name display-capture explicitly. Require actual delivery.
    assert.ok(
      observations.some(
        (event) =>
          event.type === 'request' &&
          event.contentsType === contentsType &&
          !event.allowed &&
          (event.permission === 'display-capture' ||
            (event.permission === 'media' && event.mediaTypes?.length === 0)),
      ),
      'display capture must reach a production request handler',
    )
    assert.equal(result.results['notifications'], 'denied')
    assert.equal(result.results['clipboard-read-query'], 'denied')
    assert.equal(
      result.results['clipboard-write-query'],
      allowedPermissions.has('clipboard-sanitized-write') ? 'granted' : 'denied',
    )
    for (const permission of ['display-capture', 'clipboard-read']) {
      assert.equal(result.results[permission], 'NotAllowedError', `${contentsType}: ${permission}`)
    }
    for (const permission of ['clipboard-sanitized-write', 'fullscreen']) {
      if (allowedPermissions.has(permission)) {
        assert.equal(
          result.results[permission],
          permission === 'clipboard-sanitized-write' ? 'requested' : 'allowed',
          `${contentsType}: ${permission}`,
        )
      } else {
        assert.ok(
          ['NotAllowedError', 'timed out'].includes(result.results[permission] ?? ''),
          `${contentsType}: ${permission}`,
        )
      }
    }
    // On a host with no camera/mic, Chromium may find no device before it
    // reports the denied result. The production callback above must still
    // receive and reject the media request.
    assert.ok(
      ['NotAllowedError', 'NotFoundError'].includes(result.results['media'] ?? ''),
      `${contentsType}: media`,
    )
    assert.equal(result.results['geolocation'], '[object GeolocationPositionError]')
    assert.equal(result.results['persistent-storage'], 'false')
  }

  before(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'copse-browser-permissions-'))
    writeE2eEnv({ COPSE_E2E_BROWSER_PERMISSIONS: fixtureDir })
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
    })
    origin = await listenOnFixturePort(server, 43137)
    resetUserData()
    seedEmptyProject(seedStableWorkspace(), 'browser-permissions', { webAllowedOrigins: [origin] })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })

  after(async () => {
    writeE2eEnv({ COPSE_E2E_BROWSER_PERMISSIONS: undefined })
    resetUserData()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server?.close((error) => {
          if (error) reject(error)
          else resolve()
        }),
      )
    }
    if (fixtureDir && existsSync(join(fixtureDir, 'events.jsonl'))) {
      const evidence = join(process.cwd(), 'e2e-failure-artifacts', 'browser-permissions')
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, 'events.jsonl'), readFileSync(join(fixtureDir, 'events.jsonl')))
    }
    if (fixtureDir) removeE2eTree(fixtureDir)
  })

  it('denies page capabilities in the interactive browser while host copy and capture work', async () => {
    await $('.titlebar-btn[aria-label="Open browser"]').click()
    await navigateActiveBrowserTab(`${origin}/permissions`)
    await expectPermissionPolicy('webview', new Set(['clipboard-sanitized-write', 'fullscreen']))
    writeFileSync(join(fixtureDir, 'copy-link'), '')
    await browser.waitUntil(
      () =>
        events().some(
          (event) => event.type === 'host-copy' && event.text === `${origin}/copied-link`,
        ),
      {
        timeout: 10_000,
        timeoutMsg: 'host-owned context-menu copy must retain clipboard access',
      },
    )
    await $('.browser-menu-btn').click()
    const items = await $$('.browser-menu-item').getElements()
    const screenshot = await items.map(async (item) => ({ item, text: await item.getText() }))
    const action = screenshot.find((entry) => entry.text === 'Share screenshot')
    assert.ok(action)
    await action.item.click()
    await expect($('.attachment-chips .image-chip img')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/png;base64,'),
    )
    const guestCapture = await browser.execute(async () => {
      const guest = document.querySelector<Electron.WebviewTag>(
        '.browser-tab-panel.is-active webview',
      )
      if (!guest) throw new Error('permission probe guest missing')
      guest.style.width = '720px'
      guest.style.height = '600px'
      await guest.executeJavaScript(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      )
      return (await guest.capturePage()).toDataURL()
    })
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeFileSync(
      join(E2E_SCREENSHOT_DIR, 'browser-permissions-denied.png'),
      Buffer.from(guestCapture.split(',')[1] ?? '', 'base64'),
    )
  })

  it('denies capabilities in the isolated agent browser and retains navigation and snapshot', async () => {
    await runTool(
      'browser_navigate',
      { url: `${origin}/permissions` },
      'Browser navigation completed.',
    )
    await expectPermissionPolicy('offscreen')
    await runTool('browser_snapshot', {}, 'Browser snapshot completed.')
    const result = await snapshotText()
    expect(result).toContain('Browser permission boundary')
    const input = /textbox "Browser form".*\[ref=(e\d+)\]/.exec(result)?.[1]
    const button = /button "Apply".*\[ref=(e\d+)\]/.exec(result)?.[1]
    assert.ok(input, result)
    assert.ok(button, result)
    await runTool(
      'browser_type',
      { ref: input, text: 'Form still works' },
      'Browser typing completed.',
    )
    await runTool('browser_click', { ref: button }, 'Browser click completed.')
    await runTool('browser_snapshot', {}, 'Updated page snapshot completed.')
    expect(await snapshotText()).toContain('- text "Form still works"')
    await runTool('browser_screenshot', {}, 'Agent screenshot completed.')
    await expect($('.tool-result-images .tool-result-preview-image')).toBeExisting()
  })
})
