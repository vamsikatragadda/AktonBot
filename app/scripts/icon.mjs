// Draws the app icon from the Akton logo and writes assets/icon.svg,
// assets/icon.png (1024 px) and assets/icon.ico (Windows, 16 to 256 px).
// Usage: npm run icon. It runs itself again inside Electron, which turns the SVG into PNGs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
const assets = join(dirname(here), '..', 'assets')
const ICO_SIZES = [16, 20, 24, 32, 36, 40, 48, 64, 72, 96, 128, 256]

// The Akton logo in its 100 box: a rounded square with the A, whose right leg
// steps past the square. Bounds are x 12..78 and y 6..90.
const LOGO = { cx: 45, cy: 48, width: 66, height: 84 }
const logoMarkup = (ink, width) => `<g fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">`
  + `<rect x="10" y="6" width="70" height="70" rx="13"/>`
  + `<path d="M46 18 L24 70 Q12 70 16 38"/>`
  + `<path d="M46 18 L68 70 L78 90"/>`
  + `<path d="M32 50 L60 50"/>`
  + `</g>`

// A superellipse close to the system's rounded-square app tile.
function tile(size, inset) {
  const radius = (size - 2 * inset) / 2
  const center = size / 2
  const points = []
  for (let i = 0; i < 128; i += 1) {
    const angle = (i / 128) * Math.PI * 2
    const at = value => Math.sign(value) * Math.abs(value) ** 0.4
    points.push(`${(center + radius * at(Math.cos(angle))).toFixed(2)} ${(center + radius * at(Math.sin(angle))).toFixed(2)}`)
  }
  return `M${points.join('L')}Z`
}

// `plate`: the tile's share of the canvas. macOS wants a margin around the tile; Windows
// draws its icons nearly edge to edge, so its sizes use a fuller tile.
function iconSvg(plate, size = 1024) {
  const inset = (size * (1 - plate)) / 2
  const logoHeight = (size - 2 * inset) * 0.72
  const scale = logoHeight / LOGO.height
  const x = size / 2 - LOGO.cx * scale
  const y = size / 2 - LOGO.cy * scale
  const path = tile(size, inset)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n`
    + `<defs>\n`
    + `<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a2a"/><stop offset="1" stop-color="#0a0a0a"/></linearGradient>\n`
    + `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${size * 0.012}" stdDeviation="${size * 0.012}" flood-color="#000" flood-opacity=".28"/></filter>\n`
    + `</defs>\n`
    + `<path d="${path}" fill="url(#plate)" filter="url(#shadow)"/>\n`
    + `<path d="${path}" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="${size * 0.004}"/>\n`
    + `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)})">${logoMarkup('#f5f5f5', 7)}</g>\n`
    + `</svg>\n`
}

// PNG entries in an .ico file, which Windows reads since Vista.
function icoFile(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index
    head.writeUInt8(size >= 256 ? 0 : size, at)
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(png.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map(image => image.png)])
}

// Inside Electron: a page draws each SVG on a canvas of its exact size, so every size is
// drawn from the vectors rather than scaled down from a large bitmap.
async function renderInElectron(jobs) {
  const { BrowserWindow } = await import('electron')
  const page = new BrowserWindow({ show: false })
  await page.loadURL('data:text/html,<!doctype html><title>icon</title>')
  const draw = async (list) => Promise.all(list.map(async ({ svg, size }) => {
    const image = new Image()
    image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    canvas.getContext('2d').drawImage(image, 0, 0, size, size)
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length)
  }))
  const pngs = await page.webContents.executeJavaScript(`(${draw.toString()})(${JSON.stringify(jobs)})`)
  page.destroy()
  return pngs.map(data => Buffer.from(data, 'base64'))
}

if (process.versions.electron) {
  const jobs = [{ svg: iconSvg(0.805), size: 1024 }, ...ICO_SIZES.map(size => ({ svg: iconSvg(0.92, size), size }))]
  // Not awaited at the top: Electron is ready only after the main module has run.
  const { app } = await import('electron')
  app.whenReady().then(() => renderInElectron(jobs)).then(([large, ...small]) => {
    writeFileSync(join(assets, 'icon.png'), large)
    writeFileSync(join(assets, 'icon.ico'), icoFile(ICO_SIZES.map((size, index) => ({ size, png: small[index] }))))
    app.exit(0)
  }).catch((error) => {
    console.error(error)
    app.exit(1)
  })
} else {
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, 'icon.svg'), iconSvg(0.805))
  // A terminal inside an Electron-based editor may set ELECTRON_RUN_AS_NODE, which would keep Electron plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const electron = createRequire(import.meta.url)('electron')
  const run = spawnSync(electron, [here], { stdio: 'inherit', env })
  if (run.status !== 0) process.exit(run.status ?? 1)
  console.log('icon: wrote assets/icon.svg, assets/icon.png and assets/icon.ico')
}
