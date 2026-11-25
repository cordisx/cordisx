import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalManagerBrowserOrigin } from '../independent-manager/manager-browser-origin.js'
import { MAX_STANDALONE_CONSOLE_ORIGINS } from '../launcher/managed-console-browser-gateway.js'
import type { ManagerPublicIngressListener } from './manager-public-ingress.js'
import { managerPublicConsoleTemplate } from './manager-public-console.js'

export interface ManagerDeploymentConfig {
  readonly publicOrigin: string
  readonly publicConsoleOriginTemplates?: readonly string[]
  readonly listeners: readonly ManagerPublicIngressListener[]
  /** Private fingerprint includes certificate rotation without exposing key material. */
  readonly revision: string
}

function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MANAGER_DEPLOYMENT_INVALID')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error('MANAGER_DEPLOYMENT_INVALID')
  return result
}

function port(value: unknown, zero = false): value is number {
  return Number.isInteger(value) && Number(value) >= (zero ? 0 : 1) && Number(value) <= 65_535
}

function consoleOrigins(value: unknown, count: number): readonly string[] | undefined {
  if (value === undefined) return undefined
  let raw: unknown[]
  if (Array.isArray(value)) raw = value
  else {
    const item = record(value, ['template', 'firstPort'])
    if (typeof item.template !== 'string' || item.template.length === 0 || item.template.length > 2_048) {
      throw new Error('MANAGER_DEPLOYMENT_INVALID')
    }
    const template = item.template
    const hasPort = template.includes('{port}')
    if (
      hasPort !== (item.firstPort !== undefined)
      || hasPort && (!port(item.firstPort) || item.firstPort + count - 1 > 65_535)
      || /[{}]/u.test(template.replaceAll('{slot}', '').replaceAll('{port}', '').replace('{view}', ''))
    ) throw new Error('MANAGER_DEPLOYMENT_INVALID')
    const firstPort = item.firstPort as number | undefined
    raw = Array.from(
      { length: count },
      (_, index) =>
        template.replaceAll('{slot}', String(index + 1)).replaceAll('{port}', String((firstPort ?? 0) + index)),
    )
  }
  if (raw.length !== count) throw new Error('MANAGER_DEPLOYMENT_INVALID')
  return raw.map(value => managerPublicConsoleTemplate(value).template)
}

/** Load an explicit deployment choice; no private key or local filename is projected to browsers. */
export async function loadManagerDeploymentConfig(
  file: string,
  consoleCount: number,
): Promise<ManagerDeploymentConfig> {
  try {
    if (!Number.isInteger(consoleCount) || consoleCount < 0 || consoleCount > MAX_STANDALONE_CONSOLE_ORIGINS) {
      throw new Error('MANAGER_DEPLOYMENT_INVALID')
    }
    const bytes = await readFile(file)
    if (bytes.length === 0 || bytes.length > 65_536) throw new Error('MANAGER_DEPLOYMENT_INVALID')
    const input = record(JSON.parse(bytes.toString('utf8')), ['publicOrigin', 'consoleOrigins', 'listeners', 'tls'])
    const publicOrigin = canonicalManagerBrowserOrigin(input.publicOrigin)
    const publicConsoleOriginTemplates = consoleOrigins(input.consoleOrigins, consoleCount)
    if (!Array.isArray(input.listeners) || input.listeners.length === 0 || input.listeners.length > 64) {
      throw new Error('MANAGER_DEPLOYMENT_INVALID')
    }
    let tls: ManagerPublicIngressListener['tls']
    let tlsRevision: readonly string[] | undefined
    if (input.tls !== undefined) {
      const item = record(input.tls, ['certificateFile', 'privateKeyFile'])
      if (
        typeof item.certificateFile !== 'string' || !item.certificateFile
        || typeof item.privateKeyFile !== 'string' || !item.privateKeyFile
      ) throw new Error('MANAGER_DEPLOYMENT_INVALID')
      const [certificate, privateKey] = await Promise.all([
        readFile(path.resolve(path.dirname(file), item.certificateFile)),
        readFile(path.resolve(path.dirname(file), item.privateKeyFile)),
      ])
      if (
        !certificate.length || !privateKey.length || certificate.length > 1_048_576 || privateKey.length > 1_048_576
      ) {
        throw new Error('MANAGER_DEPLOYMENT_INVALID')
      }
      tls = { certificate, privateKey }
      tlsRevision = [certificate, privateKey].map(value => createHash('sha256').update(value).digest('hex'))
    }
    const listeners: ManagerPublicIngressListener[] = []
    for (const raw of input.listeners) {
      const item = record(raw, ['host', 'port', 'firstPort', 'count'])
      if (typeof item.host !== 'string' || !item.host || item.host.length > 255) {
        throw new Error('MANAGER_DEPLOYMENT_INVALID')
      }
      const host = item.host
      if (item.port !== undefined) {
        if (!port(item.port, true) || item.firstPort !== undefined || item.count !== undefined) {
          throw new Error('MANAGER_DEPLOYMENT_INVALID')
        }
        listeners.push({ host, port: item.port, ...(tls ? { tls } : {}) })
      } else {
        if (
          !port(item.firstPort) || !Number.isInteger(item.count) || Number(item.count) < 1 || Number(item.count) > 64
          || item.firstPort + Number(item.count) - 1 > 65_535
        ) throw new Error('MANAGER_DEPLOYMENT_INVALID')
        for (let index = 0; index < Number(item.count); index++) {
          listeners.push({ host, port: item.firstPort + index, ...(tls ? { tls } : {}) })
        }
      }
      if (listeners.length > 64) throw new Error('MANAGER_DEPLOYMENT_INVALID')
    }
    const identities = listeners.filter(item => item.port !== 0).map(item => item.host + ':' + item.port)
    if (new Set(identities).size !== identities.length) throw new Error('MANAGER_DEPLOYMENT_INVALID')
    const revision = createHash('sha256').update(JSON.stringify({
      publicOrigin,
      publicConsoleOriginTemplates,
      listeners: listeners.map(({ host, port }) => ({ host, port })),
      tlsRevision,
    })).digest('hex')
    return {
      publicOrigin,
      ...(publicConsoleOriginTemplates === undefined ? {} : { publicConsoleOriginTemplates }),
      listeners,
      revision,
    }
  } catch {
    throw new Error('MANAGER_DEPLOYMENT_INVALID')
  }
}
