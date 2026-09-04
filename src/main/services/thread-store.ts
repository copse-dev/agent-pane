// The filesystem-native thread store lives in `@copse/thread-store`; this
// re-export keeps app imports stable and binds the host environment first.
import './thread-store-environment.ts'

export * from '@copse/thread-store/thread-store.ts'
