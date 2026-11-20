# One Machines model: SSH as the spine between computers

**Status: Active.** This plan is the design; each slice below ships as its own pull request
and records its evidence there. Nothing here changes a default, a permission rule or a
persisted format on its own.

Copse has five features for working with another computer. Each works. Together they ask
the user to set up the same machine up to three times, behind five switches, through three
unrelated kinds of connection. This plan does not add a sixth feature. It picks one
connection for one job, shows each machine once, and removes the setup steps that only
exist because the features were built separately.

## Task brief — 2026-11-20

- **User problem.** "We have lots of multi-machine features but they seem a little
  cumbersome." The goal is the most seamless multi-machine access reachable without large
  changes.
- **Acceptance, in outline.** A user with a working `ssh host` reaches an agent thread on
  that host without typing the host's details again, without visiting Settings first, and
  without starting the folder browser at `/`. A dropped connection is shown as dropped.
  Settings shows each machine once. A paired machine's models work through the same SSH
  connection, off the home network, with no address to choose. Each slice lists its own
  observable acceptance below.
- **Scope.** Renderer flows for SSH hosts, the Settings → Machines page, the SSH connection
  manager's status, and the paired-machine client transport.
- **Exclusions.** Phone access and its relay, device independence (the same threads on
  every machine, or a run that survives a closed lid), defaults for experimental switches,
  and remembered approvals for remote terminals. Each has an owner named under
  [Relationship to existing plans](#relationship-to-existing-plans).
- **Base.** `main` at `94885c85e`.
- **Risk.** Slices M1a–M1e and M2 are presentation and connection-status changes. M1e moves
  where consent to an experimental feature is given, so it is reviewed as a permissions
  change. M3 changes how a paired machine is reached and adds a main-only setting; it takes
  the full check and an independent review.
- **Validation.** Every visible slice adds a focused WebdriverIO spec with a reviewed
  screenshot. Connection and transport slices add unit tests against `FakeSshTransport` and
  the real pinned-TLS machine service. Required broader gates are named per slice.

## What the user meets today

| The user wants to…                         | Feature          | How it connects                     | Setup today                                                          |
| ------------------------------------------ | ---------------- | ----------------------------------- | -------------------------------------------------------------------- |
| Work on code that lives on another machine | SSH workspace    | The system `ssh`, one shared master | A switch, a host form, then browse down from `/`                     |
| Run a vendor agent on that machine         | Agents over SSH  | The same connection                 | A second switch; install and sign in on the host                     |
| See its screen                             | Desktop pane     | An SSH forward, or VNC directly     | A third switch and its own host form                                 |
| Use its local models                       | Paired machines  | Its own listener, port 4319         | A switch on both sides, an address to choose, an invitation to paste |
| Reach this Copse from a phone or browser   | Mobile Companion | Its own listener, port 42773        | A switch, a six-digit code, then a certificate or an invite code     |

Measured on `main` at the base revision:

- **Five switches in two places.** `sshWorkspaceEnabled` and `acpOverSshEnabled` sit under
  Settings → Machines; `remoteSystemOneModelsEnabled`, `vncEnabled` and the Mobile Companion
  sit under Settings → Experimental. `sshWorkspaceEnabled` is also a hidden prerequisite for
  adding an SSH machine in the Desktop pane (`src/renderer/views/vnc-ssh-host-form.ts`), and
  thirteen source files read it.
- **Three host forms for one record.** Settings
  (`src/renderer/views/setup/ssh-workspace-section.ts`), the open-remote dialog
  (`src/renderer/views/remote-folder-dialog.ts`) and the Desktop pane
  (`src/renderer/views/vnc-ssh-host-form.ts`) each build their own form for an
  `SshWorkspaceHost`. Two of them cannot set agent forwarding. All three fill the Id from
  the label (`slugifyHostId`) until the user edits it, but nothing makes it unique. The
  Desktop pane refuses an Id that is taken. Settings and the open-remote dialog save
  through `upsertHost`, so a second host with the same label silently replaces the first.
- **`~/.ssh/config` is parsed but never offered.** `ssh-config.ts` reads it, `Include`
  globs and all. The user must press Import, which saves every alias at once.
- **The folder browser opens at `/`** on every open. `remote-folder-dialog.ts` has four
  `browse('/')` calls: on opening, after saving a host, after importing hosts, and on
  choosing another host.
- **Nothing watches the connection.** `SshConnectionManager` changes a host's status only
  inside `connect`, `disconnect` and `reconnect`
  (`src/main/services/ssh-workspace/connection-manager.ts`). After a drop the window still
  says connected.
- **One machine, three unconnected lists.** `sshWorkspaceHosts`, the paired machines inside
  `machineConnections`, and `trustedSshHosts`.
- **Two listeners that only work at home.** The Mobile Companion binds RFC 1918 addresses
  only (`isRfc1918` in `src/main/services/mobile/mobile-server.ts`), and paired machines
  accept RFC 1918 or loopback only (`machineAddressSchema` in `src/shared/machines.ts`). A
  paired machine whose address changes needs a new invitation.
- **A banner that is out of date.** Every connected SSH workspace warns that "remote file
  watching is not yet supported" (`src/renderer/views/ssh-status-banner.ts`), although a
  native watcher and a polling fallback both ship.

## Two directions, and which one this plan settles

The features fall into two families, and the confusion comes from treating them as one.

**Reaching out.** This Copse works on another machine: its files, shell, agents and screen.
All of it already travels over one OpenSSH master per host
(`src/main/services/ssh-workspace/openssh-transport.ts`). There is no listener, no pairing
and no identity of Copse's own. The user's `~/.ssh/config`, `known_hosts` and agent decide
who may connect, so it already crosses networks through whatever that configuration does: a
VPN, an overlay network, a jump host.

**Reaching in.** Another device opens a connection to a listener this Copse runs: the
Mobile Companion and paired machines. Each has its own pairing, identity, certificate, port
and address rule, and each is limited to the local network.

A desktop that can run `ssh host` has no need of the second family to reach that host. So
this plan makes reaching out the one way a desktop Copse reaches another computer, and
leaves reaching in to the device that cannot use SSH: the phone.

## What already exists (don't rebuild it)

| Piece                                        | Where                                                               | What it gives this plan                                                         |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| One multiplexed master per host              | `ssh-workspace/openssh-transport.ts`                                | A live control socket that commands and forwards attach to for free             |
| Loopback-to-loopback forwards on that master | `ssh-workspace/ssh-forward.ts`, `SshTransport.openForward`          | A private path to any loopback port on the host; the Desktop pane uses it today |
| A liveness probe                             | `ssh -O check` in `OpenSshTransport.connect`                        | The check M1a repeats on a timer                                                |
| An ssh-config reader                         | `ssh-workspace/ssh-config.ts`, `api.sshWorkspace.listConfigAliases` | The host list M1d offers directly                                               |
| Alias-only host records                      | `hostFromSshConfigAlias` in `ssh-workspace/hosts.ts`                | A saved host that leaves user, port, key and proxy to OpenSSH                   |
| Host draft parsing and validation            | `src/renderer/views/setup/ssh-host-helpers.ts`                      | One parser all three forms already share; only the markup is tripled            |
| A loopback choice for model sharing          | `MachineManager.snapshot`, default `127.0.0.1:4319`                 | The host side of M3 with no change                                              |
| Pinned-certificate, token-bearing requests   | `machines/machine-transport.ts`                                     | Authentication M3 keeps exactly as it is                                        |
| A fake transport and a stub `ssh` on `PATH`  | `ssh-workspace/fake-ssh-transport.ts`, `openssh-transport.test.ts`  | The test doubles every slice here uses; no spec needs a real `sshd`             |

## Binding decisions

1. **SSH is how a desktop Copse reaches another computer.** A new desktop-to-machine
   capability attaches to the host's existing master, as a command or a forward. It does not
   open a listener, invent a pairing step or mint an identity for anything a saved SSH host
   can already carry. This restates decision 5 of
   [`cross-device-harness-offload.md`](cross-device-harness-offload.md) as a rule for every
   feature, not only the worker.

2. **A machine is shown once.** Settings → Machines lists one row per machine and says what
   that machine can do: files and shell, agents, screen, models. The row is a view joined
   over the existing stores. No store is migrated or merged, so an older build reads the
   same settings.

3. **Copse does not copy `~/.ssh/config`; it offers it.** Aliases appear in the pickers
   beside saved hosts. Choosing one saves that alias alone, in the alias-only form
   `hostFromSshConfigAlias` already writes, so OpenSSH keeps applying the whole stanza.
   Pattern entries stay excluded as they are today.

4. **Consent is asked where the feature is first used, once.** The main process keeps
   enforcing `sshWorkspaceEnabled` exactly as now. What changes is that the open-remote
   dialog and the Desktop pane can turn it on, after saying what it means, instead of
   sending the user to Settings and back. Whether the switch should exist at all is left
   to the owner under M4. [`default-on-readiness.md`](default-on-readiness.md) audits
   experimental plugins and switches and has no row for it.

5. **Connection state is observed, never assumed.** A host shown as connected has answered
   a probe recently. A failed probe makes one reconnect attempt that cannot raise a prompt;
   if that fails the status says so and the existing banner offers Reconnect. A prompt never
   appears because a timer fired.

6. **Being able to SSH to a machine does not grant its models.** M3 moves the bytes onto
   the SSH forward and keeps the invitation, the per-client token and the pinned certificate
   unchanged. Whether SSH access as the same account should be allowed to stand in for the
   invitation is an open decision (M4), because it turns "can log in" into "may spend this
   machine's compute".

7. **One form writes a host.** The three host forms become one component with the same
   fields in each place. The Id is derived from the label, made unique among the saved
   hosts and shown read-only. A second host with the same label can then no longer replace
   the first.

8. **No address is typed that Copse can work out.** A machine reached through a saved SSH
   host has no IP to choose and nothing to re-pair when its address changes.

## Slices

Each slice is one pull request, except M1c and M1d, which change the same three forms and
shipped together. They form one stack, each PR based on the one before, because each new
Electron spec reuses the stub `ssh` fixture the first one added. That fixture
(`tests/e2e/fixtures/fake-ssh/`) is the app's own `ssh` binary replaced on `PATH`: it runs
remote commands in a local scratch directory and performs real loopback forwards, so no
spec needs an `sshd` and the product gains no test-only option.

| Slice     | Pull request                                      |
| --------- | ------------------------------------------------- |
| M1a       | https://github.com/copse-dev/agent-pane/pull/4403 |
| M1b       | https://github.com/copse-dev/agent-pane/pull/4405 |
| M1c + M1d | https://github.com/copse-dev/agent-pane/pull/4412 |
| M1e       | https://github.com/copse-dev/agent-pane/pull/4416 |
| M2        | https://github.com/copse-dev/agent-pane/pull/4418 |
| M3        | https://github.com/copse-dev/agent-pane/pull/4419 |

### M1a — The connection status is true

- A connected host is probed with `ssh -O check` on a timer and after a command fails at
  the transport. When the master is gone the host's state stops reading connected.
- One reconnect is attempted in batch mode, so it succeeds silently with an agent or an
  unencrypted key and otherwise fails without a prompt.
- The banner's watching warning appears only when the host has neither the native watcher
  nor polling. The comment in `ssh-status-banner.ts` that says "no remote watcher exists
  yet" is corrected with it.

_Acceptance:_ with a `FakeSshTransport` that stops answering, the manager emits a
not-connected state and the banner shows Reconnect; with one that recovers, the state
returns to connected with no prompt raised. A connected host with a working watcher shows
no watching warning.

### M1b — The folder browser starts where the user works

- The dialog opens in the remote home directory.
- If the host already has projects, it opens in the parent of the most recently added one.
  This reads the project list; nothing new is stored.
- `/` remains reachable through the breadcrumbs, and is the fallback when the home
  directory cannot be read.

_Acceptance:_ a first open on a host lists the home directory; after a project at
`/srv/app/api` exists on that host, the next open lists `/srv/app`.

### M1c — One host form

- A single form component serves Settings, the open-remote dialog and the Desktop pane,
  with the same fields, including agent forwarding.
- The Id is derived from the label, de-duplicated, and read-only.

_Acceptance:_ the three surfaces render the same fields; a host saved from any of them
round-trips every field; existing saved hosts are unchanged. A second host saved with an
existing host's label gets its own Id and leaves the first unchanged.

### M1d — `~/.ssh/config` hosts are offered directly

- The host pickers in the open-remote dialog and the Desktop pane list saved hosts, then a
  group of ssh-config aliases that are not saved yet.
- Choosing an alias saves that alias alone and connects.
- Settings keeps "Import from ~/.ssh/config" for adding them all.

_Acceptance:_ with two aliases in a fixture config and none saved, the picker offers both;
choosing one saves exactly one host and lists its home directory.

### M1e — Turn it on where it is used

- "Open remote project" is always in the Projects menu.
- With SSH workspaces off, the dialog explains in two sentences what turning it on does
  (commands run on the remote host, outside the local sandbox, under the usual approvals)
  and offers one button to turn it on and continue. The Desktop pane's host form offers the
  same.
- Every main-process check of `sshWorkspaceEnabled` stays.

_Acceptance:_ from a fresh profile, a user opens a remote project without opening Settings;
declining leaves the setting off and nothing connects. The execution-target and
project-restore guards still refuse while the setting is off.

### M2 — One Machines list

- Settings → Machines opens with one list. A row is a saved SSH host, a paired machine, or
  both when M3 has linked them. It shows the connection status and the capabilities that
  apply: files and shell, agents, screen, models, and whether Guarded YOLO runs `ssh` to it
  without asking.
- That trust is read-only on the row. A row is trusted when its saved `host`, without any
  `user@` and normalised as the shell gate normalises it (`normalizeSshHost`), equals an
  entry in `trustedSshHosts`. An `~/.ssh/config` alias matches by its own name, not its
  `HostName`, because the gate compares the host named on the command line and does not
  read the config. Trust is still changed only under Settings → Permissions, so M2 changes
  no permission surface.
- "Add a machine" opens the M1c form with the M1d picker. Pairing with an invitation and
  sharing this machine's models keep their own controls below the list.
- The SSH options (the switch, host key policy, agents on the remote machine) move into one
  options group under the list.

_Acceptance:_ a profile with one SSH host that is also trusted and one paired machine shows
two rows with the right capabilities; every action that exists today (edit, forget
authentication, remove, disconnect a paired machine) is reachable from its row; settings
written by this build load unchanged in the previous build.

### M3 — A paired machine's models over SSH

- A paired machine can record the saved SSH host it is reached through. Requests to it open
  a forward on that host's master to the machine's loopback port and connect to the local
  end. The certificate pin, the bearer token and the `Host` the listener checks are those of
  the machine, as today.
- The route is stored under its own main-only setting, `machineSshRoutes`, not as a new
  field in `machineConnections`. That record has a strict schema: an older build that met
  an unknown field would read it as invalid, start a fresh machine store and overwrite the
  user's pairings on its next save.
- Pairing over SSH is its own IPC channel, `machines:pair-over-ssh`. An optional second
  argument on `machines:pair` would be a breaking protocol change (a newer window could
  send an argument an older main process rejects); a new channel is additive.
- Pairing beside an invitation offers "Reach it through": this network, or any saved SSH
  host. Only an invitation that shares on loopback can be paired through SSH, because a
  forward reaches only the SSH host's own loopback.
- The sharing side changes only the loopback choice's label and one error message.
  Loopback is already its default; the label, "This computer only", now says what that
  choice is for, and the error points a network-address invitation at it.
- A call that fails because the SSH connection is down reports that, and is never replayed.
  Only pairing and **Test classifier** may open the SSH connection. A status check, and a
  classifier call made for screening or a background question, uses only one that is
  already open, so none of them prompts.

_Acceptance:_ against the real machine service bound to loopback and reached through a
forward, pairing succeeds, **Test classifier** returns the host's typed result, and stopping
the forward's master turns the row to reconnecting with a call failing once. A machine
paired this way keeps working after its host's LAN address changes. A non-loopback
invitation behaves exactly as before.

_Gates:_ full `pnpm run check`; `gen:api-protocol --compare-ref origin/main` must report an
additive change only; independent review before leaving draft.

### M4 — Decisions this plan does not take

These need an owner's decision, not an implementation, and nothing above depends on them.

- **Whether the SSH workspace switch should exist.** M1e moves where `sshWorkspaceEnabled`
  is turned on and keeps every check of it. Removing the switch, or turning it on by
  default, decides whether a saved host may run commands without that consent.
  [`default-on-readiness.md`](default-on-readiness.md) does not cover it, because it audits
  only experimental plugins and switches.
- **Pairing without pasting.** Let the client ask the host for an invitation over SSH. It
  removes the last manual step in M3 and changes who may use a machine's models (decision
  6).
- **Listeners on an overlay network.** Allowing an overlay address (for example the
  `100.64.0.0/10` range) in `isRfc1918` and `machineAddressSchema` would let the Mobile
  Companion work away from home for users who already run such a network. It is a few lines
  and a change to the threat model's scenarios 10 (the listener binds a private address)
  and 11 (the names service publishes only RFC 1918 addresses), so it belongs with
  [`../remote-access.md`](../remote-access.md), beside the relay it would partly replace.

## Security and trust

- **No new listening surface, credential store or identity.** M1 and M2 add none. M3
  removes the need for a LAN-bound listener in the SSH case: the host can share on loopback
  only.
- **The forward is loopback at both ends** (`sshForwardControlArgs`). Its local end is
  reachable by other local processes, as the Desktop pane's is today. That is acceptable
  only because every machine request still needs the pinned certificate and the token; M3
  must not weaken either.
- **M1e does not lower the bar for remote execution.** An SSH workspace is still classified
  as unsandboxed, so ordinary commands prompt ([`../shell-permissions.md`](../shell-permissions.md)).
  The slice changes where the switch is thrown, and the copy beside it must say what it
  enables.
- **M1a must not turn a timer into a prompt.** The reconnect it attempts runs in batch
  mode. Password and passphrase prompts stay tied to something the user did.
- **M1d saves less than Import does.** One alias on an explicit choice, never the whole
  file.

## Test plan

- **Unit.** Connection-manager liveness and reconnect against `FakeSshTransport`; the home
  and last-folder choice as a pure function over the project list; host form draft
  round-trips; the machine transport reaching a real pinned-TLS listener through a fake
  forward; store compatibility for records with and without the SSH link.
- **Electron.** A reachable host in a spec is a stub `ssh` first on the app's `PATH` that
  runs the remote command in a scratch directory: the boundary the app already calls, with
  no test-only option in the product. One focused spec per visible slice, each asserting
  the DOM and saving a screenshot: the reconnect banner, the dialog opening in home, the
  shared form in its three places, the alias group in the picker, the turn-on step, the
  Machines list, and pairing through a host.
- **Unchanged behaviour.** The existing SSH and machines specs (`settings-ssh`,
  `settings-machines`, `ssh-projects-pane`, `ssh-prompt-dialog`, `ssh-titlebar-target`,
  `settings-trusted-ssh-hosts`, `ssh-config-alias-collision`) keep passing, edited only
  where a control they drive has moved.
- **Not covered here.** A real second machine. As with
  [`machines-model-routing.md`](machines-model-routing.md), physical two-machine validation
  stays an open acceptance gap until one is available, and each pull request says so.

## Non-goals

- A remote server component, a daemon on the host, or anything installed there beyond what
  SSH workspaces install today.
- Syncing threads or settings between machines.
- A relay, or any change to the names service.
- Windows as the remote side.
- Changing which commands prompt on a remote host.

## Open questions

- **Should a paired machine without an SSH host keep its LAN path?** This plan keeps it:
  M3 adds a route and removes none. Retiring the LAN listener for desktops is a later
  simplification once M3 has been used on real machines.
- **Where does the Desktop pane's direct VNC target belong in the Machines list?** M2 shows
  SSH-reached screens on the machine's row and leaves direct targets in the Desktop pane.
- **What should the Machines row show for a run the desktop does not own?** That is
  [`mission-control.md`](mission-control.md)'s question, and arrives with the offload plan.

## Relationship to existing plans

- [`ssh-remote-repo.md`](ssh-remote-repo.md) built the stack this plan standardises on. Its
  Phase 6 sketched the open flow that M1b–M1e finish.
- [`acp-over-ssh.md`](acp-over-ssh.md) and [`vnc-remote-desktop.md`](vnc-remote-desktop.md)
  already follow decision 1. M2 gives them a place on the machine's row.
- [`machines-model-routing.md`](machines-model-routing.md) shipped paired machines on a LAN
  listener and listed an internet relay as a follow-up. M3 covers the case where SSH already
  reaches the host, which needs no relay.
- [`mobile-web-experience.md`](mobile-web-experience.md) and
  [`../remote-access.md`](../remote-access.md) own phone access and its relay. This plan
  does not touch them and M4 hands them one question.
- [`cross-device-harness-offload.md`](cross-device-harness-offload.md) owns the two things
  tidying cannot deliver: a run that survives the desktop disconnecting (O1, O2) and, with
  it, the same thread reachable from more than one machine. Its worker channel rides the
  same master, so everything here is on its path.
- [`client-server-split.md`](client-server-split.md) owns the always-detached client those
  need.
- [`copse-cloud-workspaces.md`](copse-cloud-workspaces.md) makes a cloud workspace a
  provisioner plus an SSH-remote workspace (its decision 1), so a provisioned host is one
  more row in M2's list and needs no path of its own.
- [`default-on-readiness.md`](default-on-readiness.md) owns whether any experimental
  switch named here becomes default-on. The SSH workspace switch is under M4.
