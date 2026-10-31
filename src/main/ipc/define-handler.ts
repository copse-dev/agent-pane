import { ipcMain, type BrowserWindow } from 'electron'
import type { z } from 'zod'
import type apiProtocolManifest from '../../../schemas/api-protocol.manifest.json'
import {
  argumentListIpcHandler,
  positionalIpcHandler,
  senderCheck,
  type IpcHandlerOptions,
  type PositionalArgsOptions,
} from './ipc-handler.ts'

/**
 * Every invoke channel in the committed protocol manifest
 * (`pnpm run gen:api-protocol`), so a mistyped or removed channel fails typecheck
 * here rather than only at the manifest check.
 */
export type InvokeChannel = keyof (typeof apiProtocolManifest)['channels']['invoke']

/**
 * Register an invoke handler with one schema per positional argument:
 *
 * ```ts
 * defineHandler(win, 'decisions:list-thread', z.tuple([zProjectId, zThreadId]), (pid, tid) =>
 *   readThreadDecisionLog(pid, tid),
 * )
 * ```
 *
 * The sender is checked first (unless `{ sender: 'any' }`), then the arguments
 * are parsed as `parsePositionalIpcArgs` describes: extra ones are ignored and
 * the validation error reads as it did when the handler was written by hand.
 * Pass `{ errors: 'per-argument' }` for a handler that parsed each argument on
 * its own, so only the first invalid one is reported.
 */
export function defineHandler<T extends readonly z.ZodType[]>(
  win: BrowserWindow,
  channel: InvokeChannel,
  args: z.ZodTuple<T, null>,
  fn: (...parsed: z.output<z.ZodTuple<T, null>>) => unknown,
  options?: IpcHandlerOptions & PositionalArgsOptions,
): void {
  ipcMain.handle(channel, positionalIpcHandler(senderCheck(win, options), args, fn, options))
}

/**
 * Register an invoke handler that validates its whole argument list as one
 * value, as `parseIpcArgs(schema, rawArgs)` does. Use it only for a handler that
 * already did that: unlike `defineHandler`, it rejects extra arguments and
 * unwraps a single argument.
 */
export function defineArgumentListHandler<S extends z.ZodType>(
  win: BrowserWindow,
  channel: InvokeChannel,
  schema: S,
  fn: (parsed: z.output<S>) => unknown,
  options?: IpcHandlerOptions,
): void {
  ipcMain.handle(channel, argumentListIpcHandler(senderCheck(win, options), schema, fn))
}
