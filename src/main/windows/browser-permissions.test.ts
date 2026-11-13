import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { Session } from 'electron'
import { configureBrowserPermissions, isBrowserPermissionAllowed } from './browser-permissions.ts'

type RequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type CheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>

// Exhaustive for the installed Electron version: upgrades require reviewing new names.
const permissions = {
  ar: false,
  'automatic-fullscreen': false,
  'background-fetch': false,
  'background-sync': false,
  'captured-surface-control': false,
  'clipboard-read': false,
  'clipboard-sanitized-write': false,
  'deprecated-sync-clipboard-read': false,
  'display-capture': false,
  fileSystem: false,
  fullscreen: false,
  geolocation: false,
  'geolocation-approximate': false,
  'hand-tracking': false,
  hid: false,
  'idle-detection': false,
  keyboardLock: false,
  'local-fonts': false,
  'local-network': false,
  'local-network-access': false,
  'loopback-network': false,
  media: false,
  mediaKeySystem: false,
  midi: false,
  midiSysex: false,
  nfc: false,
  notifications: false,
  openExternal: false,
  'payment-handler': false,
  'periodic-background-sync': false,
  'persistent-storage': false,
  pointerLock: false,
  'screen-wake-lock': false,
  sensors: false,
  serial: false,
  'smart-card': false,
  'speaker-selection': false,
  'storage-access': false,
  'system-wake-lock': false,
  'top-level-storage-access': false,
  usb: false,
  vr: false,
  'web-app-installation': false,
  'web-printing': false,
  'window-management': false,
  unknown: false,
} satisfies Record<Parameters<RequestHandler>[1], false>

function installedHandlers(): { request: RequestHandler; check: CheckHandler } {
  const registered: { request?: RequestHandler; check?: CheckHandler } = {}
  configureBrowserPermissions({
    setPermissionRequestHandler: (handler) => {
      assert.ok(handler)
      registered.request = handler
    },
    setPermissionCheckHandler: (handler) => {
      assert.ok(handler)
      registered.check = handler
    },
  })
  assert.ok(registered.request)
  assert.ok(registered.check)
  return { request: registered.request, check: registered.check }
}

describe('browser permissions', () => {
  it('denies every current permission and future, malformed or prototype-like names', () => {
    const { request, check } = installedHandlers()
    const names = [
      ...Object.keys(permissions satisfies Record<Parameters<CheckHandler>[1], false>),
      'future-chromium-permission',
      '',
      '__proto__',
      'constructor',
      'toString',
      'fileSystem ',
      'FULLSCREEN',
      'display-capture\n',
    ]
    // No handler needs the contents object; test both document and worker checks.
    const wc = {}
    for (const permission of names) {
      assert.equal(isBrowserPermissionAllowed(permission), false, permission)
      for (const isMainFrame of [true, false]) {
        const details = { requestingUrl: 'https://example.com/', isMainFrame }
        const replies: boolean[] = []
        // Reflect also passes names newer than Electron's compile-time union.
        Reflect.apply(request, undefined, [
          wc,
          permission,
          (value: boolean): void => {
            replies.push(value)
          },
          details,
        ])
        assert.deepEqual(replies, [false], `request ${permission}`)
        for (const contents of [wc, null]) {
          assert.equal(
            Reflect.apply(check, undefined, [contents, permission, 'https://example.com', details]),
            false,
            `check ${permission}`,
          )
        }
      }
    }
  })

  it('closes the old allow-by-omission decisions rather than just retaining its denials', () => {
    const previouslyDenied = new Set([
      'media',
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'pointerLock',
      'openExternal',
      'hid',
      'serial',
      'usb',
      'clipboard-read',
    ])
    for (const permission of [
      'display-capture',
      'fileSystem',
      'unknown',
      'future-chromium-permission',
      'clipboard-sanitized-write',
      'fullscreen',
    ]) {
      assert.equal(!previouslyDenied.has(permission), true, `negative control ${permission}`)
      assert.equal(isBrowserPermissionAllowed(permission), false, permission)
    }
  })
})
