/** Startup expiry owns admission only; the parent signal still owns the installed document. */
export function createCdpInstallationDeadline(lifetime: AbortSignal, deadline: number) {
  const expiry = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
  const admission = new AbortController()
  const expire = () => admission.abort(expiry.reason)
  if (expiry.aborted) expire()
  else expiry.addEventListener('abort', expire, { once: true })
  return {
    signal: AbortSignal.any([lifetime, admission.signal]),
    release: () => expiry.removeEventListener('abort', expire),
  }
}
