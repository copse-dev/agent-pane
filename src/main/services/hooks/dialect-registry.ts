// Dialect adapter registry (decision 8) — source path already resolved to a
// `HookDialect`; this maps that dialect to its concrete {@link DialectAdapter}.
//
// The Copse dialect (`.copse/hooks.json`) is Copse's **native** hook format,
// wired in F1 (`copse-adapter.ts`).
import type { HookDialect } from '@copse/agent/hooks/command-executor.ts'
import type { DialectAdapter } from './dialect-adapter.ts'
import { cursorAdapter } from './cursor-adapter.ts'
import { claudeAdapter } from './claude-adapter.ts'
import { copseAdapter } from './copse-adapter.ts'

const ADAPTERS: Partial<Record<HookDialect, DialectAdapter>> = {
  cursor: cursorAdapter,
  claude: claudeAdapter,
  copse: copseAdapter,
}

/** The adapter for a dialect, or undefined when none is wired yet. */
export function getDialectAdapter(dialect: HookDialect): DialectAdapter | undefined {
  return ADAPTERS[dialect]
}
