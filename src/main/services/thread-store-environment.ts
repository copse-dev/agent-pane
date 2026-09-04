/**
 * Binds `@copse/thread-store` to this app: the store root comes from the same
 * `copseWorkspaceDir` resolver the sandbox overlay and every other path helper
 * use (so `COPSE_DIR` / `COPSE_WORKSPACE_DIR` move all of them together), the
 * "all projects" readers walk the configured project list rather than whatever
 * directories happen to exist, and store timings land in the app's perf trace.
 * Imported for its side effect by `thread-store.ts`, the app's re-export.
 */
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import { perfCount, perfSpan } from './diagnostics/perf-trace.ts'
import { copseWorkspaceDir } from './storage/copse-paths.ts'
import { storageGet } from './storage/storage.ts'

configureThreadStore({
  workspaceRoot: () => copseWorkspaceDir(),
  listProjectIds: () =>
    recordArrayOrEmpty(storageGet('projects')).flatMap((project) => {
      const id = project['id']
      return typeof id === 'string' && id.length > 0 ? [id] : []
    }),
  perf: { count: perfCount, span: perfSpan },
})
