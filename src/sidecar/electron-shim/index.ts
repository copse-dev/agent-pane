/**
 * A drop-in replacement for the `electron` module, letting `src/main` run as a
 * plain Node process (the Tauri sidecar). Substituted at bundle time by
 * `scripts/build-tauri.mts` via an esbuild alias — `src/main` itself is
 * byte-identical between the Electron build and the sidecar build.
 *
 * The mapping (see docs/plans/tauri-servo-migration.md):
 *
 * - `ipcMain` registers handlers into a channel table; the loopback WebSocket
 *   server (`../ws-server.ts`) dispatches renderer invokes into it, fabricating
 *   an event whose `senderFrame` is the bound window's `mainFrame` so the
 *   existing `assertMainFrameSender`/`app-frames` guards work unmodified.
 * - `BrowserWindow` proxies real window lifecycle to the Rust shell over the
 *   stdio line protocol (`../shell-link.ts`); `webContents.send` becomes a WS
 *   event frame to the renderer bound to that window.
 * - OS-integration surfaces the shell will eventually own (dialog, Menu,
 *   Notification, globalShortcut, safeStorage, clipboard) degrade to inert
 *   defaults here; each is a phase-3 item in the migration plan, not a
 *   permanent stub.
 *
 * Deliberately untyped against Electron's own .d.ts: consumers compile against
 * the real `electron` types; this module only has to agree at runtime.
 */
import { EventEmitter } from 'node:events'
import { homedir, tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  shellSend,
  onShellMessage,
  startShellLink,
  isShellAttached,
  type CreateWindowMessage,
} from '../shell-link.ts'

class ShimEvent {
  defaultPrevented = false
  preventDefault(): void {
    this.defaultPrevented = true
  }
}

// ---------------------------------------------------------------------------
// app

function defaultAppData(): string {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (platform() === 'win32') return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
  return process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
}

class AppShim extends EventEmitter {
  private paths = new Map<string, string>()
  private appName = 'copse-sidecar'
  isPackaged = false
  /** macOS dock API; consumers already handle its absence off-macOS. */
  dock: undefined = undefined
  name = this.appName

  getName(): string {
    return this.appName
  }
  setName(name: string): void {
    this.appName = name
    this.name = name
  }
  getVersion(): string {
    return process.env['npm_package_version'] ?? '0.0.0-sidecar'
  }
  getPath(name: string): string {
    const set = this.paths.get(name)
    if (set) return set
    switch (name) {
      case 'appData':
        return defaultAppData()
      case 'userData':
        return join(defaultAppData(), this.appName)
      case 'home':
        return homedir()
      case 'temp':
        return tmpdir()
      case 'logs':
        return join(defaultAppData(), this.appName, 'logs')
      case 'exe':
        return process.execPath
      case 'downloads':
        return join(homedir(), 'Downloads')
      case 'documents':
        return join(homedir(), 'Documents')
      case 'desktop':
        return join(homedir(), 'Desktop')
      default:
        return join(defaultAppData(), this.appName)
    }
  }
  setPath(name: string, value: string): void {
    this.paths.set(name, value)
  }
  getAppPath(): string {
    return process.cwd()
  }
  whenReady(): Promise<void> {
    // Resolved on a macrotask so the sidecar entry finishes wiring (WS server,
    // shell link) before main's boot chain runs — same ordering guarantee
    // Electron's ready event gives relative to module evaluation.
    return new Promise((resolve) => {
      setImmediate(() => {
        this.emit('ready')
        resolve()
      })
    })
  }
  requestSingleInstanceLock(): boolean {
    return true
  }
  quit(): void {
    const event = new ShimEvent()
    this.emit('before-quit', event)
    if (event.defaultPrevented) return
    const willQuit = new ShimEvent()
    this.emit('will-quit', willQuit)
    if (willQuit.defaultPrevented) return
    this.emit('quit', new ShimEvent(), 0)
    process.exit(0)
  }
  exit(code = 0): void {
    process.exit(code)
  }
  focus(): void {}
  setAboutPanelOptions(): void {}
  setAppUserModelId(): void {}
  setLoginItemSettings(): void {}
}

export const app = new AppShim()

// ---------------------------------------------------------------------------
// webContents / BrowserWindow

let nextWebContentsId = 1

class WebContentsShim extends EventEmitter {
  readonly id = nextWebContentsId++
  /**
   * Stable identity object standing in for Electron's WebFrameMain. The IPC
   * guards compare `event.senderFrame` against this by reference (and against
   * the `app-frames.ts` allowlist Set) — fabricated invoke events carry this
   * exact object, so both checks behave as under Electron.
   */
  readonly mainFrame: { readonly frameForWebContentsId: number } = {
    frameForWebContentsId: this.id,
  }
  session: SessionShim = defaultSessionShim
  private destroyed = false
  private url = ''
  private client: ((channel: string, args: unknown[]) => void) | null = null
  private owner: BrowserWindow | null = null

  constructor(owner?: BrowserWindow) {
    super()
    this.owner = owner ?? null
    allWebContents.add(this)
    webContents.emitCreated(this)
  }

  bindClient(sendEvent: (channel: string, args: unknown[]) => void): () => void {
    this.client = sendEvent
    this.emit('did-finish-load')
    return () => {
      if (this.client === sendEvent) this.client = null
    }
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) return
    if (!this.client) {
      // Same failure mode as Electron sending before the renderer loads: the
      // message is dropped. Logged because during bring-up it usually means a
      // window whose renderer never connected.
      console.error(`[electron-shim] dropped event '${channel}' (no renderer bound)`)
      return
    }
    this.client(channel, args)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  markDestroyed(): void {
    this.destroyed = true
    allWebContents.delete(this)
  }
  getOwnerWindow(): BrowserWindow | null {
    return this.owner
  }
  getURL(): string {
    return this.url
  }
  setURLForShim(url: string): void {
    this.url = url
  }
  getTitle(): string {
    return ''
  }
  isLoading(): boolean {
    return false
  }
  loadURL(url: string): Promise<void> {
    this.url = url
    console.error(`[electron-shim] webContents.loadURL unsupported in sidecar: ${url}`)
    return Promise.resolve()
  }
  reload(): void {}
  executeJavaScript(_code: string): Promise<unknown> {
    return Promise.reject(new Error('executeJavaScript is not supported in the sidecar prototype'))
  }
  capturePage(): Promise<{ toPNG(): Buffer; isEmpty(): boolean }> {
    return Promise.resolve({ toPNG: () => Buffer.alloc(0), isEmpty: () => true })
  }
  setWindowOpenHandler(_handler: unknown): void {}
  openDevTools(): void {}
  closeDevTools(): void {}
  toggleDevTools(): void {}
  isDevToolsOpened(): boolean {
    return false
  }
  focus(): void {}
  setZoomFactor(): void {}
  getZoomFactor(): number {
    return 1
  }
  /**
   * Chromium's transient pinch-zoom limits, which Servo has no equivalent for.
   * A no-op resolved promise rather than an omission: `visual-pinch-zoom.ts`
   * calls this unconditionally during window setup, so its absence threw
   * during the WS hello and every renderer was refused the connection — the
   * whole app, not just zoom.
   */
  setVisualZoomLevelLimits(_minimumLevel: number, _maximumLevel: number): Promise<void> {
    return Promise.resolve()
  }
}

const allWebContents = new Set<WebContentsShim>()

let nextWindowId = 1
const windowsById = new Map<number, BrowserWindow>()

interface BrowserWindowOptions {
  x?: number
  y?: number
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  title?: string
  show?: boolean
  backgroundColor?: string
  [key: string]: unknown
}

export class BrowserWindow extends EventEmitter {
  readonly id = nextWindowId++
  readonly webContents: WebContentsShim
  private options: BrowserWindowOptions
  private destroyed = false
  private visible: boolean
  private focused = false
  private fullScreen = false
  private maximized = false

  constructor(options: BrowserWindowOptions = {}) {
    super()
    this.options = options
    this.visible = options.show !== false
    this.webContents = new WebContentsShim(this)
    windowsById.set(this.id, this)
  }

  static getAllWindows(): BrowserWindow[] {
    return [...windowsById.values()]
  }
  static fromId(id: number): BrowserWindow | null {
    return windowsById.get(id) ?? null
  }
  static fromWebContents(wc: unknown): BrowserWindow | null {
    for (const win of windowsById.values()) if (win.webContents === wc) return win
    return null
  }
  static getFocusedWindow(): BrowserWindow | null {
    for (const win of windowsById.values()) if (win.focused) return win
    return null
  }

  async loadFile(filePath: string, opts?: { query?: Record<string, string> }): Promise<void> {
    const { wsEndpointReady } = await import('../ws-server.ts')
    const endpoint = await wsEndpointReady()
    // Map the on-disk renderer paths the Electron build loads onto the pages
    // the Tauri build serves from frontendDist. tauri.html is index.html with
    // the ws-bridge script injected (scripts/build-tauri.mts).
    const page = filePath.endsWith('decoder.html') ? 'video/decoder.html' : 'tauri.html'
    const query = new URLSearchParams(opts?.query ?? {})
    query.set('winId', String(this.id))
    query.set('wsPort', String(endpoint.port))
    query.set('wsToken', endpoint.token)
    // A Servo webview inherits no environment, so the perf tracer's two values
    // ride the boot URL instead; ws-bridge/perf-env.ts copies them back into
    // the bundle's stub `process.env` before the preload evaluates. Under
    // Electron this is the renderer process inheriting main's environment.
    if (process.env['COPSE_PERF'] === '1') {
      query.set('copsePerf', '1')
      query.set('copsePerfOrigin', process.env['COPSE_PERF_ORIGIN'] ?? '')
      if (process.env['COPSE_PERF_AUTOPILOT'] === '1') query.set('copseAutopilot', '1')
      if (process.env['COPSE_PERF_SWEEP'] === '1') query.set('copseSweep', '1')
    }
    const url = `${page}?${query.toString()}`
    this.webContents.setURLForShim(url)
    const message: CreateWindowMessage = {
      op: 'create-window',
      winId: this.id,
      url,
      ...(this.options.width !== undefined ? { width: this.options.width } : {}),
      ...(this.options.height !== undefined ? { height: this.options.height } : {}),
      ...(this.options.minWidth !== undefined ? { minWidth: this.options.minWidth } : {}),
      ...(this.options.minHeight !== undefined ? { minHeight: this.options.minHeight } : {}),
      ...(typeof this.options.title === 'string' ? { title: this.options.title } : {}),
      show: this.visible,
      ...(typeof this.options.backgroundColor === 'string'
        ? { backgroundColor: this.options.backgroundColor }
        : {}),
    }
    shellSend(message)
    // Without a compositor readiness signal from Servo, ready-to-show fires as
    // soon as the create request is off — the renderer paints its boot theme
    // (theme-boot.js) before app.js runs, which is the same anti-flash contract
    // the Electron build relies on.
    setImmediate(() => this.emit('ready-to-show'))
  }

  show(): void {
    this.visible = true
    shellSend({ op: 'window', winId: this.id, action: 'show' })
  }
  hide(): void {
    this.visible = false
    shellSend({ op: 'window', winId: this.id, action: 'hide' })
  }
  focus(): void {
    shellSend({ op: 'window', winId: this.id, action: 'focus' })
  }
  blur(): void {}
  close(): void {
    const event = new ShimEvent()
    this.emit('close', event)
    if (event.defaultPrevented) return
    this.destroy()
  }
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.markDestroyed()
    windowsById.delete(this.id)
    shellSend({ op: 'window', winId: this.id, action: 'close' })
    this.emit('closed')
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  isFocused(): boolean {
    return this.focused
  }
  isMinimized(): boolean {
    return false
  }
  isMaximized(): boolean {
    return this.maximized
  }
  isFullScreen(): boolean {
    return this.fullScreen
  }
  maximize(): void {
    this.maximized = true
    shellSend({ op: 'window', winId: this.id, action: 'maximize' })
  }
  unmaximize(): void {
    this.maximized = false
  }
  minimize(): void {
    shellSend({ op: 'window', winId: this.id, action: 'minimize' })
  }
  restore(): void {}
  setFullScreen(flag: boolean): void {
    this.fullScreen = flag
  }
  setTitle(): void {}
  flashFrame(): void {}
  center(): void {}
  setMinimumSize(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return {
      x: this.options.x ?? 0,
      y: this.options.y ?? 0,
      width: this.options.width ?? 1200,
      height: this.options.height ?? 800,
    }
  }
  getNormalBounds(): { x: number; y: number; width: number; height: number } {
    return this.getBounds()
  }
  setBounds(bounds: Partial<{ x: number; y: number; width: number; height: number }>): void {
    this.options = { ...this.options, ...bounds }
  }
  getPosition(): [number, number] {
    return [this.options.x ?? 0, this.options.y ?? 0]
  }
  setPosition(x: number, y: number): void {
    this.options.x = x
    this.options.y = y
  }
  getSize(): [number, number] {
    return [this.options.width ?? 1200, this.options.height ?? 800]
  }
  setSize(width: number, height: number): void {
    this.options.width = width
    this.options.height = height
  }

  handleShellEvent(event: 'close-requested' | 'closed' | 'focus' | 'blur'): void {
    switch (event) {
      case 'close-requested':
        // The shell has already let the OS window close (prototype limitation:
        // close-confirm interception needs the shell to defer the close, a
        // phase-2 item). Run the close chain for its persistence side-effects.
        this.close()
        break
      case 'closed':
        this.destroy()
        break
      case 'focus':
        this.focused = true
        this.emit('focus')
        break
      case 'blur':
        this.focused = false
        this.emit('blur')
        break
    }
  }
}

// ---------------------------------------------------------------------------
// ipcMain

type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown

class IpcMainShim extends EventEmitter {
  private handlers = new Map<string, InvokeHandler>()

  handle(channel: string, handler: InvokeHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, handler)
  }
  handleOnce(channel: string, handler: InvokeHandler): void {
    this.handle(channel, (event, ...args) => {
      this.removeHandler(channel)
      return handler(event, ...args)
    })
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }
  getHandlerForShim(channel: string): InvokeHandler | undefined {
    return this.handlers.get(channel)
  }
}

export const ipcMain = new IpcMainShim()

/** Fabricate the slice of IpcMainInvokeEvent the handlers and guards read. */
function makeIpcEvent(wc: WebContentsShim): {
  sender: WebContentsShim
  senderFrame: unknown
  processId: number
  frameId: number
} {
  return { sender: wc, senderFrame: wc.mainFrame, processId: 0, frameId: 0 }
}

// ---------------------------------------------------------------------------
// Internals consumed by ws-server.ts (same bundle; not part of the electron
// module surface — imported via the module's real path, which esbuild resolves
// to this same module instance as the 'electron' alias).

export const sidecarInternals = {
  /** Bind a WS client to a window; returns unbind. Throws on unknown window. */
  bindClient(winId: number, sendEvent: (channel: string, args: unknown[]) => void): () => void {
    const win = windowsById.get(winId)
    if (!win) throw new Error(`No window with id ${String(winId)}`)
    return win.webContents.bindClient(sendEvent)
  },
  async dispatchInvoke(winId: number, channel: string, args: unknown[]): Promise<unknown> {
    const win = windowsById.get(winId)
    if (!win) throw new Error(`No window with id ${String(winId)}`)
    const handler = ipcMain.getHandlerForShim(channel)
    if (!handler) throw new Error(`No handler registered for '${channel}'`)
    return await handler(makeIpcEvent(win.webContents), ...args)
  },
  dispatchSend(winId: number, channel: string, args: unknown[]): void {
    const win = windowsById.get(winId)
    if (!win) return
    ipcMain.emit(channel, makeIpcEvent(win.webContents), ...args)
  },
  listWindowIds(): number[] {
    return [...windowsById.keys()]
  },
}

startShellLink()
onShellMessage((message) => {
  windowsById.get(message.winId)?.handleShellEvent(message.event)
})

// ---------------------------------------------------------------------------
// The OS-integration stubs (phase-3: move to Tauri plugins via shell RPC).

export const dialog = {
  showOpenDialog: (): Promise<{ canceled: boolean; filePaths: string[] }> =>
    Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: (): Promise<{ canceled: boolean; filePath?: string }> =>
    Promise.resolve({ canceled: true }),
  showMessageBox: (): Promise<{ response: number; checkboxChecked: boolean }> =>
    Promise.resolve({ response: 0, checkboxChecked: false }),
  showErrorBox: (title: string, content: string): void => {
    console.error(`[electron-shim] dialog.showErrorBox: ${title}: ${content}`)
  },
}

function openWithSystemHandler(target: string): void {
  const opener = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform() === 'win32' ? ['/c', 'start', '', target] : [target]
  spawn(opener, args, { detached: true, stdio: 'ignore' }).unref()
}

export const shell = {
  openExternal: (url: string): Promise<void> => {
    openWithSystemHandler(url)
    return Promise.resolve()
  },
  openPath: (path: string): Promise<string> => {
    openWithSystemHandler(path)
    return Promise.resolve('')
  },
  showItemInFolder: (path: string): void => {
    openWithSystemHandler(path)
  },
  trashItem: (): Promise<void> => Promise.resolve(),
}

export class Menu {
  items: unknown[] = []
  static setApplicationMenu(): void {}
  static getApplicationMenu(): Menu | null {
    return null
  }
  static buildFromTemplate(template: unknown[]): Menu {
    const menu = new Menu()
    menu.items = template
    return menu
  }
  append(): void {}
  popup(): void {}
  closePopup(): void {}
}

export class MenuItem {
  options: unknown
  constructor(options: unknown) {
    this.options = options
  }
}

export class Notification extends EventEmitter {
  options: unknown
  constructor(options?: unknown) {
    super()
    this.options = options
  }
  static isSupported(): boolean {
    return false
  }
  show(): void {}
  close(): void {}
}

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return false
  },
  encryptString(_plainText: string): Buffer {
    throw new Error('safeStorage is unavailable in the sidecar (phase-3: OS keyring via shell)')
  },
  decryptString(_encrypted: Buffer): string {
    throw new Error('safeStorage is unavailable in the sidecar (phase-3: OS keyring via shell)')
  },
}

class NativeThemeShim extends EventEmitter {
  shouldUseDarkColors = false
  shouldUseHighContrastColors = false
  shouldUseInvertedColorScheme = false
  private source = 'system'
  get themeSource(): string {
    return this.source
  }
  set themeSource(value: string) {
    this.source = value
    this.shouldUseDarkColors = value === 'dark'
    this.emit('updated')
  }
}

export const nativeTheme = new NativeThemeShim()

interface NativeImageStub {
  isEmpty(): boolean
  toPNG(): Buffer
  resize(): NativeImageStub
  setTemplateImage(): void
}

const nativeImageStub: NativeImageStub = {
  isEmpty: (): boolean => true,
  toPNG: (): Buffer => Buffer.alloc(0),
  resize: (): NativeImageStub => nativeImageStub,
  setTemplateImage: (): void => {},
}

export const nativeImage = {
  createFromPath: (_path: string): NativeImageStub => nativeImageStub,
  createEmpty: (): NativeImageStub => nativeImageStub,
}

export const globalShortcut = {
  register: (_accelerator: string, _callback: () => void): boolean => true,
  unregister: (_accelerator: string): void => {},
  isRegistered: (_accelerator: string): boolean => false,
  unregisterAll: (): void => {},
}

const PRIMARY_DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaSize: { width: 1920, height: 1080 },
  size: { width: 1920, height: 1080 },
  scaleFactor: 1,
  rotation: 0,
}

export const screen = Object.assign(new EventEmitter(), {
  getPrimaryDisplay: () => PRIMARY_DISPLAY,
  getAllDisplays: () => [PRIMARY_DISPLAY],
  getDisplayMatching: (_bounds: unknown) => PRIMARY_DISPLAY,
  getDisplayNearestPoint: (_point: unknown) => PRIMARY_DISPLAY,
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
})

class SessionShim extends EventEmitter {
  webRequest = {
    onBeforeRequest: (): void => {},
    onBeforeSendHeaders: (): void => {},
    onHeadersReceived: (): void => {},
  }
  cookies = {
    get: (): Promise<unknown[]> => Promise.resolve([]),
    set: (): Promise<void> => Promise.resolve(),
    remove: (): Promise<void> => Promise.resolve(),
  }
  protocol = {
    handle: (): void => {},
    registerFileProtocol: (): boolean => false,
    unhandle: (): void => {},
  }
  setPermissionRequestHandler(): void {}
  setPermissionCheckHandler(): void {}
  setDevicePermissionHandler(): void {}
  setDisplayMediaRequestHandler(): void {}
  setUserAgent(): void {}
  getUserAgent(): string {
    return 'copse-sidecar'
  }
  clearStorageData(): Promise<void> {
    return Promise.resolve()
  }
  clearCache(): Promise<void> {
    return Promise.resolve()
  }
  setSpellCheckerEnabled(): void {}
}

const defaultSessionShim = new SessionShim()
const sessionsByPartition = new Map<string, SessionShim>()

export const session = {
  defaultSession: defaultSessionShim,
  fromPartition(partition: string): SessionShim {
    let existing = sessionsByPartition.get(partition)
    if (!existing) {
      existing = new SessionShim()
      sessionsByPartition.set(partition, existing)
    }
    return existing
  },
}

class WebContentsModule {
  private createdCallbacks: Array<(wc: WebContentsShim) => void> = []
  emitCreated(wc: WebContentsShim): void {
    // Deferred a tick: WebContentsShim construction happens inside the
    // BrowserWindow constructor, before the caller can have attached
    // 'web-contents-created' — matching Electron's async emit.
    setImmediate(() => {
      app.emit('web-contents-created', new ShimEvent(), wc)
      for (const cb of this.createdCallbacks) cb(wc)
    })
  }
  fromId(id: number): WebContentsShim | undefined {
    for (const wc of allWebContents) if (wc.id === id) return wc
    return undefined
  }
  getAllWebContents(): WebContentsShim[] {
    return [...allWebContents]
  }
}

export const webContents = new WebContentsModule()

export const clipboard = {
  writeText: (_text: string): void => {},
  readText: (): string => '',
  writeImage: (): void => {},
}

export const contextBridge = {
  exposeInMainWorld: (): void => {
    throw new Error('contextBridge is renderer-side; the sidecar must never reach it')
  },
}

export const ipcRenderer = null

export default {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  MenuItem,
  Notification,
  safeStorage,
  nativeTheme,
  nativeImage,
  globalShortcut,
  screen,
  session,
  webContents,
  clipboard,
}

// Referenced by isShellAttached-aware logging paths and useful for smoke tests.
export const shimInfo = { isShellAttached }
