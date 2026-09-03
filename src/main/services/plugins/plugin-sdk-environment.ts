/**
 * Binds `@copse/plugin-sdk` to this app: reviewed plugin runtime snapshots live
 * under the same profile root (`copseDataRoot`) as every other byte of Copse
 * state, so `COPSE_DIR` relocates them with the rest. Imported for its side
 * effect by the app-side re-exports of the package's host-side modules.
 */
import { configurePluginSdk } from '@copse/plugin-sdk/environment.ts'
import { copseDataRoot } from '../storage/copse-paths.ts'

configurePluginSdk({ dataRoot: () => copseDataRoot() })
