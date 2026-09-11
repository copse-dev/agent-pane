import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses'

/** Apply before signing the macOS app that the vault accepts for silent access. */
export async function hardenVaultCaller(path: string): Promise<void> {
  await flipFuses(path, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  })
}
