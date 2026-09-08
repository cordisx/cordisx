/** Host-owned consent. The callback and secret value are never supplied to plugin code. */
export async function captureHttpConsent(input: {
  readonly pluginId: string
  readonly origin: string
  readonly credential: 'none' | 'bearer'
  readonly signal: AbortSignal
}): Promise<{ readonly approved: false } | { readonly approved: true; readonly secret?: string }> {
  if (input.signal.aborted || typeof document === 'undefined') return { approved: false }
  const zh = document.documentElement.lang.startsWith('zh')
  const dialog = document.createElement('dialog')
  dialog.setAttribute('aria-label', zh ? '允许服务器连接' : 'Allow server connection')
  const form = document.createElement('form')
  form.method = 'dialog'
  const title = document.createElement('h2')
  title.textContent = zh ? '允许服务器连接' : 'Allow server connection'
  const owner = document.createElement('p')
  owner.textContent = input.pluginId
  const origin = document.createElement('p')
  origin.textContent = input.origin
  const token = document.createElement('input')
  token.type = 'password'
  token.autocomplete = 'off'
  token.maxLength = 16_384
  token.required = input.credential === 'bearer'
  token.setAttribute('aria-label', zh ? '访问令牌' : 'Access token')
  const label = document.createElement('label')
  label.textContent = zh ? '访问令牌' : 'Access token'
  label.append(token)
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = zh ? '取消' : 'Cancel'
  const allow = document.createElement('button')
  allow.type = 'submit'
  allow.textContent = zh ? '允许' : 'Allow'
  form.append(title, owner, origin)
  if (input.credential === 'bearer') form.append(label)
  form.append(cancel, allow)
  dialog.append(form)
  document.body.append(dialog)
  return await new Promise(resolve => {
    let done = false
    const finish = (approved: boolean) => {
      if (done) return
      done = true
      const secret = approved && input.credential === 'bearer' ? token.value : undefined
      token.value = ''
      input.signal.removeEventListener('abort', abort)
      dialog.close()
      dialog.remove()
      resolve(approved ? { approved: true, ...(secret === undefined ? {} : { secret }) } : { approved: false })
    }
    const abort = () => finish(false)
    input.signal.addEventListener('abort', abort, { once: true })
    cancel.onclick = () => finish(false)
    dialog.oncancel = event => {
      event.preventDefault()
      finish(false)
    }
    dialog.onclose = () => finish(false)
    form.onsubmit = event => {
      event.preventDefault()
      finish(true)
    }
    try {
      dialog.showModal()
      ;(input.credential === 'bearer' ? token : allow).focus()
    } catch {
      finish(false)
    }
  })
}
