// TEMPORARY full end-to-end pass over a packaged app (deleted after the run).
// Boots the installed build headlessly on a throwaway home with the mock model and drives
// real UI inputs: chat, aside ask + cancel, create/delete Bot, every Settings page, Ocean
// theme select, restart persistence. Fails on page errors, missing UI, or bad exit.
// Usage: node scripts/e2e-full.mjs [app executable]
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [given] = process.argv.slice(2)
const executable = given || join(root, 'dist-pack', 'mac-arm64', 'AktonBot.app', 'Contents', 'MacOS', 'AktonBot')
if (!existsSync(executable)) {
  console.error(`e2e-full: no app at ${executable}.`)
  process.exit(2)
}

const work = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), 'akton-bot-e2e-')))
mkdirSync(join(work, 'home'))
const children = []
const shots = []
function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    child.kill()
  }
}
setTimeout(() => {
  console.error('e2e-full: FAILED: gave up after 12 minutes')
  stopChildren()
  process.exit(1)
}, 12 * 60_000).unref()

const appDir = resolve(executable, '..', '..', '..')
const copy = join(work, basename(appDir))
cpSync(appDir, copy, { recursive: true, verbatimSymlinks: true })
const exe = join(copy, relative(appDir, executable))
console.log(`e2e-full: runs a copy of ${appDir} in ${work}`)

function startMock() {
  const mock = spawn(process.execPath, [join(root, '..', 'akton-bot', 'dev', 'mock-llm.mjs')], {
    env: { ...process.env, MOCK_PORT: '0', MOCK_LOG: join(work, 'mock.log'), MOCK_DELAY_MS: '2500' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  children.push(mock)
  return new Promise((done, reject) => {
    let text = ''
    mock.stdout.setEncoding('utf8')
    mock.stdout.on('data', (chunk) => {
      text += chunk
      const url = /http:\/\/127\.0\.0\.1:\d+\/v1/u.exec(text)?.[0]
      if (url) done(url)
    })
    mock.once('exit', code => reject(new Error(`e2e-full: the mock model stopped (exit ${String(code)})`)))
  })
}

async function appPage(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      const page = targets.find(target => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//u.test(target.url))
      if (page) return page
    } catch { /* not listening yet */ }
    await sleep(500)
  }
  throw new Error('the app window did not appear')
}

function devtools(url, problems) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let next = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`console.error: ${message.params.args.map(arg => arg.value ?? arg.description).join(' ')}`)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ''}`)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  })
  const opened = new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const call = (method, params = {}) => new Promise((done, reject) => {
    const id = next++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the window did not answer ${method}`))
    }, 30_000)
    const settle = action => (value) => { clearTimeout(timer); action(value) }
    pending.set(id, { resolve: settle(done), reject: settle(reject) })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { opened, call }
}

function driver(cdp, tag) {
  const evaluate = async expression => (await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  const until = async (expression, label, ms = 120_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await evaluate(`Boolean(${expression})`)) return
      await sleep(250)
    }
    throw new Error(`timed out waiting for ${label}`)
  }
  const text = needle => `document.body.innerText.includes(${JSON.stringify(needle)})`
  const api = (endpoint, payload) => evaluate(`fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: ${JSON.stringify(endpoint)}, payload: ${JSON.stringify(payload)} }) }).then(r => r.json())`)
  const shot = async (name) => {
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' })
    const file = `/tmp/e2e-${tag}-${name}.png`
    writeFileSync(file, Buffer.from(data, 'base64'))
    shots.push(file)
    console.log(`e2e-full: saved ${file}`)
  }
  const clickText = async (label, scope = 'document') => {
    const clicked = await evaluate(`(() => {
      const nodes = [...${scope}.querySelectorAll('button, [role=menuitem], [role=option], select, a')];
      const node = nodes.find(n => (n.textContent ?? '').trim().includes(${JSON.stringify(label)}));
      if (node) { node.scrollIntoView({ block: 'center' }); node.click(); return true }
      return false
    })()`)
    if (!clicked) throw new Error(`no clickable ${JSON.stringify(label)}`)
  }
  const clickSel = async (selector) => {
    const clicked = await evaluate(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (n) { n.scrollIntoView({ block: 'center' }); n.click(); return true } return false })()`)
    if (!clicked) throw new Error(`no ${selector}`)
  }
  const visibleInput = label => `[...document.querySelectorAll('input[aria-label=\"' + ${JSON.stringify(label)} + '\"]')].find(n => n.getClientRects().length > 0)`;
  const fill = async (label, value) => {
    const focused = await evaluate(`(() => {
      const el = ${visibleInput(label)}
      if (!el) return 'missing'
      el.scrollIntoView({ block: 'center' })
      el.focus()
      return document.activeElement === el ? 'ok' : 'unfocused'
    })()`)
    if (focused !== 'ok') throw new Error(`fill ${JSON.stringify(label)}: ${focused}`)
    await cdp.call('Input.insertText', { text: value })
    let got = await evaluate(`${visibleInput(label)}?.value ?? 'missing'`)
    if (got !== value) {
      await evaluate(`(() => {
        const el = ${visibleInput(label)}
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      got = await evaluate(`${visibleInput(label)}?.value ?? 'missing'`)
    }
    if (got !== value) throw new Error(`fill ${JSON.stringify(label)}: got ${JSON.stringify(got)}`)
  }
  return { evaluate, until, text, api, shot, clickText, clickSel, fill }
}

async function focusComposer(d, cdp) {
  const { evaluate } = d
  const box = "[...document.querySelectorAll('[role=textbox][contenteditable=true], textarea')].at(-1)"
  const focusCheck = "(document.activeElement?.isContentEditable ?? false) || document.activeElement?.tagName === 'TEXTAREA'"
  const probe = `(() => {
    const el = ${box}
    if (el === undefined) return null
    const rect = el.getBoundingClientRect()
    for (const part of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const point = { x: rect.x + rect.width * part, y: rect.y + rect.height / 2 }
      const hit = document.elementFromPoint(point.x, point.y)
      if (hit === el || (hit !== null && el.contains(hit))) return { x: point.x, y: point.y }
    }
    return null
  })()`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !(await evaluate(`Boolean(${focusCheck})`))) {
    const point = await evaluate(probe)
    if (point !== null && point !== undefined) {
      await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      await sleep(300)
    } else await sleep(250)
  }
  if (!(await evaluate(`Boolean(${focusCheck})`))) throw new Error('timed out waiting for the focused composer')
}

async function sendMessage(d, cdp, message) {
  await focusComposer(d, cdp)
  await cdp.call('Input.insertText', { text: message })
  await d.until(d.text(message), 'the typed message', 10_000)
  for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
}

async function launch(modelUrl, port) {
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  Object.assign(env, {
    AKTON_BOT_HOME: join(work, 'home'), AKTON_BOT_SHELL_DATA: join(work, 'shell'),
    DEEPSEEK_BASE_URL: modelUrl, DEEPSEEK_API_KEY: 'mock-key',
  })
  const app = spawn(exe, [`--remote-debugging-port=${String(port)}`], { stdio: 'inherit', env })
  children.push(app)
  const exited = new Promise((done) => { app.once('exit', (code, signal) => { done({ code, signal }) }) })
  return { app, exited }
}

async function attach(port, problems, ms = 120_000) {
  const cdp = devtools((await appPage(port, Date.now() + ms)).webSocketDebuggerUrl, problems)
  await cdp.opened
  await cdp.call('Runtime.enable')
  await cdp.call('Log.enable')
  return cdp
}

async function openChief(d) {
  const dismissNotice = () => d.evaluate("[...document.querySelectorAll('[role=dialog] button')].find(node => /^(Continue|继续)$/u.test(node.textContent.trim()))?.click()")
  await d.until("document.querySelector('.bt-tile, .bt-row')", 'the team')
  await dismissNotice()
  const main = await d.evaluate("fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state', payload: {} }) }).then(r => r.json()).then(r => r.value.mainBotId)")
  await d.evaluate(`document.querySelector(${JSON.stringify(`[data-bot-id="${main}"]`)}).click()`)
  await d.until("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)')", 'the model choice')
  await d.evaluate("document.querySelector('.bt-model-chip:not(.bt-model-chip-quiet)').click()")
  await d.until(d.text('先让团队帮你做哪块'), 'the greeting')
  await dismissNotice()
  const state = await d.api('state', {})
  const chief = state.value.bots.find(bot => bot.id === state.value.mainBotId)
  return { main, sessionId: chief.sessionId }
}

let failed = false
const problems = []
try {
  const modelUrl = await startMock()
  // ---- Boot 1: full UI pass ----
  const port = 9300 + Math.floor(Math.random() * 600)
  const first = await launch(modelUrl, port)
  const cdp = await attach(port, problems)
  const d = driver(cdp, 'boot1')
  globalThis.__e2eLastShot = d.shot
  const { main, sessionId } = await openChief(d)
  console.log('e2e-full: team open, chief chat open')

  // Branding: AktonBot everywhere, no Bot-mode Agent switch.
  const brand = await d.evaluate('document.body.innerText.includes("AktonBot")')
  if (!brand) throw new Error('AktonBot brand missing from the team view')
  await d.shot('01-team')
  await d.clickSel('[aria-label="Account"]')
  await d.until("document.querySelector('[role=menu]')", 'the account menu', 10_000)
  const menuText = await d.evaluate("document.querySelector('[role=menu]').innerText")
  if (menuText.includes('Agent mode')) throw new Error(`Agent switch still offered: ${menuText}`)
  console.log(`e2e-full: account menu has no Agent switch: ${JSON.stringify(menuText.split('\n').join(' | '))}`)
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })

  // Chat message + reply, with a mid-stream frame.
  await sendMessage(d, cdp, 'hello chief')
  await sleep(1200)
  await d.shot('02-chat-streaming')
  await d.until(d.text('收到：hello chief'), 'the reply')
  console.log('e2e-full: chat reply received')
  await d.shot('03-chat-done')

  // Aside via the real /btw composer command, through answering to done.
  await sendMessage(d, cdp, '/btw what changed?')
  {
    const end = Date.now() + 60_000
    for (;;) {
      const state = await d.evaluate(`(() => ({
        answering: document.querySelector('.bt-btw-cancel') !== null,
        done: document.querySelector('[data-status=done]') !== null,
        tail: document.body.innerText.slice(-200),
      }))()`)
      if (state.answering || state.done) {
        console.log(`e2e-full: aside card seen (answering: ${String(state.answering)})`)
        break
      }
      if (Date.now() > end) throw new Error(`no aside card appeared; page tail: ${JSON.stringify(state.tail)}`)
      await sleep(150)
    }
  }
  await d.shot('04-aside-answering')
  await d.until("!document.querySelector('.bt-btw-cancel')", 'the answered aside', 60_000)
  const asideDone = await d.evaluate("document.querySelector('[data-status=done]') !== null")
  if (!asideDone) throw new Error('the aside never reached done')
  console.log('e2e-full: aside asked and answered')

  // Aside cancel via the channel, verified in the UI.
  const asked = await d.api('btw', { sessionId, text: 'cancel me please' })
  if (!asked.ok) throw new Error(`btw failed: ${asked.error?.message}`)
  const cancelled = await d.api('btw-cancel', { sessionId, id: asked.value.id })
  if (!cancelled.ok) throw new Error(`btw-cancel failed: ${cancelled.error?.message}`)
  await d.until("document.querySelector('[data-status=cancelled]')", 'the cancelled aside', 30_000)
  const cancelledText = await d.evaluate("document.body.innerText.includes('Cancelled')")
  if (!cancelledText) throw new Error('the cancelled aside shows no Cancelled state')
  console.log('e2e-full: aside cancelled and shown as Cancelled')
  await d.shot('05-aside-cancelled')

  // Create a Bot through the real New… flow.
  await d.clickSel('[aria-label="New…"]')
  await d.until(d.text('Create new Bot'), 'the new-chat panel', 10_000)
  await d.clickText('Create new Bot')
  await d.until("document.querySelector('input[aria-label=\"Name\"]')", 'the name field', 10_000)
  await d.clickSel('input[aria-label="Name"]')
  await cdp.call('Input.insertText', { text: 'Scout' })
  await d.clickSel('.bt-create-go')
  await d.until(d.text('Scout'), 'the new Bot row')
  console.log('e2e-full: Bot Scout created')
  await d.shot('06-bot-created')

  // Delete it through Settings → Bots.
  await d.clickSel('[aria-label="Account"]')
  await d.until("document.querySelector('[role=menu]')", 'the account menu', 10_000)
  await d.clickText('Bot settings')
  await d.until("document.querySelector('.bt-settings')", 'settings', 10_000)
  await d.clickText('Bots')
  await d.until(d.text('Scout'), 'Scout in Bots settings', 10_000)
  await d.clickText('Scout')
  await d.until(d.text('Delete Bot'), 'the delete control', 10_000)
  await d.clickText('Delete Bot')
  await d.until(d.text('Delete Scout?'), 'the delete confirm', 10_000)
  await d.clickText('Delete Scout?')
  await d.until(`!${d.text('Scout')}`, 'Scout being gone', 30_000)
  console.log('e2e-full: Bot Scout deleted')
  await d.shot('07-bot-deleted')

  // Every Settings page renders without errors. Deleting a Bot may close settings.
  const settingsOpen = await d.evaluate("document.querySelector('.bt-settings') !== null")
  if (!settingsOpen) {
    await d.clickSel('[aria-label="Account"]')
    await d.until("document.querySelector('[role=menu]')", 'the account menu', 10_000)
    await d.clickText('Bot settings')
    await d.until("document.querySelector('.bt-settings')", 'settings', 10_000)
  }
  console.log(`e2e-full: settings nav: ${await d.evaluate("[...document.querySelectorAll('.bt-settings-item')].map(n => n.textContent.trim()).join(' | ')")}`)
  for (const page of ['General', 'Models', 'Bots', 'Group chats', 'Connectors', 'Capabilities', 'Scheduled tasks', 'Usage', 'Secrets', 'Feedback', 'About AktonBot']) {
    await d.clickText(page)
    await sleep(400)
  }
  console.log('e2e-full: all settings pages visited')
  const aboutText = await d.evaluate('document.body.innerText')
  if (!aboutText.includes('Engine')) throw new Error('About page lost the Engine row')
  if (/DeepSeek Bot|DS Bot|Classic Agent mode/u.test(aboutText)) throw new Error('old brand strings on the About page')
  await d.shot('08-about')

  // Models page: add a custom provider on the mock endpoint, then Test it.
  await d.clickText('Models')
  await d.until(d.text('Model providers'), 'the Models page', 10_000)
  await d.clickText('Add a provider')
  await d.until(d.text('Custom API'), 'the add form', 10_000)
  await d.clickText('Custom API')
  // The mock speaks the Anthropic protocol natively; the OpenAI path is covered
  // by unit tests plus the live Ultramarine check.
  await d.evaluate(`(() => {
    const el = document.querySelector('.bt-provider-form select[aria-label="Protocol"]')
    if (!el) throw new Error('no protocol select in the add form')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'anthropic-messages')
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await d.fill('Provider ID', 'mockgate')
  await d.fill('Endpoint', modelUrl)
  await d.fill('Model ids', 'mock-1')
  await d.fill('API key', 'mock-key')
  await d.until("[...document.querySelectorAll('.bt-provider-form .bt-secret-row-actions button')].some(b => b.textContent.trim() === 'Add' && !b.disabled)", 'an enabled Add button', 10_000)
  await d.evaluate(`(() => {
    const form = [...document.querySelectorAll('.bt-provider-form')].find(f => f.getClientRects().length > 0)
    if (!form) throw new Error('no visible provider form')
    const add = [...form.querySelectorAll('.bt-secret-row-actions button')].find(b => b.textContent.trim() === 'Add')
    if (!add) throw new Error('no Add in the visible form')
    if (add.disabled) throw new Error('Add disabled in the visible form')
    add.scrollIntoView({ block: 'center' })
    add.click()
  })()`)
  {
    const end = Date.now() + 30_000
    for (;;) {
      const state = await d.evaluate(`(() => ({
        row: document.body.innerText.includes('mockgate') && !document.querySelector('.bt-provider-form'),
        error: document.querySelector('.bt-error')?.textContent ?? '',
      }))()`)
      if (state.row) break
      if (state.error) throw new Error(`provider add refused: ${state.error}`)
      if (Date.now() > end) {
        const probe = await d.api('provider-add', { custom: true, provider: 'mockprobe', api: 'openai-completions', baseURL: modelUrl, key: 'mock-key', models: [{ id: 'mock-1' }] })
        throw new Error(`timed out waiting for the added provider (channel probe: ${JSON.stringify(probe).slice(0, 200)})`)
      }
      await sleep(250)
    }
  }
  console.log('e2e-full: custom provider added through the UI')
  await d.clickText('mockgate')
  await d.until(d.text('Test'), 'the Test button', 10_000)
  await d.clickText('Test')
  await d.until(d.text('Works:'), 'the passing test', 120_000)
  console.log('e2e-full: provider Test button reports Works')
  await d.shot('08b-models-test')

  // Ocean theme select, verified in computed style and prefs.
  await d.clickText('General')
  await d.until("document.querySelector('select[aria-label=\"Theme\"]')", 'the theme select', 10_000)
  const options = await d.evaluate("[...document.querySelector('select[aria-label=\"Theme\"]').options].map(o => o.text)")
  if (!options.includes('Ocean')) throw new Error(`Ocean missing from themes: ${options.join(',')}`)
  if (options.some(name => /DeepSeek/u.test(name))) throw new Error(`DeepSeek theme still offered: ${options.join(',')}`)
  await d.evaluate(`(() => {
    const el = document.querySelector('select[aria-label="Theme"]')
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, 'ocean')
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await d.until("getComputedStyle(document.body).getPropertyValue('--bt-accent').trim() === '#4d6bfe'", 'the Ocean accent', 30_000)
  const prefs = (await d.api('state', {})).value.prefs
  if (prefs.theme !== 'ocean') throw new Error(`prefs.theme is ${prefs.theme}, want ocean`)
  console.log('e2e-full: Ocean theme applied')
  await d.shot('09-ocean')

  // Close like a user, expect a clean exit.
  void cdp.call('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined)
  const outcome = await Promise.race([first.exited, sleep(40_000).then(() => undefined)])
  if (outcome === undefined) throw new Error('the app did not exit after its window closed')
  if (outcome.code !== 0) throw new Error(`the app exited with code ${String(outcome.code)}`)
  console.log(`e2e-full: first run exited (code ${String(outcome.code)})`)

  // ---- Boot 2: restart persistence on the same home ----
  const port2 = 9300 + Math.floor(Math.random() * 600)
  const second = await launch(modelUrl, port2)
  const cdp2 = await attach(port2, problems)
  const d2 = driver(cdp2, 'boot2')
  globalThis.__e2eLastShot = d2.shot
  await d2.until("document.querySelector('.bt-tile, .bt-row')", 'the team after restart')
  const state2 = await d2.api('state', {})
  const names = state2.value.bots.map(bot => bot.name)
  if (!names.includes('Chief')) throw new Error(`Chief missing after restart: ${names.join(',')}`)
  if (names.includes('Scout')) throw new Error('deleted Scout came back after restart')
  if (state2.value.prefs.theme !== 'ocean') throw new Error(`theme did not persist: ${state2.value.prefs.theme}`)
  console.log('e2e-full: restart kept Chief, Ocean and the deletion')
  await d2.shot('10-restarted')
  void cdp2.call('Runtime.evaluate', { expression: 'window.close()' }).catch(() => undefined)
  const outcome2 = await Promise.race([second.exited, sleep(40_000).then(() => undefined)])
  if (outcome2 === undefined) throw new Error('the restarted app did not exit after its window closed')
  if (outcome2.code !== 0) throw new Error(`the restarted app exited with code ${String(outcome2.code)}`)
  if (problems.length > 0) throw new Error(`page problems:\n  ${problems.join('\n  ')}`)
  console.log('e2e-full: passed')
} catch (error) {
  failed = true
  console.error(`e2e-full: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  try {
    const last = globalThis.__e2eLastShot
    if (last) await last('FAIL')
  } catch { /* diagnostics only */ }
}
stopChildren()
await sleep(500)
rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
process.exit(failed ? 1 : 0)

