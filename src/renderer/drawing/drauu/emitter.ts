/** Minimal typed event emitter; stands in for upstream's `nanoevents`. */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<(...args: never[]) => void>>()

  on<K extends keyof Events>(type: K, fn: Events[K] & ((...args: never[]) => void)): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(fn)
    return (): void => {
      set.delete(fn)
    }
  }

  emit<K extends keyof Events>(
    type: K,
    ...args: Events[K] extends (...a: infer A) => void ? A : never
  ): void {
    const set = this.listeners.get(type)
    if (!set) return
    for (const fn of [...set]) {
      Reflect.apply(fn, undefined, args)
    }
  }
}
