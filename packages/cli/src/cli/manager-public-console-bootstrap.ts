import { randomBytes } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export const MANAGER_CONSOLE_AUTH_PATH = '/__cordisx-console-auth'

function scriptValue(value: string): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
}

/** Exchange the one-use service ticket without exposing the service cookie to the browser. */
export function managerPublicConsoleBootstrap(input: {
  readonly managerOrigin: string
  readonly publicOrigin: string
  readonly location: string
  readonly password: string
  readonly serviceHeaders: IncomingHttpHeaders
}): { readonly headers: string[]; readonly body: string } {
  const destination = new URL(input.location, input.publicOrigin)
  if (
    !input.location.startsWith('/') || input.location.startsWith('//') || input.location.includes('\\')
    || destination.origin !== input.publicOrigin || destination.username || destination.password
    || destination.searchParams.has('ticket')
  ) throw new Error('MANAGER_CONSOLE_REDIRECT_INVALID')
  const target = destination.pathname + destination.search + destination.hash
  const nonce = randomBytes(16).toString('base64')
  const policy = "default-src 'none'; script-src 'nonce-" + nonce + "'; connect-src 'self'; "
    + 'frame-ancestors ' + input.managerOrigin + "; base-uri 'none'; form-action 'none'"
  const upstreamPolicy = input.serviceHeaders['content-security-policy']
  const upstreamPolicies = upstreamPolicy === undefined
    ? []
    : Array.isArray(upstreamPolicy)
    ? upstreamPolicy
    : [upstreamPolicy]
  // The generated exchange page is Host content, so a service's script or
  // default policy must not disable it. Preserve every embedding restriction;
  // the service's complete policy remains intact on its own responses.
  const framePolicies = upstreamPolicies.flatMap(policy =>
    policy.split(',').flatMap(serialized => {
      const directive = serialized.split(';').find(value => /^\s*frame-ancestors(?:\s|$)/iu.test(value))
      return directive === undefined ? [] : [directive.trim()]
    })
  )
  const frameOptions = input.serviceHeaders['x-frame-options']
  if (frameOptions !== undefined && typeof frameOptions !== 'string') throw new Error('MANAGER_CONSOLE_FRAME_INVALID')
  const script = 'const password = ' + scriptValue(input.password) + ';'
    + 'const target = ' + scriptValue(target) + ';'
    + "history.replaceState(null, '', target);"
    + 'const request = new XMLHttpRequest();'
    + 'request.open("GET", ' + scriptValue(MANAGER_CONSOLE_AUTH_PATH) + ', true, "cx", password);'
    + 'request.onload = () => { if (request.status === 204) location.replace(target);'
    + ' else document.body.textContent = "Console unavailable."; };'
    + 'request.onerror = () => { document.body.textContent = "Console unavailable."; };'
    + 'request.send();'
  return {
    headers: [
      'content-type',
      'text/html; charset=utf-8',
      'cache-control',
      'no-store',
      'referrer-policy',
      'no-referrer',
      'x-content-type-options',
      'nosniff',
      'content-security-policy',
      policy,
      ...framePolicies.flatMap(value => ['content-security-policy', value]),
      ...(frameOptions === undefined ? [] : ['x-frame-options', frameOptions]),
    ],
    body: '<!doctype html><html><body><script nonce="' + nonce + '">' + script + '</script></body></html>',
  }
}
