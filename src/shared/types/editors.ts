// External editors the app can hand the workspace off to ("Open in …").

/** One installed editor as surfaced to the renderer dropdown. */
export interface ExternalEditor {
  id: string
  /** Display name, e.g. "Visual Studio Code". */
  name: string
}

/** Result of `editors:list`: installed editors plus the sticky default. */
export interface ExternalEditorList {
  editors: ExternalEditor[]
  /** Editor last launched from this app, when it is still installed. */
  lastUsedId: string | null
}
