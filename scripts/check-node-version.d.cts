// Declarations for check-node-version.cjs, which stays plain CommonJS because it
// runs as `preinstall` on Node releases that may be too old for TypeScript.

export interface NativeAddonRefusal {
  /** The addon dlopen refused, or null when the code signature was the evidence. */
  addon: string | null
  evidence: string
}

export interface NativeAddonProbe {
  platform: NodeJS.Platform
  execPath: string
  addons: readonly string[]
  exists: (path: string) => boolean
  dlopen: (path: string) => void
  /** `codesign` output for execPath, or null when it could not be read. */
  codesign: (execPath: string) => string | null
}

export interface NativeAddonRefusalReport {
  execPath: string
  pathEntry: string | null
  refusal: NativeAddonRefusal
}

export declare function isSupportedVersion(version: string): boolean
export declare function libraryValidationRefusal(error: unknown): string | null
export declare function codesignRefusal(output: string): string | null
export declare function diagnoseNativeAddonLoading(
  probe: NativeAddonProbe,
): NativeAddonRefusal | null
export declare function pathEntryProviding(
  execPath: string,
  pathValue: string,
  realpath: (path: string) => string,
): string | null
export declare function nativeAddonRefusalMessage(report: NativeAddonRefusalReport): string
