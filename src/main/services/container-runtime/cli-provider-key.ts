/**
 * Take the provider key the thread-container CLI was pointed at (`--api-key-env
 * <NAME>`) out of its own environment. The key is held by host inference
 * (decision A1″); left in `process.env`, every engine subprocess the CLI
 * starts would inherit it. Call before the first Docker command.
 * Returns the value, or undefined when no variable was named or it is unset.
 */
export function takeProviderKeyFromEnv(
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!name) return undefined
  const value = env[name]
  Reflect.deleteProperty(env, name)
  return value === '' ? undefined : value
}
