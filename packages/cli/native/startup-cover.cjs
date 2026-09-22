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
  let presentationReleasedAt
  let scheduledFrame
  let modal = false
  const dialog = document.createElement('dialog')
  dialog.id = `cordisx-startup-${receipt.nonce}`
  dialog.dataset.cordisxStartup = options.generation
  dialog.setAttribute('aria-label', 'CordisX 正在启动')
  dialog.style.cssText =
    'position:fixed;inset:0;margin:0;max-width:none;max-height:none;width:100vw;height:100vh;border:0;padding:0;background:transparent;color-scheme:light dark;overflow:hidden;'
  // The modal backdrop lives outside the content's shadow root. Scope its
  // transparency to this document receipt and retire the rule with the cover.
  const backdropStyle = document.createElement('style')
  backdropStyle.textContent = `#${dialog.id}::backdrop { background: transparent; }
    [data-cordisx-startup-mark="${receipt.nonce}"] { visibility: hidden; }`
  const nativeMarks = new Map()
  function restoreNativeMarks() {
    for (const [element, previous] of nativeMarks) {
      if (element.getAttribute('data-cordisx-startup-mark') !== receipt.nonce) continue
      if (previous === null) element.removeAttribute('data-cordisx-startup-mark')
      else element.setAttribute('data-cordisx-startup-mark', previous)
    }
    nativeMarks.clear()
  }
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
    if (disposed || phase === 'presented' || !globalThis.document?.documentElement) return
    if (backdropStyle.parentNode !== document.documentElement) document.documentElement.append(backdropStyle)
    if (phase === 'covered' && options.nativeMarkSelector) {
      const nativeMark = document.querySelector(options.nativeMarkSelector)
      if (nativeMark && !nativeMarks.has(nativeMark)) {
        nativeMarks.set(nativeMark, nativeMark.getAttribute('data-cordisx-startup-mark'))
        nativeMark.setAttribute('data-cordisx-startup-mark', receipt.nonce)
      }
    }
    if (dialog.parentNode !== document.documentElement) document.documentElement.append(dialog)
    if (!dialog.open) {
      modal = presentationReleasedAt === undefined
      if (modal) dialog.showModal()
      else dialog.show()
    }
  }
  function visible(element) {
    if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false
    const box = element.getBoundingClientRect()
    if (
      box.width <= 0 || box.height <= 0 || box.right <= 0 || box.bottom <= 0
      || box.left >= innerWidth || box.top >= innerHeight
    ) return false
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false
    }
    return true
  }
  function inspectSurface() {
    if (
      disposed || presentationReleasedAt !== undefined || !globalThis.document?.documentElement
      || !options.nativeSurface || !matches(receipt)
    ) return
    const signals = options.nativeSurface
    const surfaces = [...document.querySelectorAll(signals.root)].filter(visible).flatMap(root => {
      const chrome = [...root.querySelectorAll(signals.chrome)].some(element =>
        element.closest(signals.root) === root && visible(element)
      )
      if (!chrome) return []
      return [...root.querySelectorAll(signals.main)].filter(element =>
        element.closest(signals.root) === root && visible(element)
        && [...element.querySelectorAll(signals.content)].some(visible)
      )
    })
    if (surfaces.length !== 1) return
    presentationReleasedAt = performance.timeOrigin + performance.now()
    withdraw()
    if (phase === 'failed') {
      configureRecovery()
      mount()
    } else phase = 'presented'
  }
  function reconcile() {
    if (disposed || !globalThis.document) return
    inspectSurface()
    mount()
    // One deferred geometry check per mutation/event covers newly applied CSS.
    // It is observation only; no elapsed time can authorize presentation.
    if (
      !disposed && presentationReleasedAt === undefined && scheduledFrame === undefined
      && options.nativeSurface && typeof requestAnimationFrame === 'function'
    ) {
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = undefined
        inspectSurface()
      })
    }
  }
  const observer = new MutationObserver(reconcile)
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'inert'],
  })
  document.addEventListener('load', reconcile, true)
  document.addEventListener('transitionrun', reconcile, true)
  document.addEventListener('animationstart', reconcile, true)
  document.addEventListener('transitionend', reconcile, true)
  document.addEventListener('animationend', reconcile, true)
  globalThis.addEventListener('resize', reconcile)
  function block(event) {
    if (disposed || presentationReleasedAt !== undefined) return
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
  function withdraw() {
    observer.disconnect()
    if (scheduledFrame !== undefined) cancelAnimationFrame(scheduledFrame)
    scheduledFrame = undefined
    document.removeEventListener('load', reconcile, true)
    document.removeEventListener('transitionrun', reconcile, true)
    document.removeEventListener('animationstart', reconcile, true)
    document.removeEventListener('transitionend', reconcile, true)
    document.removeEventListener('animationend', reconcile, true)
    globalThis.removeEventListener('resize', reconcile)
    for (const name of events) globalThis.removeEventListener(name, block, true)
    if (dialog.open) dialog.close()
    modal = false
    dialog.remove()
    restoreNativeMarks()
    backdropStyle.remove()
  }
  function configureRecovery() {
    if (presentationReleasedAt === undefined) return
    // An initialization failure remains actionable without blocking the native
    // main surface that has already taken over presentation and interaction.
    dialog.style.cssText =
      'position:fixed;inset:auto 16px 16px auto;margin:0;width:360px;max-width:calc(100vw - 32px);height:auto;max-height:calc(100vh - 32px);border:1px solid GrayText;border-radius:12px;padding:16px;background:Canvas;color:CanvasText;color-scheme:light dark;overflow:auto;'
    content.style.height = 'auto'
    main.style.height = 'auto'
    status.style.position = 'static'
  }
  const retire = () => {
    disposed = true
    phase = 'retired'
    withdraw()
    globalThis.removeEventListener('pagehide', retire)
    dialog.removeEventListener('cancel', cancel)
  }
  globalThis.addEventListener('pagehide', retire, { once: true })
  const cancel = event => event.preventDefault()
  dialog.addEventListener('cancel', cancel)
  function matches(value) {
    return value && Object.keys(receipt).every(key => value[key] === receipt[key])
      && globalThis.location?.href === options.url
      && globalThis.performance?.timeOrigin === receipt.timeOrigin
  }
  const api = Object.freeze({
    snapshot: () => ({
      receipt,
      phase,
      requestedAction,
      mounted: dialog.isConnected,
      modal: dialog.open && modal,
      presentationReleasedAt,
    }),
    // The caller must supply observations from this final document. This is a
    // release fence, not an implementation of native/application readiness.
    release(value, observations) {
      if (
        disposed || !['covered', 'presented'].includes(phase) || !matches(value)
        || !matches(observations?.receipt)
        || document.readyState === 'loading'
        || observations?.hostUsable !== true
        || !(observations?.workspaceUsable === true && observations?.cordisxReady === true
            && observations?.authenticated === undefined
          || observations?.authenticated === true && observations?.cordisxReady === true
          || observations?.authenticated === false && observations?.loginUsable === true)
      ) return false
      disposed = true
      phase = 'released'
      withdraw()
      globalThis.removeEventListener('pagehide', retire)
      dialog.removeEventListener('cancel', cancel)
      return true
    },
    fail(value) {
      if (disposed || !matches(value)) return false
      phase = 'failed'
      mark.hidden = true
      restoreNativeMarks()
      message.textContent = '启动未完成，请重试或关闭此窗口'
      actions.hidden = false
      configureRecovery()
      mount()
      if (presentationReleasedAt === undefined) retry.focus()
      return true
    },
    retire(value) {
      if (disposed || !matches(value)) return false
      retire()
      return true
    },
  })
  Object.defineProperty(globalThis, '__cordisxStartupDocument', { value: api, configurable: false })
  reconcile()
  animateMark?.(mark)
}

exports.buildCoverSource = (options, animate) =>
  `(${installCover.toString()})(${JSON.stringify(options)},${animate ?? 'undefined'});`
