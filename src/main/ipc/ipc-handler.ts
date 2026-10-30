import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import { IpcValidationError, assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'

/**
 * Who may invoke a handler. `'main-frame'` (the default) runs
 * `assertMainFrameSender` before anything else. `'any'` is only for the few
 * channels that were registered without a sender guard; spelling it out keeps
 * each one a visible exception.
 */
export interface IpcHandlerOptions {
  readonly sender?: 'main-frame' | 'any'
}

type SenderCheck<E> = (event: E) => void

/** One schema per positional argument; a rest element would change which arguments are read. */
type PositionalArgs<T extends readonly z.ZodType[]> = z.ZodTuple<T, null>

/** The check a handler runs on its sender before reading any argument. */
export function senderCheck(
  win: Pick<BrowserWindow, 'isDestroyed' | 'webContents'>,
  options: IpcHandlerOptions = {},
): SenderCheck<Pick<IpcMainInvokeEvent, 'senderFrame'>> {
  if (options.sender === 'any') return () => undefined
  return (event) => {
    assertMainFrameSender(event, win)
  }
}

/**
 * Parse positional arguments exactly as a hand-written handler declaring one
 * parameter per argument does:
 *
 * - Only the first `items.length` arguments are read. A missing one is
 *   `undefined`, and extra ones are ignored, as they are by a fixed parameter list.
 * - One argument is parsed on its own (`parseIpcArgs(schema, [raw])`), so its
 *   validation error has no tuple index in the path.
 * - Two or more are parsed as the tuple (`parseIpcArgs(z.tuple(...), [a, b])`),
 *   so the error lists every failing position, as before.
 */
export function parsePositionalIpcArgs<T extends readonly z.ZodType[]>(
  args: PositionalArgs<T>,
  rawArgs: readonly unknown[],
): z.output<PositionalArgs<T>> {
  const items: readonly z.ZodType[] = args.def.items
  const positional = items.map((_, index) => rawArgs[index])
  const parsed = args.safeParse(positional)
  if (parsed.success) return parsed.data
  const [only] = items
  // Rethrows with the single-argument wording; the tuple's error is the fallback.
  if (items.length === 1 && only) parseIpcArgs(only, positional)
  throw new IpcValidationError(parsed.error.message)
}

/**
 * The listener for a handler whose arguments are positional. It checks the
 * sender, then calls `fn` with the parsed arguments, typed from `args`.
 */
export function positionalIpcHandler<E, T extends readonly z.ZodType[], R>(
  checkSender: SenderCheck<E>,
  args: PositionalArgs<T>,
  fn: (...parsed: z.output<PositionalArgs<T>>) => R,
): (event: E, ...rawArgs: unknown[]) => R {
  return (event, ...rawArgs) => {
    checkSender(event)
    return fn(...parsePositionalIpcArgs(args, rawArgs))
  }
}

/**
 * The listener for a handler that validates its whole argument list with
 * `parseIpcArgs(schema, rawArgs)`. That keeps `parseIpcArgs`'s unwrap: a single
 * argument is parsed on its own, so a tuple schema also accepts the tuple sent
 * as one array, and rejects extra arguments.
 */
export function argumentListIpcHandler<E, S extends z.ZodType, R>(
  checkSender: SenderCheck<E>,
  schema: S,
  fn: (parsed: z.output<S>) => R,
): (event: E, ...rawArgs: unknown[]) => R {
  return (event, ...rawArgs) => {
    checkSender(event)
    return fn(parseIpcArgs(schema, rawArgs))
  }
}
