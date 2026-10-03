# Machines settings and native remote model routing

## Task brief — 2026-10-01

Extend the real Electron client: Settings → Machines contains existing SSH management alongside
paired Copse machines. A host explicitly shares selected existing local System One profiles;
a client pairs without SSH, selects a shared model, saves a classifier connection, and routes
normal classifier calls through encrypted pinned TLS. Pairing and host identity survive restart.
Status recovers when the host returns; failed inference calls are never silently replayed.
Host sharing is opt-in, selected-interface only, and revocable per client. Keys/tokens stay in
OS-encrypted profile storage and out of generic renderer settings reads. Remote peers cannot
submit tasks, choose arbitrary URLs, change permissions, or invoke shell/workspace APIs.

Base: 3612660294e1d25dc01329a46cc54bef40e61bd6 on codex/remote-runtime-prototype. The implementation
uses an isolated worktree; the original checkout and PR #3352 remain untouched. The standalone
prototype is retained locally in the ignored preparation backup and excluded from this PR.
Use the full desktop app as host for this version; standalone packaging and internet relay remain
follow-ups. No native-model installation or changes to shell approval policy are included.

Acceptance: existing SSH controls work under Machines; invalid invitations fail; pairing adds a
saved machine with model choices; normal Test classifier sends the typed request to its host;
status and a fresh call recover after a host restart; removing a client revokes access; disabling
sharing closes the listener; plaintext secret storage is refused. Validate the actual host and
client service over local TLS with fixture inference, plus focused Electron Settings/IPC evidence
and screenshots, existing classifier/SSH tests, build, oracle, and full pnpm run check. Physical
two-machine validation remains a separate acceptance gap until a second machine is available.

## Draft PR acceptance — 2026-10-01

Add an off-by-default Remote System One models switch under Experimental. Existing SSH controls
remain in Machines regardless of this switch. When off, pairing, discovery, inference and host
listening are blocked in the main process, including startup restoration and queued operations.
Disabling it stops active networking immediately while retaining encrypted pairing records;
disconnect and revoke remain available. Re-enabling restores opted-in sharing. Cover default-off,
live disable, restart and cleanup through focused unit and Electron tests, then run the full gate.
Rebase onto current main and open a draft PR containing only the production integration.

## Implemented client flow

1. On both computers, enable **Settings → Experimental → Remote System One models** and save.
2. On the model computer, save a working local native System One connection under
   **Settings → Classifiers**. No model installer or downloader is added.
3. In **Settings → Machines → Share models from this machine**, select its private IPv4
   network address and the model connections to expose, enable sharing, then apply. Create a
   pairing invitation and transfer it to the client. An invitation expires after ten minutes;
   create a separate invitation for each client.
4. On the client, paste the invitation under **Paired Copse machines**, connect, select a
   shared model, and choose **Use this model**. The saved connection appears in Classifiers;
   **Test classifier** and existing classifier callers route through the paired host. Selecting
   it for safety screening is explicit; pairing does not change that setting or invoke inference.
5. Keep Copse open and the host awake. The client observes reconnection automatically while
   Machines is open, and every new classifier call connects using the persisted credentials.
   A dropped in-flight call fails; it is never replayed. Restarting either app retains pairing.
   Revoke a client from the host or disable sharing to stop access.
6. Turn off the experiment to stop listening, pairing, discovery and remote calls immediately.
   Saved pairings remain encrypted and can still be disconnected or revoked. Restart keeps the
   experiment off; turning it on again restores opted-in sharing and the existing credentials.

SSH workspaces, saved SSH hosts, remote agents and their existing controls share this Machines
section. Existing `ssh` deep links remain compatible. This change leaves their execution and
permission policy intact.

## LAN handshake

The invitation is a versioned payload containing the selected private IPv4 address, port,
host certificate fingerprint and a random 256-bit secret. It is transferred explicitly between
users; this version does not broadcast or automatically discover computers. The client opens TLS,
checks the certificate fingerprint before sending the secret, and submits its persistent profile
identity. The host accepts an unexpired invitation for one client and returns a separate random
credential plus its identity and shared-model catalog. A retry from that same client can recover
a lost pairing response without granting another client access.

Both sides encrypt the durable credentials using their installed secret store. Later requests use
the pinned certificate and client credential; revocation removes that credential on the host.
The app API protocol advances from v33 to v34 because classifier profiles gain a new machine
connection shape. The LAN invitation itself has its own v1 format.

## Boundaries and remaining scope

The production implementation is in `src/main/services/machines/`, independent of the standalone
browser prototype. Hosts accept only discovery and typed model requests for selected saved local
System One profiles. Remote clients cannot select a URL, launch a process, start an agent, or
control a workspace. Profile edits that cease to be local System One connections remove those
profiles from sharing. Requests, responses, concurrent connections and active calls are bounded.

Pairing pins the host certificate before sending credentials or input. Each client receives its
own revocable token; tokens and the host key use the installed OS-backed cipher. Generic settings
IPC cannot read or write the private machine record. No plaintext fallback is allowed for pairing.
An isolated explicit settings context cannot borrow the desktop's machine credentials. Normal
remote classifier secret redaction and typed result validation still apply.

This first integration uses the full desktop app on both computers and a private IPv4 LAN.
There is no internet relay, automatic discovery, DHCP-address migration, standalone host installer,
headless-task delegation, or workspace/event catch-up in the production service. A changed host
address requires a fresh invitation; a temporary disconnect at the same address recovers
automatically.

## Completion evidence

- **`pnpm run check` passed** after the final experimental gate changes: all static gates and
  **12,116 tests passed, 0 failed, 0 skipped**. The draft PR records the final source SHA.
- `pnpm run build` passed. `pnpm run gen:api-protocol --compare-ref origin/main` passed with
  **v33 → v34**: 12 additive changes and six changed classifier result/profile shapes.
- Focused unit/component run: **40 passed, 0 failed** across Machines, classifier service and
  Settings lifecycle. Coverage includes real pinned HTTPS, typed model results, invitation
  expiry/reuse, encrypted persistence, restart, cancellation, revocation, live experimental
  disable, queued-operation gating and stopping status polling when its view disappears.
- Focused Electron run: **3 specs / 8 tests passed in 66 seconds** (`settings-machines`,
  `settings-ssh`, `settings-classifiers`). The actual app IPC and OS-backed encrypted settings
  talk to a separate production machine service and a fixture native model endpoint. Tests
  cover the default-off gate, pairing, using/sharing a model, preserved probability/confidence,
  restart recovery without replay, live disable on either side, cleanup while disabled,
  re-enabling with saved credentials, and unavailable secret storage.
- Default-off, Experimental, paused, connected, offline, classifier-result, sharing/revocation
  and unavailable-storage screenshots were captured and visually inspected, along with SSH
  settings evidence. Labels and controls are readable with no overlap or clipping.
- `pnpm run oracle -- --explain` requests broad coverage. The broader Electron run before the
  final gate/rebase stopped at **41 passed / 1 failed out of 341 specs**:
  `balanced-acp-default.e2e.ts` timed out selecting Claude for a new chat. That unchanged spec
  then passed alone on both this branch and an isolated base snapshot. The sequence-dependent
  failure remains unexplained; **299 specs were not run**. The broad tier is not green and
  complete CI remains required before merge.
- The base comparison used runtime bundles from a clean source archive with the same
  dependencies. Its final license-report step could not traverse borrowed dependency links,
  so this comparison is runtime evidence, not a successful base packaging build.
- Physical two-machine LAN, a real installed model, Windows/Linux desktop and packaging are
  unverified. No independent review has been performed.

Durable command logs and broad-failure artifacts are in `.tmp/machines-validation/` (ignored).
The final draft preparation logs use the `machines-pr-` prefix; the earlier broad run is
`machines-e2e-broad-fixed.log`. The focused desktop command was:

```sh
pnpm run test:e2e -- --spec tests/e2e/settings-machines.e2e.ts \
  --spec tests/e2e/settings-ssh.e2e.ts --spec tests/e2e/settings-classifiers.e2e.ts
```

Validation used Node 24.20.0, pnpm 10.34.5 and the existing matching ChromeDriver through
`COPSE_E2E_CHROMEDRIVER_BINARY`; no shared Node/Corepack configuration was changed.
