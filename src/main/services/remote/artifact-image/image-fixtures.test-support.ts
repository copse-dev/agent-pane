/** Minimal image headers for artifact-image tests: enough bytes to sniff, not to decode. */

export function pngBytes(width = 4, height = 3, padding = 16): Buffer {
  const header = Buffer.alloc(33 + padding)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

export function gifBytes(width = 4, height = 3): Buffer {
  const header = Buffer.alloc(16)
  header.write('GIF89a', 0, 'latin1')
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  return header
}

export function jpegBytes(width = 4, height = 3): Buffer {
  // SOI, an APP0 segment to skip, then SOF0 with the dimensions.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)])
  const sof = Buffer.alloc(11)
  sof.writeUInt8(0xff, 0)
  sof.writeUInt8(0xc0, 1)
  sof.writeUInt16BE(11, 2)
  sof.writeUInt8(8, 4)
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

export function webpLosslessBytes(width = 4, height = 3): Buffer {
  const header = Buffer.alloc(30)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(22, 4)
  header.write('WEBP', 8, 'latin1')
  header.write('VP8L', 12, 'latin1')
  header.writeUInt32LE(10, 16)
  header.writeUInt8(0x2f, 20)
  header.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21)
  return header
}
