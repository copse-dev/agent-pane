// Dialect adapter registry (decision 8) — source path already resolved to a
// `HookDialect`; this maps that dialect to its concrete {@link DialectAdapter}.
//
// The Copse dialect (`.copse/hooks.json`) lands in F1; until then it has no
// adapter and the runner abstains for it (never a hard failure).
import type { HookDialect } from '@copse/agent/hooks/command-executor.ts'
import type { DialectAdapter } from './dialect-adapter.ts'
import { cursorAdapter } from './cursor-adapter.ts'
import { claudeAdapter } from './claude-adapter.ts'

const ADAPTERS: Partial<Record<HookDialect, DialectAdapter>> = {
  cursor: cursorAdapter,
  claude: claudeAdapter,
}

/** The adapter for a dialect, or undefined when none is wired yet (e.g. copse). */
export function getDialectAdapter(dialect: HookDialect): DialectAdapter | undefined {
  return ADAPTERS[dialect]
}
