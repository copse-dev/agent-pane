import { app } from 'electron'
import { join } from 'node:path'

// MUST be imported before any module that constructs electron-store (storage.ts,
// settings.ts), because electron-store resolves its file path from
// app.getPath('userData') at construction time. ESM evaluates imports in source
// order, so keeping this as the first import in main/index.ts guarantees the
// name/path are set before those stores are built.
//
// Without this, an unpackaged `electron .` run stores data under an "Electron"
// directory and presents itself as "Electron" in the menu/About panel.
app.setName('agent-pane')
app.setPath('userData', join(app.getPath('appData'), 'agent-pane'))
