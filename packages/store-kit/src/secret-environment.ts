/** Tracks only credentials injected by Copse, preserving independently supplied environment. */
export class SecretEnvironment {
  readonly #environment: NodeJS.ProcessEnv
  readonly #injected = new Map<string, { previous: string | undefined; value: string }>()
  constructor(environment: NodeJS.ProcessEnv) {
    this.#environment = environment
  }
  set(name: string, value: string): void {
    const existing = this.#injected.get(name)
    this.#injected.set(name, {
      previous: existing ? existing.previous : this.#environment[name],
      value,
    })
    this.#environment[name] = value
  }
  clear(): void {
    for (const [name, { previous, value }] of this.#injected) {
      if (this.#environment[name] !== value) continue
      if (previous === undefined) Reflect.deleteProperty(this.#environment, name)
      else this.#environment[name] = previous
    }
    this.#injected.clear()
  }
}
export const savedSecretEnvironment = new SecretEnvironment(process.env)
