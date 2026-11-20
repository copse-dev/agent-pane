/** A browser partition may receive a preview credential only after stale workers are removed. */
export async function grantPreviewSessionAccess(
  grants: Map<string, string>,
  origin: string,
  capability: string,
  clearServiceWorkers: () => Promise<void>,
): Promise<void> {
  if (grants.get(origin) === capability) return
  await clearServiceWorkers()
  grants.set(origin, capability)
}
