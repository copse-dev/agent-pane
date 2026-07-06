// The provider contract now lives with the rest of the module's wire types in
// ./wire-types.ts. Re-exported here so existing `./types.ts` importers within
// the module are unchanged.
export type { LLMProvider } from './wire-types.ts'
