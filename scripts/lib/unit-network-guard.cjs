'use strict'

/**
 * Unit-test preload for the outbound network guard
 * (docs/testing-strategy.md#outbound-network-guard). Installed through
 * NODE_OPTIONS by scripts/run-tests.mts so every test process, and every Node
 * process a test spawns, records or refuses egress past loopback.
 */
const mode = process.env.COPSE_UNIT_NETWORK_GUARD
const ledgerPath = process.env.COPSE_UNIT_NETWORK_LEDGER
if ((mode === 'log' || mode === 'enforce') && ledgerPath) {
  require('../../tests/e2e/electron-shell/network-guard.cjs').install({
    mode,
    ledgerPath,
    processLabel: `node ${process.argv.slice(1).join(' ').slice(0, 240)}`,
  })
}
