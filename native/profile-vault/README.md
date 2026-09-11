# Copse saved-secret vault helper

The helper protects the profile data key with a Secure Enclave P-256 key using
Apple CryptoKit HPKE (`P256_SHA256_AES_GCM_256`). It stores CryptoKit's opaque,
hardware-encrypted key representation in a login Keychain generic-password item
(`Copse Device Vault`, account = device-key UUID). The private scalar remains
non-exportable. `.privateKeyUsage` and `.userPresence` gate the real operation.

The main process and helper exchange one bounded request over inherited socket
fd 3. Main verifies the pinned Developer ID and live helper signature before
sending. The helper validates the socket peer's kernel audit token and live code,
then asks for native, per-request approval of the caller and profile. No plaintext
key travels through renderer IPC, command-line arguments, environment or logs.
Recovery reveal and import stay in native UI. Clipboard copying is manual and
may be retained by password managers, clipboard history or synchronization.

JavaScript and Swift immutable strings are not guaranteed to be erased. Mutable
buffers are cleared where practical. Quitting the application clears
managed credential consumers. This does not revoke tokens already supplied to
external processes or protect a compromised, already authorized application.

## Build

On a supported Mac with Xcode command-line tools and the product signing identity:

```sh
pnpm run prepare:vault --identity 'Developer ID Application: Jonathan Kingston (VRQQV62MK3)'
pnpm run build
```

Preparation compiles and independently signs the helper under `dev.copse.vault`,
with hardened runtime and no Electron entitlements. Artifacts stay in ignored
`dist/`; no signing key is committed. Ordinary builds copy the existing helper
without resigning Electron. `build.json` binds the binary to the source revision.
Packaging keeps the helper outside app.asar and preserves its original signature.
Absent helpers disable setup; macOS release builds require preparation.
The current build prepares the host architecture. Prepare the matching artifact
for each release architecture; cross-architecture delivery remains a release check.

## Validation

`pnpm test profile-vault` runs synthetic crypto, migration, crash-replay, ownership,
session and application service tests. Browser scenarios cover settings states;
`tests/e2e/settings-profile-vault.e2e.ts` checks the real unavailable-helper IPC
path without authentication.

`pnpm run prepare:vault --identity '<identity>' --authenticate` also runs a
synthetic persistent-key probe. **This intentionally requests macOS authentication.**
It uses a throwaway Keychain item and removes it after the fresh-process unwrap.
A signed persistent HPKE round trip passed on the development Mac on 2026-09-11.
The permanent Security-framework alternative failed with missing entitlement;
that mechanism is not used in the implementation.

Before release, use a throwaway Copse profile and synthetic credentials to verify:

- Enable with verified backup and with acknowledged skip; cancel each native step.
- Cold launch automatically requests Touch ID/system authentication once. Cancel
  and confirm the app opens locked without retrying; explicit Unlock can retry.
  Verify ordinary restart and reboot require fresh authentication.
- Quit during pending authentication and active authenticated work; quit must clear
  access and the next launch must request authentication. Sleep and screen lock
  must retain an unlocked session without restarting or prompting; profile-volume
  loss must quit.
- Rebuild ad-hoc Electron repeatedly and update the signed helper; neither may
  require a new profile data key. Check packaged signing/notarization and each CPU.
- Restore copied files on a replacement Mac using the saved key, restart and
  unlock without re-entering recovery. Wrong keys must preserve the old manifest.
- Exercise an untrusted caller, wrong profile, malformed envelope and interrupted
  migration. Never capture recovery values in screenshots or test logs.

These interactive acceptance checks are pending. The user requested no more
fingerprint/password prompts during the unattended implementation session.

## Automated evidence (2026-09-11)

- The final implementation passed the full `pnpm run check` pre-commit gate
  (9,206 tests passed, 7 skipped, no failures). The oracle guard validated
  258 live specs and 15 invariants; e2e syntax checked 285 files.
- The session-policy follow-up passed 27 focused vault tests, including automatic
  startup, cancellation without automatic retry and quit
  cleanup. Both application and demo builds passed after rebasing onto current main.
- Browser eval: setup/acknowledged skip, locked/error and verified backup states
  passed all three tests. Updated policy copy and screenshots were inspected.
- Electron eval: both real unavailable-helper main/preload IPC and encrypted-profile
  startup with unavailable authentication passed. Screenshots are restricted to
  the encryption fieldset; no recovery material is captured.
- The real signed helper passed its private-channel `status` operation with the
  final disk/live signature requirements. This operation cannot prompt or access
  Keychain items. No authentication was requested after the user's cutoff.
