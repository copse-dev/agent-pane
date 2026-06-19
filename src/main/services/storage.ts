import ElectronStore from 'electron-store'
const store = new ElectronStore()
export const storageGet = (key: string) => store.get(key)

export const storageSet = (key: string, value: unknown) => store.set(key, value as any)
