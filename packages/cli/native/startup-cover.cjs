// Host-owned startup cover. This code executes in the original
// main renderer, before its scripts, and never creates a native window/view.
function installCover(options) {
  if (globalThis.top !== globalThis || location.href !== options.url) return
  if (globalThis.__cordisxStartupDocument) return
  const receipt = Object.freeze({
    generation: options.generation,
    nonce: crypto.randomUUID(),
    timeOrigin: performance.timeOrigin,
    url: location.href,
  })
  let phase = 'covered'
  let disposed = false
  let requestedAction = null
  const dialog = document.createElement('dialog')
  dialog.dataset.cordisxStartup = options.generation
  dialog.setAttribute('aria-label', 'CordisX 正在启动')
  dialog.style.cssText =
    'position:fixed;inset:0;margin:0;max-width:none;max-height:none;width:100vw;height:100vh;border:0;padding:0;color-scheme:light dark;overflow:hidden;'
  const content = document.createElement('div')
  content.style.cssText = 'width:100%;height:100%;'
  dialog.append(content)
  const shadow = content.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = options.css
  const main = document.createElement('main')
  main.setAttribute('role', 'status')
  main.setAttribute('aria-live', 'polite')
  const heading = document.createElement('h1')
  heading.textContent = 'CordisX'
  const message = document.createElement('p')
  message.textContent = '正在准备 ChatGPT 与 CordisX'
  const actions = document.createElement('div')
  actions.hidden = true
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = '重试'
  retry.onclick = () => {
    requestedAction = 'retry'
  }
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '关闭'
  close.onclick = () => {
    requestedAction = 'close'
  }
  actions.append(retry, close)
  main.append(heading, message, actions)
  shadow.append(style, main)
  // Root-level mounting survives the app replacing its body/root subtree.
  function mount() {
    if (disposed || !globalThis.document?.documentElement) return
    if (dialog.parentNode !== document.documentElement) document.documentElement.append(dialog)
    if (!dialog.open) dialog.showModal()
  }
  const observer = new MutationObserver(mount)
  observer.observe(document, { childList: true, subtree: true })
  function block(event) {
    if (disposed) return
    if (
      event.type === 'keydown' && (event.metaKey || event.ctrlKey)
      && ['q', 'w'].includes(event.key.toLowerCase())
    ) return
    if (event.composedPath().includes(dialog)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  const events = ['keydown', 'beforeinput', 'pointerdown', 'click', 'submit', 'focusin']
  for (const name of events) globalThis.addEventListener(name, block, true)
  const retire = () => {
    disposed = true
    phase = 'retired'
    observer.disconnect()
    for (const name of events) globalThis.removeEventListener(name, block, true)
    globalThis.removeEventListener('pagehide', retire)
    dialog.removeEventListener('cancel', cancel)
    if (dialog.open) dialog.close()
    dialog.remove()
  }
  globalThis.addEventListener('pagehide', retire, { once: true })
  const cancel = event => event.preventDefault()
  dialog.addEventListener('cancel', cancel)
  function matches(value) {
    return value && Object.keys(receipt).every(key => value[key] === receipt[key])
      && location.href === options.url
  }
  const api = Object.freeze({
    snapshot: () => ({ receipt, phase, requestedAction, mounted: dialog.isConnected, modal: dialog.open }),
    // The caller must supply observations from this final document. This is a
    // release fence, not an implementation of native/application readiness.
    release(value, observations) {
      if (
        disposed || phase !== 'covered' || !matches(value)
        || !matches(observations?.receipt)
        || document.readyState === 'loading'
        || observations?.hostUsable !== true
        || !(observations?.authenticated === true && observations?.cordisxReady === true
          || observations?.authenticated === false && observations?.loginUsable === true)
      ) return false
      disposed = true
      phase = 'released'
      observer.disconnect()
      for (const name of events) globalThis.removeEventListener(name, block, true)
      globalThis.removeEventListener('pagehide', retire)
      dialog.removeEventListener('cancel', cancel)
      dialog.close()
      dialog.remove()
      return true
    },
    fail(value) {
      if (disposed || !matches(value)) return false
      phase = 'failed'
      message.textContent = '启动未完成，请重试或关闭此窗口'
      actions.hidden = false
      retry.focus()
      mount()
      return true
    },
    retire(value) {
      if (disposed || !matches(value)) return false
      retire()
      return true
    },
  })
  Object.defineProperty(globalThis, '__cordisxStartupDocument', { value: api, configurable: false })
  mount()
}

exports.buildCoverSource = options => `(${installCover.toString()})(${JSON.stringify(options)});`
