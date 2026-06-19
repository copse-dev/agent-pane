// Dev-only: the macOS app-menu name (bold item next to the Apple logo) comes
// from the running .app bundle's CFBundleName, NOT app.setName(). When running
// unpackaged via `electron .`, that bundle is node_modules/electron's
// Electron.app, so the menu shows "Electron". This patches its Info.plist to
// "Agent Pane". A real packaged build (electron-builder/forge with
// productName) makes this unnecessary.
//
// Runs on postinstall so it survives `npm install`. Does NOT touch
// CFBundleExecutable (the binary must stay named "Electron").
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const PLIST = 'node_modules/electron/dist/Electron.app/Contents/Info.plist'
const DISPLAY_NAME = 'Agent Pane'

if (!existsSync(PLIST)) {
  console.log('[patch-dev-name] Electron.app not found, skipping')
  process.exit(0)
}

for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  try {
    execFileSync('plutil', ['-replace', key, '-string', DISPLAY_NAME, PLIST])
  } catch (err) {
    console.warn(`[patch-dev-name] could not set ${key}:`, (err as Error).message)
  }
}
console.log(`[patch-dev-name] set Electron.app menu name to "${DISPLAY_NAME}"`)
