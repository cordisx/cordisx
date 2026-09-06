import { once } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import {
  CdpPluginLifecycleRuntime,
  type CdpTarget,
  iconThemePreferenceDeliveryEvaluation,
  injectableTargets,
  RENDERER_DISPOSE_EXPRESSION,
  resolveCdpInjectionTimeoutMs,
  runtimeEvaluationException,
  serviceConfigResponseEvaluation,
  watchAndInject,
} from '../packages/cli/src/launcher/cdp.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PluginPermissionIdentityRegistry } from '../packages/cli/src/launcher/permission-rpc.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { RollbackPlan } from '../packages/cli/src/launcher/packages/authority.js'
import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import {
  ICON_THEME_PREFERENCE_BINDING,
  IconThemePreferenceBroadcastHub,
} from '../packages/cli/src/launcher/icon-theme-rpc.js'
import { BrowserIconThemePreferenceBridge } from '../packages/cli/src/renderer/icon-theme-preference-binding.js'
import { OwnerDocumentLeaseRegistry } from '../packages/cli/src/launcher/owner-document-rpc.js'
import type { PluginGenerationGraphLease } from '../packages/cli/src/launcher/plugin-generation-loader.js'

function target(id: string, title: string, url = 'https://example.test/'): CdpTarget {
  return { id, title, url, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1/${id}` }
}

function deferred<Value = void>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function iconThemeReceiverPayload(expression: string): Record<string, unknown> | undefined {
  const encoded = expression.match(/receiver\(((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\)/u)?.[1]
  if (encoded === undefined) return undefined
  try {
    return JSON.parse(JSON.parse(encoded) as string) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function readyLeaseEcho(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  return payload?.kind === 'document-ready'
    ? { readyLeaseToken: payload.readyLeaseToken, readyLeaseRevision: payload.readyLeaseRevision }
    : {}
}

describe('injectableTargets', () => {
  it('keeps Codex renderer pages and excludes unrelated Electron pages', () => {
    expect(
      injectableTargets([
        target('settings', 'Settings'),
        target('codex', 'Codex'),
        target('avatar', 'Codex', 'app://-/index.html?initialRoute=%2Favatar-overlay'),
        target('auth', 'Authentication'),
      ]).map(item => item.id),
    ).toEqual(['codex'])
  })

  it('fails closed when branding is absent instead of injecting an unrelated page', () => {
    expect(injectableTargets([
      target('first', 'Desktop'),
      target('second', 'Settings'),
    ])).toEqual([])
  })
})

describe('CDP injection timeout configuration', () => {
  it('keeps the product default and accepts a bounded capture override', () => {
    expect(resolveCdpInjectionTimeoutMs(undefined)).toBe(60_000)
    expect(resolveCdpInjectionTimeoutMs('')).toBe(60_000)
    expect(resolveCdpInjectionTimeoutMs('300000')).toBe(300_000)
  })

  it('rejects malformed or unbounded overrides', () => {
    expect(() => resolveCdpInjectionTimeoutMs('slow')).toThrow(/integer number of milliseconds/)
    expect(() => resolveCdpInjectionTimeoutMs('4999')).toThrow(/between 5000 and 600000/)
    expect(() => resolveCdpInjectionTimeoutMs('600001')).toThrow(/between 5000 and 600000/)
  })

  it('uses the injection budget and abort boundary for the large future-document bootstrap', async () => {
    const source = await readFile(
      new URL('../packages/cli/src/launcher/cdp-installation.ts', import.meta.url),
      'utf8',
    )
    const registration = source.slice(
      source.indexOf("'Page.addScriptToEvaluateOnNewDocument'"),
      source.indexOf('identifier = added.identifier'),
    )
    expect(registration).toContain('CDP_INJECTION_TIMEOUT_MS')
    expect(registration).toMatch(/CDP_INJECTION_TIMEOUT_MS,\s*\),\s*signal,\s*\)/u)
    expect(registration).not.toContain('CDP_REQUEST_TIMEOUT_MS')
  })

  it('preserves Runtime.evaluate exceptions and awaits the outer composition boot', async () => {
    expect(runtimeEvaluationException({
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 8,
        columnNumber: 2,
        exception: { description: 'SyntaxError: fixture graph bootstrap failed' },
      },
    })).toBe('SyntaxError: fixture graph bootstrap failed (line 9, column 3)')

    const source = await readFile(
      new URL('../packages/cli/src/launcher/cdp-installation.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain('CordisX renderer injection evaluation failed:')
    expect(source).toContain('globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot')
    expect(source).toContain('CordisX renderer composition and runtime boot promises are undefined after injection')
    expect(source).toContain('CordisX renderer runtime is undefined after boot')
    expect(source).toContain('error.stack ?? error.message')
  })

  it('emits an executable renderer cleanup that reports failures after clearing production markers', async () => {
    const calls: string[] = []
    const cleanupGlobal: Record<string, unknown> = {
      __cordisxRuntime: {
        dispose: async () => {
          calls.push('runtime')
          throw new Error('runtime cleanup failed')
        },
      },
      __cordisxPluginGenerationResourcesV1: {
        dispose: () => {
          calls.push('resources')
          throw new Error('resource cleanup failed')
        },
      },
      __cordisxProductionBootstrapState: { status: 'evaluated' },
      __cordisxProductionInstallId: 'fixture-install',
    }
    const result = await Function('globalThis', `return ${RENDERER_DISPOSE_EXPRESSION}`)(cleanupGlobal)
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('runtime cleanup failed\n'),
    })
    expect(String(result.error)).toContain('resource cleanup failed')
    expect(calls).toEqual(['runtime', 'resources'])
    expect(cleanupGlobal).not.toHaveProperty('__cordisxProductionBootstrapState')
    expect(cleanupGlobal).not.toHaveProperty('__cordisxProductionInstallId')
  })
})

describe('service config CDP responses', () => {
  it('returns to the exact execution context that issued the binding request', () => {
    const params = serviceConfigResponseEvaluation({ requestId: 'request-1', ok: true, value: [] }, 73)
    expect(params).toMatchObject({ contextId: 73, allowUnsafeEvalBlockedByCSP: true, returnByValue: true })
    expect(params.expression).toContain('__cordisxServiceConfigReceiveV1')
    expect(serviceConfigResponseEvaluation({ requestId: 'request-2', ok: false })).not.toHaveProperty('contextId')
  })
})
