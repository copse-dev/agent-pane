/** Development controller transfer over the existing guest stdin; never evaluates on the host. */
export const APPLE_DESKTOP_MAX_CONTROLLER = 2 * 1024 * 1024
export const APPLE_DESKTOP_BOOTSTRAP = String.raw`
const Module = require('node:module');
let pending = '';
process.stdin.setEncoding('utf8');
const receive = chunk => {
  pending += chunk;
  if (Buffer.byteLength(pending) > 2 * 1024 * 1024) throw new Error('Desktop controller exceeds the transfer limit');
  const newline = pending.indexOf('\n');
  if (newline === -1) return;
  process.stdin.removeListener('data', receive);
  process.stdin.pause();
  const encoded = pending.slice(0, newline);
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid desktop controller encoding');
  const source = Buffer.from(encoded, 'base64').toString('utf8');
  if (pending.slice(newline + 1)) throw new Error('Unexpected data before desktop controller startup');
  const entry = new Module('/opt/copse-desktop/current-guest.cjs', module);
  entry.filename = '/opt/copse-desktop/current-guest.cjs';
  entry.paths = module.paths;
  entry._compile(source, entry.filename);
};
process.stdin.on('data', receive);
`
