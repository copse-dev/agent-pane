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
buffers are cleared where practical. Lock restarts the application to clear
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
- Unlock with Touch ID and system password, cancel, restart and reboot.
- Lock during pending authentication and active authenticated work; sleep and
  screen-lock events must clear access; removing the profile volume must quit.
- Rebuild ad-hoc Electron repeatedly and update the signed helper; neither may
  require a new profile data key. Check packaged signing/notarization and each CPU.
- Restore copied files on a replacement Mac using the saved key, restart and
  unlock without re-entering recovery. Wrong keys must preserve the old manifest.
- Exercise an untrusted caller, wrong profile, malformed envelope and interrupted
  migration. Never capture recovery values in screenshots or test logs.

These interactive acceptance checks are pending. The user requested no more
fingerprint/password prompts during the unattended implementation session.

## Automated evidence (2026-09-11)

- Full unit suite: 9,162 passed, 7 skipped, no failures. A final focused run
  including the added Apple requirement-parser checks passed all 26 vault and
  environment-cleanup tests.
- Typecheck, ESLint, formatting, dead-code guard and the application build passed.
- Test-selection guard: 256 specs live and 15 invariants passed; e2e syntax parsed
  all 283 files. The remaining `check` gates passed as individual commands after
  correcting the lint findings in the initial combined run.
- Browser eval: setup/acknowledged skip, locked/error and verified backup states
  passed all three tests. Screenshots were inspected and checkbox spacing corrected.
- Electron eval: real unavailable-helper main/preload IPC passed. Its screenshot
  is restricted to the encryption fieldset; no recovery material is captured.
- The real signed helper passed its private-channel `status` operation with the
  final disk/live signature requirements. This operation cannot prompt or access
  Keychain items. No authentication was requested after the user's cutoff.
