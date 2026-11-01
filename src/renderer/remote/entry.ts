import '../../preload/index.ts'
// Preload must install window.api before modules that use its DOM helpers evaluate.
void import('./host.ts').then(({ startRemoteChat }) => startRemoteChat())
