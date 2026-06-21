import ElectronStore from 'electron-store'

const store = new ElectronStore<Record<string, unknown>>()
export const storageGet = (key: string): unknown => store.get(key)

export const storageSet = (key: string, value: unknown): void => {
  store.set(key, value)
}
