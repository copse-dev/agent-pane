import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'

/**
 * Tell every open window (the main window and any pane pop-out) that a
 * Roadmap item changed — a complexity/category/title stamp landing after the
 * note that triggered it has already returned to its caller (the save itself
 * is immediate), so panes re-read the list instead of polling: the
 * complexity and category stamps (roadmap-complexity.ts / roadmap-category.ts)
 * and the AI-generated title stamp (roadmap-title.ts, issue #2472).
 *
 * Goes through the shared window-broadcast registry
 * (windows/app-window-broadcast.ts) rather than Electron's `BrowserWindow`
 * directly, so this stays importable from services/tools code that must not
 * take a runtime dependency on the desktop shell (see the Electron boundary
 * in eslint.config.mjs) — the agent's `roadmap_plan` tool
 * (tools/roadmap-tools.ts) reports its own background stamps through it too.
 */
export function notifyRoadmapChanged(): void {
  broadcastToAppWindows('roadmap:changed')
}
