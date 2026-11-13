import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { z } from 'zod'
import { prepareE2eScreenshot, saveAppScreenshot } from './helpers/screenshot.ts'
import { expectAssistantReply, prepareMockToolTurn } from './helpers/mock-scenario.ts'
import { waitForAgentIdle } from './helpers.ts'

const SCREENSHOT_DIR = join(process.cwd(), 'tests/e2e/screenshots')
const requests: string[] = []
const controlPaths = new Set(['/control', '/control.svg'])
let probeUrl = ''
const server = createServer((request, response) => {
  requests.push(request.url ?? '')
  if (request.url === '/control.svg') {
    response.setHeader('Content-Type', 'image/svg+xml')
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>')
    return
  }
  if (request.url === '/control') {
    response.setHeader('Content-Type', 'text/html')
    response.end(
      '<title>Probe control</title><link rel="icon" href="data:,"><img id="control" src="/control.svg">',
    )
    return
  }
  response.end('unexpected request')
})

describe('isolated mermaid diagram rendering', () => {
  before(async () => {
    process.env['COPSE_PANEL_MOCK_LLM'] = '1'
    process.env['ANTHROPIC_API_KEY'] = ''
    process.env['OPENAI_API_KEY'] = ''
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No probe server port')
    probeUrl = `http://127.0.0.1:${String(address.port)}`
    const { resetUserData, seedMermaidDiagramFixture } = await import('./helpers/seed-config.ts')
    resetUserData()
    seedMermaidDiagramFixture(process.cwd())
    await browser.reloadSession()
  })

  after(async () => {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )
    const { resetUserData } = await import('./helpers/seed-config.ts')
    resetUserData()
  })

  it('renders and expands in opaque frames without inserting SVG into the app', async () => {
    const selector = '.message-text iframe.mermaid-frame[data-rendered="true"]'
    await $(selector).waitForExist({ timeout: 40_000 })
    const frame = await $(selector).getElement()
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts')
    const hostState = await browser.execute(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe.mermaid-frame')
      return {
        svgCount: document.querySelectorAll('.mermaid-diagram svg').length,
        inaccessibleDocument: frame?.contentDocument === null,
        width: frame?.getBoundingClientRect().width ?? 0,
        height: frame?.getBoundingClientRect().height ?? 0,
        background: getComputedStyle(
          document.querySelector('.mermaid-diagram') ??
            ((): never => {
              throw new Error("Missing fixture element: document.querySelector('.mermaid-diagram')")
            })(),
        ).backgroundColor,
        sourceBackground: getComputedStyle(
          document.querySelector('pre.mermaid') ??
            ((): never => {
              throw new Error("Missing fixture element: document.querySelector('pre.mermaid')")
            })(),
        ).backgroundColor,
      }
    })
    expect(hostState.svgCount).toBe(0)
    expect(hostState.inaccessibleDocument).toBe(true)
    expect(hostState.width).toBeGreaterThan(50)
    expect(hostState.height).toBeGreaterThan(50)
    expect(hostState.background).toBe('rgb(17, 17, 17)')
    expect(hostState.sourceBackground).toBe(hostState.background)

    await browser.switchFrame(frame)
    const isolation = await browser.execute(() => {
      let parentBlocked = false
      let parentApiBlocked = false
      try {
        window.parent.document.querySelector('body')
      } catch {
        parentBlocked = true
      }
      try {
        Reflect.get(window.parent, 'api')
      } catch {
        parentApiBlocked = true
      }
      return {
        parentBlocked,
        parentApiBlocked,
        ownApi: 'api' in window,
        svg: Boolean(document.querySelector('svg.pele')),
        text: document.body.textContent,
        background: getComputedStyle(
          document.querySelector('.mermaid-diagram') ??
            ((): never => {
              throw new Error("Missing fixture element: document.querySelector('.mermaid-diagram')")
            })(),
        ).backgroundColor,
        pliant: Array.from(document.fonts).filter(
          (font) => font.family === 'Pliant' && font.status === 'loaded',
        ).length,
      }
    })
    expect(isolation.parentBlocked).toBe(true)
    expect(isolation.parentApiBlocked).toBe(true)
    expect(isolation.ownApi).toBe(false)
    expect(isolation.svg).toBe(true)
    expect(isolation.background).toBe(hostState.background)
    expect(isolation.text).toContain('Agent')
    expect(isolation.pliant).toBe(2)
    await browser.switchToParentFrame()

    await saveAppScreenshot('mermaid-isolated-inline.png')
    await $('.mermaid-diagram--folded').click()
    await $('dialog.mermaid-expand-dialog[open]').waitForExist()
    await $('dialog .mermaid-frame[data-rendered="true"]').waitForExist({ timeout: 40_000 })
    const expandedBackground = await browser.execute(
      () =>
        getComputedStyle(
          document.querySelector('.mermaid-expand-viewport') ??
            ((): never => {
              throw new Error(
                "Missing fixture element: document.querySelector('.mermaid-expand-viewport')",
              )
            })(),
        ).backgroundColor,
    )
    expect(expandedBackground).toBe(hostState.background)
    expect(await $('dialog .mermaid-expand-stage svg').isExisting()).toBe(false)
    await browser.switchFrame(await $('dialog .mermaid-frame').getElement())
    const expandedFont = await browser.execute(() => ({
      family: getComputedStyle(
        document.querySelector('svg') ??
          ((): never => {
            throw new Error("Missing fixture element: document.querySelector('svg')")
          })(),
      ).fontFamily,
      pele: Boolean(document.querySelector('svg.pele')),
      loaded: Array.from(document.fonts).filter(
        (font) => font.family === 'Pliant' && font.status === 'loaded',
      ).length,
    }))
    expect(expandedFont.family).toContain('Pliant')
    expect(expandedFont.pele).toBe(true)
    expect(expandedFont.loaded).toBe(2)
    await browser.switchToParentFrame()

    const toolbarGeometry = await browser.execute(() => {
      const controls = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.mermaid-expand-tool'),
      )
      return controls.map((control) => {
        const controlRect = control.getBoundingClientRect()
        const iconRect = control.querySelector('svg')?.getBoundingClientRect()
        return {
          label: control.getAttribute('aria-label'),
          height: controlRect.height,
          iconCenterOffset: iconRect
            ? iconRect.top + iconRect.height / 2 - (controlRect.top + controlRect.height / 2)
            : null,
        }
      })
    })
    expect(toolbarGeometry).toHaveLength(3)
    const toolbarHeights = toolbarGeometry.map(({ height }) => height)
    expect(Math.max(...toolbarHeights) - Math.min(...toolbarHeights)).toBeLessThanOrEqual(1)
    for (const { iconCenterOffset } of toolbarGeometry) {
      if (iconCenterOffset === null) continue
      expect(Math.abs(iconCenterOffset)).toBeLessThanOrEqual(1)
    }

    await saveAppScreenshot('mermaid-diagram-agent-loop.png')
    await $('.mermaid-expand-close').click()
    await $('dialog .mermaid-frame').waitForExist({ reverse: true })
    expect(await $('dialog.mermaid-expand-dialog').isDisplayed()).toBe(false)
    expect(await $('dialog .mermaid-frame').isExisting()).toBe(false)
  })

  it('keeps an initialized diagram isolated while a hostile HTML preview runs in a real guest', async () => {
    await prepareE2eScreenshot()
    const baseline = await browser.execute(async () => ({
      // ChromeDriver rewrites this bookkeeping attribute when switching frame contexts.
      message: document
        .querySelector('.message-text')
        ?.innerHTML.replace(/\s+cd_frame_id_="[^"]*"/g, ''),
      theme: await window.api.settings.get('theme'),
      selectedThread: document.querySelector('.chat-row.selected')?.getAttribute('data-thread-id'),
      width: document.querySelector('iframe.mermaid-frame')?.getBoundingClientRect().width,
      height: document.querySelector('iframe.mermaid-frame')?.getBoundingClientRect().height,
    }))
    const markup = `<div class="combined-attack"><img src="${probeUrl}/parent-image"><iframe srcdoc="<img src='${probeUrl}/parent-srcdoc'>"></iframe><script>document.body.dataset.combinedExecuted='yes'</script></div>`
    const payloads = [
      {
        nonce: 'combined-preview',
        type: 'rendered',
        width: 1e9,
        height: 1e9,
        html: markup,
        svg: markup,
      },
      {
        nonce: 'combined-preview',
        type: 'settings:set',
        key: 'theme',
        value: baseline.theme === 'light' ? 'dark' : 'light',
        html: markup,
      },
    ]
    await browser.execute(() => {
      const diagramFrame = (): HTMLIFrameElement | null =>
        document.querySelector('iframe.mermaid-frame')
      const audit = document.createElement('output')
      audit.id = 'combined-audit'
      audit.hidden = true
      audit.dataset['arrivals'] = '0'
      audit.dataset['insertions'] = '0'
      audit.dataset['reply'] = 'false'
      document.body.append(audit)
      const observer = new MutationObserver((records) => {
        for (const record of records)
          for (const node of record.addedNodes) {
            if (
              node instanceof Element &&
              (node.matches('.combined-attack, [srcdoc]') ||
                node.querySelector('.combined-attack, [srcdoc]'))
            ) {
              audit.dataset['insertions'] = String(Number(audit.dataset['insertions']) + 1)
            }
          }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      const receive = (event: MessageEvent<unknown>): void => {
        if (
          typeof event.data !== 'object' ||
          event.data === null ||
          Reflect.get(event.data, 'nonce') !== 'combined-preview'
        )
          return
        audit.dataset['arrivals'] = String(Number(audit.dataset['arrivals']) + 1)
        audit.dataset['diagramSource'] = String(event.source === diagramFrame()?.contentWindow)
        for (const port of event.ports) port.close()
      }
      window.addEventListener('message', receive)
      audit.addEventListener('inspect', () => {
        audit.dataset['diagramReady'] = String(
          diagramFrame()?.getAttribute('data-rendered') === 'true',
        )
      })
      const channel = new MessageChannel()
      channel.port1.onmessage = (): void => {
        audit.dataset['reply'] = 'true'
      }
      audit.addEventListener(
        'rerender',
        () => {
          const frame = diagramFrame()
          if (!frame) throw new Error('Missing diagram')
          frame.contentWindow?.postMessage(
            { type: 'render', source: 'graph TD; Attacker --> Replaced', theme: 'light' },
            '*',
            [channel.port2],
          )
        },
        { once: true },
      )
      audit.addEventListener(
        'cleanup',
        () => {
          observer.disconnect()
          window.removeEventListener('message', receive)
          channel.port1.close()
          channel.port2.close()
          audit.remove()
        },
        { once: true },
      )
      // Sensitivity control: the detector must see even a marker removed immediately.
      const marker = document.createElement('span')
      marker.className = 'combined-attack'
      document.body.append(marker)
      marker.remove()
    })
    try {
      await browser.waitUntil(
        async () => (await $('#combined-audit').getAttribute('data-insertions')) === '1',
      )
      await browser.execute(() =>
        document.getElementById('combined-audit')?.setAttribute('data-insertions', '0'),
      )
      const html = `<title>Isolated preview</title><style>body{font:14px system-ui;padding:16px;color:#eee;background:#111}h1{font-size:22px}button{padding:12px;font-size:13px;max-width:100%}img,.combined-attack{display:none}iframe{position:absolute;width:0;height:0;border:0}</style>
        <h1>Isolated preview</h1><button id="normal" onclick="this.textContent='Preview interaction works'">Try preview</button><p id="status">Running isolation probes</p>
        <script>
        (async () => {
          const payloads = ${JSON.stringify(payloads).replaceAll('<', '\\u003c')};
          const violations = [];
          document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
          let selfMessages = 0;
          window.addEventListener('message', event => { if(event.data?.nonce === 'combined-preview' && event.source === window) selfMessages++; });
          let retryTimer;
          let retryCount = 0;
          window.startCombinedRetry = () => {
            retryTimer = setInterval(() => {
              for(const payload of payloads) top.postMessage(payload, '*');
              retryCount++;
            }, 20);
          };
          window.stopCombinedRetry = () => clearInterval(retryTimer);
          window.combinedRetryCount = () => retryCount;
          let parentWriteBlocked = false;
          try { parent.document.body.insertAdjacentHTML('beforeend', payloads[0].html); } catch { parentWriteBlocked = true; }
          let parentApiBlocked = false;
          try { parent.api.settings.set('theme', payloads[1].value); } catch { parentApiBlocked = true; }
          for(const payload of payloads) parent.postMessage(payload, '*');
          const results = await Promise.all([
            fetch('${probeUrl}/preview-fetch').then(() => false, () => true),
            new Promise(resolve => { const img = new Image(); img.onload=()=>resolve(false); img.onerror=()=>resolve(true); img.src='${probeUrl}/preview-image'; document.body.append(img); }),
            new Promise(resolve => { const script=document.createElement('script'); script.onload=()=>resolve(false); script.onerror=()=>resolve(true); script.src='${probeUrl}/preview-script'; document.head.append(script); })
          ]);
          const nested = document.createElement('iframe'); nested.srcdoc=payloads[0].html; document.body.append(nested);
          const remote = document.createElement('iframe'); remote.src='${probeUrl}/preview-frame'; document.body.append(remote);
          // Bounded quiet window for absent bridge replies and deferred resource attempts.
          await new Promise(resolve => setTimeout(resolve, 250));
          window.combinedResult = { parentIsSelf:parent===window, topIsSelf:top===window, openerAbsent:opener===null, selfMessages, parentWriteBlocked, parentApiBlocked, api:typeof window.api, require:typeof window.require, process:typeof window.process, electron:typeof window.electron, results, violations };
          document.querySelector('#status').textContent='Isolation probes complete';
        })();
        </script>`
      // Use the same MCP tool and resource dispatch as a generated artefact.
      const reply = 'The isolated preview is open beside the diagram.'
      const scenario = await prepareMockToolTurn(
        'Show this isolated preview beside the diagram.',
        {
          name: 'mcp__copse-canvas__render_html_artefact',
          args: { title: 'Isolated preview', html },
        },
        reply,
      )
      await $('.submit-btn').click()
      await expectAssistantReply(reply)
      await waitForAgentIdle(30_000)
      await scenario.assertComplete()
      await $('.browser-tab-panel.is-active webview').waitForExist({ timeout: 15_000 })
      expect(await $('.browser-tabs-tab.is-active .browser-tabs-tab-label').getText()).toBe(
        'Isolated Preview',
      )
      await browser.waitUntil(async () =>
        browser.execute(async () => {
          const guest = document.querySelector<Electron.WebviewTag>(
            '.browser-tab-panel.is-active webview',
          )
          return (await guest?.executeJavaScript('Boolean(window.combinedResult)')) === true
        }),
      )
      const guestResult: unknown = await browser.execute(async () => {
        const guest = document.querySelector<Electron.WebviewTag>(
          '.browser-tab-panel.is-active webview',
        )
        const result: unknown = await guest?.executeJavaScript('window.combinedResult')
        return result
      })
      const result = z
        .object({
          parentIsSelf: z.boolean(),
          topIsSelf: z.boolean(),
          openerAbsent: z.boolean(),
          selfMessages: z.number(),
          parentWriteBlocked: z.boolean(),
          parentApiBlocked: z.boolean(),
          api: z.string(),
          require: z.string(),
          process: z.string(),
          electron: z.string(),
          results: z.array(z.boolean()),
          violations: z.array(z.string()),
        })
        .parse(guestResult)
      // Electron webviews are separate WebContents: parent is the guest itself, not the embedder.
      expect(result.parentIsSelf).toBe(true)
      expect(result.topIsSelf).toBe(true)
      expect(result.openerAbsent).toBe(true)
      expect(result.parentWriteBlocked).toBe(false) // The write landed only in the guest itself.
      expect(result.parentApiBlocked).toBe(true)
      expect(result.selfMessages).toBe(payloads.length)
      expect(result.results).toEqual([true, true, true])
      for (const capability of [result.api, result.require, result.process, result.electron])
        expect(capability).toBe('undefined')
      for (const directive of ['connect-src', 'img-src', 'script-src-elem', 'frame-src'])
        expect(result.violations).toContain(directive)
      expect(await $('#combined-audit').getAttribute('data-arrivals')).toBe('0')

      // Privileged test injection now exercises an actual child-to-app boundary.
      // This is independent of, and does not claim reachability from, preview HTML.
      const frame = await $('.message-text iframe.mermaid-frame[data-rendered="true"]').getElement()
      await browser.switchFrame(frame)
      const diagram = await browser.execute((messages) => {
        let parentWriteBlocked = false
        let parentApiBlocked = false
        try {
          window.parent.document.body.insertAdjacentHTML('beforeend', messages[0]?.html ?? '')
        } catch {
          parentWriteBlocked = true
        }
        try {
          Reflect.get(window.parent, 'api')
        } catch {
          parentApiBlocked = true
        }
        for (const message of messages) {
          const channel = new MessageChannel()
          window.parent.postMessage(message, '*', [channel.port2])
          channel.port1.close()
        }
        return {
          parentWriteBlocked,
          parentApiBlocked,
          api: typeof Reflect.get(window, 'api'),
          require: typeof Reflect.get(window, 'require'),
          process: typeof Reflect.get(window, 'process'),
          svg: document.querySelector('svg')?.outerHTML,
        }
      }, payloads)
      expect(diagram.parentWriteBlocked).toBe(true)
      expect(diagram.parentApiBlocked).toBe(true)
      expect([diagram.api, diagram.require, diagram.process]).toEqual([
        'undefined',
        'undefined',
        'undefined',
      ])
      await browser.switchToParentFrame()
      await browser.waitUntil(
        async () =>
          (await $('#combined-audit').getAttribute('data-arrivals')) === String(payloads.length),
      )
      expect(await $('#combined-audit').getAttribute('data-diagram-source')).toBe('true')
      await browser.execute(() =>
        document.getElementById('combined-audit')?.dispatchEvent(new Event('rerender')),
      )
      await browser.switchFrame(frame)
      const afterDiagram = await browser.execute(
        () =>
          new Promise<string | undefined>((resolve) =>
            setTimeout(() => {
              resolve(document.querySelector('svg')?.outerHTML)
            }, 250),
          ),
      )
      expect(afterDiagram).toBe(diagram.svg)
      await browser.switchToParentFrame()
      await browser.execute(() =>
        document.getElementById('combined-audit')?.dispatchEvent(new Event('inspect')),
      )
      expect(await $('#combined-audit').getAttribute('data-diagram-ready')).toBe('true')
      expect(await $('#combined-audit').getAttribute('data-reply')).toBe('false')
      expect(await $('#combined-audit').getAttribute('data-insertions')).toBe('0')
      expect(
        await browser.execute(async () => ({
          message: document
            .querySelector('.message-text')
            ?.innerHTML.replace(/\s+cd_frame_id_="[^"]*"/g, ''),
          theme: await window.api.settings.get('theme'),
          selectedThread: document
            .querySelector('.chat-row.selected')
            ?.getAttribute('data-thread-id'),
          width: document.querySelector('iframe.mermaid-frame')?.getBoundingClientRect().width,
          height: document.querySelector('iframe.mermaid-frame')?.getBoundingClientRect().height,
        })),
      ).toEqual(baseline)
      expect(
        await browser.execute(
          () =>
            document.querySelectorAll('.mermaid-diagram svg, .combined-attack, iframe[srcdoc]')
              .length,
        ),
      ).toBe(0)
      expect(requests).toEqual([])
      const guestCapture = await browser.execute(async () => {
        const guest = document.querySelector<Electron.WebviewTag>(
          '.browser-tab-panel.is-active webview',
        )
        if (!guest) throw new Error('Missing preview guest')
        const interaction: unknown = await guest.executeJavaScript(
          'document.querySelector("#normal").click(); document.querySelector("#normal").textContent',
        )
        return { interaction, image: (await guest.capturePage()).toDataURL() }
      })
      expect(guestCapture.interaction).toBe('Preview interaction works')
      writeFileSync(
        join(SCREENSHOT_DIR, 'mermaid-preview-attacker-guest.png'),
        Buffer.from(guestCapture.image.split(',')[1] ?? '', 'base64'),
      )
      await saveAppScreenshot('mermaid-preview-combined-isolation.png', undefined, async () => {
        await browser.execute(async () => {
          document.querySelector('iframe.mermaid-frame')?.scrollIntoView({ block: 'center' })
          const guest = document.querySelector<Electron.WebviewTag>(
            '.browser-tab-panel.is-active webview',
          )
          await guest?.executeJavaScript(
            'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
          )
        })
      })

      // Keep the actual artefact retrying while user expansion initializes a
      // new diagram frame. Its messages must remain inside the guest throughout.
      await browser.execute(async () => {
        const guest = document.querySelector<Electron.WebviewTag>(
          '.browser-tab-panel.is-active webview',
        )
        await guest?.executeJavaScript('window.startCombinedRetry()')
      })
      await $('.mermaid-diagram--folded').click()
      await $('dialog .mermaid-frame[data-rendered="true"]').waitForExist({ timeout: 40_000 })
      await browser.waitUntil(async () =>
        browser.execute(async () => {
          const guest = document.querySelector<Electron.WebviewTag>(
            '.browser-tab-panel.is-active webview',
          )
          const count: unknown = await guest?.executeJavaScript('window.combinedRetryCount()')
          return typeof count === 'number' && count >= 3
        }),
      )
      await browser.execute(async () => {
        const guest = document.querySelector<Electron.WebviewTag>(
          '.browser-tab-panel.is-active webview',
        )
        await guest?.executeJavaScript('window.stopCombinedRetry()')
      })
      expect(await $('#combined-audit').getAttribute('data-arrivals')).toBe(String(payloads.length))
      await $('.mermaid-expand-close').click()

      // Probe control uses ordinary user navigation, which must permit these requests.
      const address = $('.browser-tab-panel.is-active .browser-url-input')
      await address.setValue(`${probeUrl}/control`)
      await browser.keys('Enter')
      await browser.waitUntil(async () =>
        browser.execute(async () => {
          const guest = document.querySelector<Electron.WebviewTag>(
            '.browser-tab-panel.is-active webview',
          )
          return (
            (await guest?.executeJavaScript(
              'document.querySelector("#control")?.naturalWidth === 16',
            )) === true
          )
        }),
      )
      expect(requests).toContain('/control')
      expect(requests).toContain('/control.svg')
      expect(requests.filter((path) => !controlPaths.has(path))).toEqual([])
    } finally {
      await browser.switchToParentFrame()
      await browser.execute(() =>
        document.getElementById('combined-audit')?.dispatchEvent(new Event('cleanup')),
      )
    }
  })

  it('blocks network, inline script, navigation, and unsolicited parent messages even with code execution in the frame', async () => {
    const frame = await $('.message-text iframe.mermaid-frame').getElement()
    const originalHeight = await frame.getCSSProperty('height')
    await browser.switchFrame(frame)
    const probes = await browser.execute(
      (url) =>
        new Promise<{
          fetchBlocked: boolean
          inlineExecuted: string | null | undefined
          violations: string[]
        }>((done) => {
          const violations: string[] = []
          document.addEventListener('securitypolicyviolation', (event) =>
            violations.push(event.effectiveDirective),
          )
          const script = document.createElement('script')
          script.textContent = 'document.body.dataset.inlineExecuted = "yes"'
          document.body.append(script)
          const img = document.createElement('img')
          img.src = `${url}/diagram-image-probe`
          document.body.append(img)
          const svg = document.querySelector('svg')
          for (const tag of ['image', 'use', 'feImage']) {
            const resource = document.createElementNS('http://www.w3.org/2000/svg', tag)
            resource.setAttribute('href', `${url}/diagram-svg-${tag}.svg#probe`)
            svg?.append(resource)
          }
          const style = document.createElement('style')
          style.textContent = `@import url('${url}/diagram-style.css');
        @font-face { font-family: MermaidProbe; src: url('${url}/diagram-font.woff2'); }
        .mermaid-probe { font-family: MermaidProbe; background-image: url('${url}/diagram-css-image.png'); }`
          document.head.append(style)
          const label = document.createElement('p')
          label.className = 'mermaid-probe'
          label.textContent = 'Force font loading'
          document.body.append(label)
          window.parent.postMessage({ type: 'rendered', width: 1e9, height: 1e9 }, '*')
          void fetch(`${url}/diagram-fetch-probe`).then(
            () => {
              done({
                fetchBlocked: false,
                inlineExecuted: document.body.dataset['inlineExecuted'],
                violations,
              })
            },
            () =>
              setTimeout(() => {
                done({
                  fetchBlocked: true,
                  inlineExecuted: document.body.dataset['inlineExecuted'] ?? null,
                  violations,
                })
              }, 100),
          )
        }),
      probeUrl,
    )
    expect(probes.fetchBlocked).toBe(true)
    expect(probes.inlineExecuted).toBe(null)
    expect(probes.violations).toContain('connect-src')
    expect(probes.violations).toContain('img-src')
    expect(probes.violations).toContain('font-src')
    expect(probes.violations).toContain('style-src-elem')
    expect(probes.violations).toContain('script-src-elem')
    await browser.execute((url) => {
      window.location.href = `${url}/diagram-navigation-probe`
    }, probeUrl)
    await browser.switchToParentFrame()
    await browser.switchFrame(await $('.message-text iframe.mermaid-frame').getElement())
    const navigation = await browser.execute(() => window.location.href)
    // Chromium replaces the cancelled navigation with its local error document.
    // The security assertion is that the destination receives no request.
    expect(navigation).toBe('chrome-error://chromewebdata/')
    await browser.switchToParentFrame()
    expect((await frame.getCSSProperty('height')).value).toBe(originalHeight.value)
    await browser.pause(100)
    expect(requests.filter((path) => !controlPaths.has(path))).toEqual([])
  })
})
