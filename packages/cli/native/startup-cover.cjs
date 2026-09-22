// Host-owned startup cover. This code executes in the original
// main renderer, before its scripts, and never creates a native window/view.
function installCover(options, animateMark) {
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
  dialog.id = `cordisx-startup-${receipt.nonce}`
  dialog.dataset.cordisxStartup = options.generation
  dialog.setAttribute('aria-label', 'CordisX 正在启动')
  dialog.style.cssText =
    'position:fixed;inset:0;margin:0;max-width:none;max-height:none;width:100vw;height:100vh;border:0;padding:0;background:transparent;color-scheme:light dark;overflow:hidden;'
  // The modal backdrop lives outside the content's shadow root. Scope its
  // transparency to this document receipt and retire the rule with the cover.
  const backdropStyle = document.createElement('style')
  backdropStyle.textContent = `#${dialog.id}::backdrop { background: transparent; }`
  const content = document.createElement('div')
  content.style.cssText = 'width:100%;height:100%;'
  dialog.append(content)
  const shadow = content.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = options.css
  const main = document.createElement('main')
  main.setAttribute('role', 'status')
  main.setAttribute('aria-live', 'polite')
  const mark = document.createElement('div')
  mark.className = 'mark'
  mark.setAttribute('aria-hidden', 'true')
  if (options.mark) {
    const parsed = new DOMParser().parseFromString(`<body>${options.mark}</body>`, 'text/html')
    for (const svg of parsed.body.children) mark.append(document.importNode(svg, true))
  }
  const status = document.createElement('div')
  status.className = 'status'
  const message = document.createElement('p')
  message.textContent = '正在准备…'
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
  status.append(message, actions)
  main.append(mark, status)
  shadow.append(style, main)
  // Root-level mounting survives the app replacing its body/root subtree.
  function mount() {
    if (disposed || !globalThis.document?.documentElement) return
    if (backdropStyle.parentNode !== document.documentElement) document.documentElement.append(backdropStyle)
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
    backdropStyle.remove()
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
      backdropStyle.remove()
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
  animateMark?.(mark)
}

exports.buildCoverSource = (options, animate) =>
  `(${installCover.toString()})(${JSON.stringify(options)},${animate ?? 'undefined'});`
