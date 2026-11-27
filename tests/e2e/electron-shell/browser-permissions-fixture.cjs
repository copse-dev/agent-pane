'use strict'

// Observe the handlers installed by production, without changing their decisions.
// The test launcher is the injection boundary: no product IPC or setting is added.
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, Menu, webContents, clipboard } = require('electron')

function install(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const record = (event) =>
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`)
  app.on('session-created', (sess) => {
    const setRequest = sess.setPermissionRequestHandler.bind(sess)
    sess.setPermissionRequestHandler = (handler) => {
      record({ type: 'installed', handler: 'request' })
      setRequest(
        handler &&
          ((wc, permission, callback, details) => {
            handler(
              wc,
              permission,
              (allowed) => {
                const observation = {
                  type: 'request',
                  permission,
                  allowed,
                  contentsType: wc.getType(),
                  url: details.requestingUrl,
                  mediaTypes: details.mediaTypes,
                }
                record(observation)
                callback(allowed)
              },
              details,
            )
          }),
      )
    }
    const setCheck = sess.setPermissionCheckHandler.bind(sess)
    sess.setPermissionCheckHandler = (handler) => {
      record({ type: 'installed', handler: 'check' })
      setCheck(
        handler &&
          ((wc, permission, origin, details) => {
            const allowed = handler(wc, permission, origin, details)
            record({
              type: 'check',
              permission,
              allowed,
              contentsType: wc?.getType() ?? 'worker',
              url: details.requestingUrl ?? origin,
            })
            return allowed
          }),
      )
    }
  })
  app.on('web-contents-created', (_event, wc) => {
    wc.on('did-finish-load', () => {
      if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/permissions$/.test(wc.getURL())) return
      wc.focus()
      // First prove the same APIs fail without activation; the interactive
      // allowance is exercised later through real input.
      void (async () => {
        const results = await wc.executeJavaScript('window.runPermissionProbes()', false)
        for (const permission of ['fullscreen', 'clipboard-sanitized-write']) {
          results[`${permission}-without-gesture`] = await wc.executeJavaScript(
            `window.runAffordanceProbe(${JSON.stringify(permission)})`,
            false,
          )
          if (wc.getType() !== 'webview') {
            results[permission] = await wc.executeJavaScript(
              `window.runAffordanceProbe(${JSON.stringify(permission)})`,
              true,
            )
            continue
          }
          const { x, y } = await wc.executeJavaScript(
            `(() => {
              const element = document.querySelector(${JSON.stringify(`#${permission}-probe`)});
              element.scrollIntoView({ block: 'center' });
              const box = element.getBoundingClientRect();
              return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
            })()`,
            false,
          )
          const owner = BrowserWindow.fromWebContents(wc.hostWebContents)
          owner?.show()
          owner?.focus()
          app.focus({ steal: true })
          wc.focus()
          await new Promise((resolve) => setTimeout(resolve, 100))
          wc.sendInputEvent({ type: 'mouseMove', x, y })
          wc.sendInputEvent({ type: 'mouseDown', button: 'left', x, y, clickCount: 1 })
          wc.sendInputEvent({ type: 'mouseUp', button: 'left', x, y, clickCount: 1 })
          results[permission] = await wc.executeJavaScript(
            `new Promise((resolve, reject) => {
              const started = Date.now();
              const poll = () => {
                const value = window.affordanceResults[${JSON.stringify(permission)}];
                if (value !== undefined) resolve(value);
                else if (Date.now() - started > 4000) reject(new Error('affordance probe timed out'));
                else setTimeout(poll, 25);
              };
              poll();
            })`,
            false,
          )
        }
        record({ type: 'results', contentsType: wc.getType(), results })
      })().catch((error) => record({ type: 'error', error: String(error) }))
    })
  })

  // WebDriver cannot select an Electron native menu. Deliver real right-button
  // input to the guest, then choose its product-built Copy Link Address item.
  let copying = false
  const popup = Menu.prototype.popup
  Menu.prototype.popup = function (options) {
    if (!copying) return popup.call(this, options)
    copying = false
    const item = this.items.find((entry) => entry.label === 'Copy Link Address')
    if (!item) throw new Error('browser permission fixture: Copy Link Address missing')
    item.click()
    options?.callback?.()
  }
  const writeText = clipboard.writeText.bind(clipboard)
  clipboard.writeText = async (text) => {
    await writeText(text)
    record({ type: 'host-copy', text: await clipboard.readText() })
  }
  const poll = setInterval(() => {
    const command = path.join(dir, 'copy-link')
    if (!fs.existsSync(command)) return
    fs.unlinkSync(command)
    const wc = webContents
      .getAllWebContents()
      .find(
        (contents) =>
          contents.getType() === 'webview' && contents.getURL().endsWith('/permissions'),
      )
    if (!wc) throw new Error('browser permission fixture: guest missing')
    void wc
      .executeJavaScript(
        `(() => {
      const box = document.querySelector('#copy-target').getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    })()`,
        false,
      )
      .then(({ x, y }) => {
        copying = true
        wc.focus()
        wc.sendInputEvent({ type: 'mouseDown', button: 'right', x, y, clickCount: 1 })
        wc.sendInputEvent({ type: 'mouseUp', button: 'right', x, y, clickCount: 1 })
      })
  }, 50)
  poll.unref()
}

module.exports = { install }
