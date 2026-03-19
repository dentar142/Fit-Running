const fs = require('fs')
const path = require('path')

// Generate a minimal 256x256 32-bit BMP as placeholder icon
const w = 256
const h = 256
const header = Buffer.alloc(54)
header.write('BM')
header.writeUInt32LE(54 + w * h * 4, 2)
header.writeUInt32LE(54, 10)
header.writeUInt32LE(40, 14)
header.writeInt32LE(w, 18)
header.writeInt32LE(-h, 22) // top-down
header.writeUInt16LE(1, 26)
header.writeUInt16LE(32, 28)
header.writeUInt32LE(w * h * 4, 34)

const pixels = Buffer.alloc(w * h * 4)
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    // Blue gradient background
    pixels[i] = 227      // B
    pixels[i + 1] = 113  // G
    pixels[i + 2] = 0    // R (accent blue #0071E3 in BGRA)
    pixels[i + 3] = 255  // A

    // Make it the accent blue
    pixels[i] = 0xE3
    pixels[i + 1] = 0x71
    pixels[i + 2] = 0x00
    pixels[i + 3] = 0xFF
  }
}

const dir = path.join(__dirname, '..', 'build')
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.concat([header, pixels]))
console.log('Icon placeholder created at build/icon.png')
