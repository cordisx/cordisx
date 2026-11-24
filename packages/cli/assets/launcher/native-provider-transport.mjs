import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { readNativeLines } from './native-json-lines.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const provider = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value) ? value : undefined
const key = id => JSON.stringify([typeof id, id])
const MAX_WORKERS = 128
export const managedProviderCatalogProtocol = 1
const closeCatalog = catalog => Promise.resolve().then(() => catalog?.close?.()).catch(() => undefined)

async function verifyCatalog(catalog) {
  if (
    !object(catalog) || catalog.status !== 'ready' || !path.isAbsolute(catalog.path ?? '')
    || !/^[a-f0-9]{64}$/u.test(catalog.sha256 ?? '') || !/^[a-f0-9]{64}$/u.test(catalog.revision ?? '')
    || typeof catalog.close !== 'function'
  ) throw new Error('Native provider catalog unavailable')
  const metadata = await lstat(catalog.path)
  if (
    !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024
    || (process.platform !== 'win32' && ((metadata.mode & 0o077) !== 0
      || (process.getuid && metadata.uid !== process.getuid())))
  ) {
    throw new Error('Native provider catalog unavailable')
  }
  const bytes = await readFile(catalog.path)
  if (createHash('sha256').update(bytes).digest('hex') !== catalog.sha256) {
    throw new Error('Native provider catalog unavailable')
  }
}

// Codex accepts configuration flags both before and after `app-server`. When
// both positions are used, the subcommand list can replace the root list.
// Keep their original order in one subcommand list before appending our flags.
function catalogWorkerArguments(args, insertion, overrides, catalogArgs) {
  const common = [], before = [], after = []
  const collect = (items, remaining) => {
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      if (['-c', '--config', '--enable', '--disable'].includes(item)) {
        if (index + 1 >= items.length) throw new Error('Native provider launch unavailable')
        common.push(item, items[++index])
      } else if (item.startsWith('--config=') || item.startsWith('--enable=') || item.startsWith('--disable=')) {
        common.push(item)
      } else remaining.push(item)
    }
  }
  collect(args.slice(0, insertion), before)
  collect(args.slice(insertion + 1), after)
  return [...before, 'app-server', ...after, ...common, ...overrides, ...catalogArgs]
}

/** Multiplex native connections after the Host has admitted the original request.
 * Credentials and endpoints remain in that request's config, never argv or disk.
 * The inert process default satisfies native provider identity checks and cannot
 * silently send a request when a per-thread override has been lost.
 */
export function createNativeProviderTransport(
  primary,
  {
    executable,
    args,
    env,
    cwd,
    initialize,
    diagnostic,
    uncertain,
    reviewRouting,
    managedCatalog,
    workerEnvironment,
    onlyManagedRouting,
    readThreadCatalog,
    recordThreadCatalog,
  } = {},
) {
  const stdout = new PassThrough()
  const workers = new Map()
  const owners = new Map()
  // Unsubscribe does not prove that Codex has released a thread writer.
  const unloaded = new Map()
  const serverRequests = new Map()
  const primaryWrite = primary.stdin.write.bind(primary.stdin)
  const observe = details => {
    try {
      diagnostic?.(details)
    } catch { /* Diagnostics never control provider transport. */ }
  }
  let initializeParams = initialize
  let disposed = false
  const emit = (message, original) => {
    if (!disposed) stdout.write((original ?? JSON.stringify(message)) + '\n')
  }
  const send = (write, message) =>
    new Promise((resolve, reject) => {
      write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve())
    })
  const receive = (connection, message, original) => {
    if (connection !== primary && connection.initializeId === message.id && message.method === undefined) {
      message.error
        ? connection.rejectReady(new Error('Native provider initialization rejected'))
        : connection.resolveReady()
      return
    }
    if (connection !== primary && connection.catalogCheckId === message.id && message.method === undefined) {
      message.error || message.result?.config?.model_catalog_json !== connection.catalog.path
        || message.result?.config?.model_provider !== connection.providerId
        ? connection.rejectCatalog(new Error('Native provider catalog configuration unavailable'))
        : connection.resolveCatalog()
      return
    }
    if (onlyManagedRouting && connection !== primary && connection.catalog && message.method === 'thread/started') {
      const thread = object(message.params?.thread)
      if (
        typeof thread?.id === 'string' && !owners.has(thread.id)
        && [...connection.pending.values()].some(item => ['thread/start', 'thread/fork'].includes(item.method))
      ) {
        owners.set(thread.id, {
          connection,
          status: thread.status,
          model: thread.model,
          providerId: connection.providerId,
          catalogState: 'pending',
        })
      }
    }
    let catalogRecord
    if (message.method === undefined) {
      const pending = connection.pending?.get(key(message.id))
      if (pending) {
        connection.pending.delete(key(message.id))
        const thread = message.result?.thread
        if (
          !message.error && thread?.id
          && (['thread/start', 'thread/resume', 'thread/fork'].includes(pending.method)
            || reviewRouting && pending.method === 'thread/read')
        ) {
          const previous = owners.get(thread.id)
          owners.set(thread.id, {
            ...(pending.method === 'thread/read' ? previous : {}),
            connection: pending.method === 'thread/read' && previous ? previous.connection : connection,
            status: thread.status,
            model: message.result.model ?? thread.model,
            providerId: message.result.modelProvider ?? thread.modelProvider,
            ...(onlyManagedRouting && connection.catalog && pending.method === 'thread/resume'
              ? { catalogState: 'recorded' }
              : {}),
          })
          unloaded.delete(thread.id)
          if (
            onlyManagedRouting && connection.catalog
            && ['thread/start', 'thread/fork'].includes(pending.method)
          ) {
            const owner = owners.get(thread.id)
            owner.catalogState = 'pending'
            catalogRecord = {
              owner,
              threadId: thread.id,
              providerId: connection.providerId,
              revision: connection.catalog.revision,
            }
          }
        }
        if (!message.error && pending.method === 'thread/unsubscribe') {
          const owner = owners.get(pending.threadId)
          if (owner?.connection && owner.connection !== primary) unloaded.set(pending.threadId, owner.connection)
          owners.delete(pending.threadId)
        }
        if (!message.error && pending.method === 'turn/start' && message.result?.turn?.id) {
          const owner = owners.get(pending.threadId)
          if (owner?.connection === connection) owner.turn = message.result.turn
        }
      }
      if (pending?.method === 'thread/list' && Array.isArray(message.result?.data)) {
        for (const thread of message.result.data) {
          const owner = owners.get(thread.id)
          if (owner?.connection !== primary && owner?.status) {
            thread.status = owner.status
            original = undefined
          }
        }
      }
    } else if (message.id !== undefined && connection !== primary) {
      const id = `cordisx-provider-request-${randomUUID()}`
      serverRequests.set(id, { connection, id: message.id, threadId: message.params?.threadId })
      message = { ...message, id }
      original = undefined
    } else if (connection !== primary) {
      if (message.method === 'serverRequest/resolved') {
        const requestId = message.params?.requestId
        const request = [...serverRequests].find(([, entry]) =>
          entry.connection === connection && key(entry.id) === key(requestId)
        )
        if (!request) return
        serverRequests.delete(request[0])
        message = { ...message, params: { ...message.params, requestId: request[0] } }
        original = undefined
      }
      const threadId = message.params?.threadId ?? message.params?.thread?.id
      // Global account/config notifications still belong to the primary Host.
      if (typeof threadId !== 'string' && message.method !== 'serverRequest/resolved') return
      const owner = owners.get(threadId)
      if (owner?.connection === connection) {
        if (message.method === 'thread/status/changed') owner.status = message.params.status
        if (message.method === 'turn/started') owner.turn = message.params.turn
        if (message.method === 'turn/completed') delete owner.turn
        if (message.method === 'thread/closed') {
          unloaded.set(threadId, connection)
          owners.delete(threadId)
        }
      }
    }
    if (reviewRouting && message.method === 'thread/settings/updated') {
      const owner = owners.get(message.params?.threadId), settings = message.params?.threadSettings
      if (owner && typeof settings?.model === 'string') owner.model = settings.model
      if (owner && typeof settings?.modelProvider === 'string') owner.providerId = settings.modelProvider
    }
    if (catalogRecord) {
      void Promise.resolve().then(() =>
        recordThreadCatalog(catalogRecord.threadId, {
          providerId: catalogRecord.providerId,
          revision: catalogRecord.revision,
        })
      ).then(() => {
        catalogRecord.owner.catalogState = 'recorded'
        emit(message, original)
      }, () => {
        catalogRecord.owner.catalogState = 'unconfirmed'
        uncertain?.(message.id)
        emit({
          id: message.id,
          error: {
            code: -32000,
            message:
              'Thread was created but its model metadata could not be saved. Check thread history before retrying.',
            data: { type: 'managedCatalogReconciliationRequired', threadId: catalogRecord.threadId },
          },
        })
      })
      return
    }
    emit(message, original)
  }
  const attach = (stream, connection) => {
    readNativeLines(stream, line => {
      try {
        receive(connection, JSON.parse(line), line)
      } catch {
        if (connection === primary && !disposed) stdout.write(line + '\n')
      }
    }, reason => {
      observe({ phase: reason, childPid: connection.child?.pid })
    })
  }
  primary.pending = new Map()
  attach(primary.stdout, primary)

  const currentCatalog = async id => {
    let catalog
    if (managedCatalog) {
      try {
        catalog = await managedCatalog(id)
      } catch {
        catalog = { status: 'unavailable', reason: 'catalog-preparation-failed' }
      }
      if (catalog?.status === 'unavailable') {
        const reason = /^[a-z0-9-]{1,80}$/u.test(catalog.reason ?? '') ? catalog.reason : 'catalog-unavailable'
        observe({ phase: 'managed-catalog-unavailable', provider: id, reason })
        return { status: 'unavailable' }
      }
      if (catalog !== undefined) {
        try {
          await verifyCatalog(catalog)
        } catch (error) {
          await closeCatalog(catalog)
          throw error
        }
      }
    }
    return catalog === undefined ? { status: 'unmanaged' } : { status: 'ready', catalog }
  }

  const checkCurrentCatalog = async worker => {
    if (!managedCatalog) return
    const latest = await currentCatalog(worker.providerId)
    try {
      if (latest.status === 'unavailable') throw new Error('MANAGED_CATALOG_UNAVAILABLE')
      if ((worker.catalog?.revision ?? null) !== (latest.catalog?.revision ?? null)) {
        observe({ phase: 'managed-catalog-changed', provider: worker.providerId })
        throw new Error('MANAGED_CATALOG_CHANGED')
      }
    } finally {
      await closeCatalog(latest.catalog)
    }
  }

  const retireWorker = async worker => {
    if (worker.closed) return true
    if (
      worker.pending.size > 0 || [...owners.values()].some(owner => owner.connection === worker)
      || [...serverRequests.values()].some(request => request.connection === worker)
    ) return false
    worker.retiring ??= new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 5000)
      worker.child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
      if (worker.child.exitCode !== null) {
        clearTimeout(timer)
        resolve(true)
      } else worker.child.kill('SIGTERM')
    })
    return await worker.retiring
  }

  const workerFor = async (id, catalog) => {
    const workerKey = JSON.stringify([id, catalog?.revision ?? null])
    let worker = workers.get(workerKey)
    if (worker && catalog) await closeCatalog(catalog)
    if (!worker) {
      for (const [existingKey, existing] of workers) {
        if (
          existing.providerId !== id || existingKey === workerKey || existing.pending.size > 0
          || [...owners.values()].some(owner => owner.connection === existing)
          || [...serverRequests.values()].some(request => request.connection === existing)
        ) continue
        if (!await retireWorker(existing)) {
          await closeCatalog(catalog)
          throw new Error('MANAGED_CATALOG_SOURCE_IN_USE')
        }
      }
      if (workers.size >= MAX_WORKERS) {
        await closeCatalog(catalog)
        throw new Error('Native provider connection limit reached')
      }
      const insertion = args.indexOf('app-server')
      if (insertion < 0 || !initializeParams) {
        await closeCatalog(catalog)
        throw new Error('Native provider launch unavailable')
      }
      const overrides = [
        '-c',
        `model_provider=${JSON.stringify(id)}`,
        '-c',
        `model_providers={${
          JSON.stringify(id)
        }={name="CordisX provider transport",base_url="http://127.0.0.1:0/v1",wire_api="responses",requires_openai_auth=false}}`,
      ]
      let workerEnv
      try {
        workerEnv = workerEnvironment ? await workerEnvironment(id) : env
        if (workerEnvironment && !object(workerEnv)) throw new Error('Native provider environment unavailable')
      } catch (error) {
        await closeCatalog(catalog)
        throw error
      }
      const catalogArgs = catalog ? ['-c', `model_catalog_json=${JSON.stringify(catalog.path)}`] : []
      let child
      try {
        const launchArgs = catalog || workerEnvironment
          ? catalogWorkerArguments(args, insertion, overrides, catalogArgs)
          : [...args.slice(0, insertion), ...overrides, ...args.slice(insertion)]
        child = spawn(executable, launchArgs, {
          env: workerEnv,
          ...(cwd ? { cwd } : {}),
          stdio: ['pipe', 'pipe', 'inherit'],
        })
      } catch (error) {
        await closeCatalog(catalog)
        throw error
      }
      worker = {
        child,
        providerId: id,
        catalog,
        pending: new Map(),
        write: child.stdin.write.bind(child.stdin),
        initializeId: `cordisx-provider-initialize-${randomUUID()}`,
      }
      worker.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.rejectReady(new Error('Native provider initialization timed out'))
          child.kill('SIGTERM')
        }, 15000)
        worker.resolveReady = () => {
          clearTimeout(timer)
          resolve()
        }
        worker.rejectReady = error => {
          clearTimeout(timer)
          reject(error)
        }
      })
      workers.set(workerKey, worker)
      attach(child.stdout, worker)
      const failed = details => {
        observe({ childPid: child.pid, provider: id, ...details })
        if (worker.closed) return
        worker.closed = true
        if (workers.get(workerKey) === worker) workers.delete(workerKey)
        worker.rejectReady(new Error('Native provider connection closed'))
        worker.rejectCatalog?.(new Error('Native provider connection closed'))
        for (const pending of worker.pending.values()) {
          uncertain?.(pending.id)
          emit({
            id: pending.id,
            error: {
              code: -32000,
              message: 'Native provider connection closed. Check thread history before retrying.',
            },
          })
        }
        worker.pending.clear()
        for (const [threadId, owner] of owners) {
          if (owner.connection !== worker) continue
          if (owner.turn?.id) {
            emit({
              method: 'turn/completed',
              params: {
                threadId,
                turn: {
                  ...owner.turn,
                  status: 'failed',
                  error: { message: 'Native provider connection closed. Check thread history before retrying.' },
                },
              },
            })
          }
          emit({ method: 'thread/status/changed', params: { threadId, status: { type: 'systemError' } } })
          owners.delete(threadId)
        }
        for (const [requestId, request] of serverRequests) {
          if (request.connection !== worker) continue
          emit({ method: 'serverRequest/resolved', params: { requestId, threadId: request.threadId } })
          serverRequests.delete(requestId)
        }
      }
      const errorCode = error =>
        ['ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'ECONNRESET'].includes(error?.code) ? error.code : 'unknown'
      child.once('error', error => failed({ phase: 'provider-spawn-failed', errorCode: errorCode(error) }))
      child.once('exit', (exitCode, signal) => failed({ phase: 'provider-exited', exitCode, signal }))
      child.once('close', () => {
        void closeCatalog(catalog)
      })
      child.stdin.on('error', error => failed({ phase: 'provider-input-error', errorCode: errorCode(error) }))
      void send(worker.write, { id: worker.initializeId, method: 'initialize', params: initializeParams })
        .catch(worker.rejectReady)
    }
    worker.starting ??= (async () => {
      await worker.ready
      if (worker.closed || disposed) throw new Error('Native provider connection closed')
      await send(worker.write, { method: 'initialized', params: {} })
      if (worker.catalog) {
        try {
          worker.catalogCheckId = `cordisx-catalog-check-${randomUUID()}`
          const checked = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Native provider catalog check timed out')), 15000)
            worker.resolveCatalog = () => {
              clearTimeout(timer)
              resolve()
            }
            worker.rejectCatalog = error => {
              clearTimeout(timer)
              reject(error)
            }
          })
          await send(worker.write, {
            id: worker.catalogCheckId,
            method: 'config/read',
            params: { includeLayers: false },
          })
          await checked
          await verifyCatalog(worker.catalog)
          observe({ phase: 'managed-catalog-ready', provider: id })
        } catch (error) {
          if (workers.get(workerKey) === worker) workers.delete(workerKey)
          if (worker.child.exitCode === null) worker.child.kill('SIGTERM')
          throw error
        }
      }
    })()
    await worker.starting
    if (worker.closed || disposed) throw new Error('Native provider connection closed')
    return worker
  }

  const route = async (message, original) => {
    if (message.method === 'initialize') initializeParams = message.params
    if (message.method === undefined && serverRequests.has(message.id)) {
      const request = serverRequests.get(message.id)
      serverRequests.delete(message.id)
      return await send(request.connection.write, { ...message, id: request.id })
    }
    if (
      message.method === undefined && typeof message.id === 'string'
      && message.id.startsWith('cordisx-provider-request-')
    ) return
    const params = object(message.params)
    if (
      reviewRouting
      && ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'thread/settings/update'].includes(
        message.method,
      )
    ) {
      const owner = owners.get(params?.threadId), config = object(params?.config)
      const id = params?.modelProvider ?? config?.model_provider ?? owner?.providerId
      const model = params?.collaborationMode?.settings?.model ?? params?.model ?? config?.model ?? owner?.model
      if (config?.model_catalog_json !== undefined || config?.profile !== undefined) {
        throw new Error('REVIEW_NATIVE_CONFIG_CONFLICT')
      }
      if (id !== reviewRouting.providerId || config?.model_provider !== undefined && config.model_provider !== id) {
        throw new Error('REVIEW_PROVIDER_SCOPE_MISMATCH')
      }
      if (config?.model !== undefined && config.model !== model) throw new Error('REVIEW_NATIVE_CONFIG_CONFLICT')
      if (!reviewRouting.models.includes(model)) throw new Error('REVIEW_PARENT_MODEL_NOT_IN_CATALOG')
    }
    let connection = owners.get(params?.threadId)?.connection ?? primary
    if (
      onlyManagedRouting && connection !== primary && message.method === 'turn/start'
      && owners.get(params?.threadId)?.catalogState !== 'recorded'
    ) {
      throw new Error('MANAGED_CATALOG_HISTORY_UNAVAILABLE')
    }
    if (message.method === 'turn/start' && connection !== primary) await checkCurrentCatalog(connection)
    if (initializeParams && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)) {
      const config = object(params?.config)
      const tables = config ? Object.keys(config).filter(name => name.startsWith('model_providers.')) : []
      const id = provider(params?.modelProvider) ?? provider(config?.model_provider)
        ?? (tables.length === 1 ? provider(tables[0].slice('model_providers.'.length)) : undefined)
      const table = id && (object(config?.[`model_providers.${id}`]) ?? object(config?.model_providers?.[id]))
      if (id && id !== 'openai' && table?.wire_api === 'responses') {
        const previous = owners.get(params?.threadId)
        if (
          message.method === 'thread/resume' && previous?.providerId === id
          && previous.connection !== primary && !previous.connection.closed
        ) {
          if (onlyManagedRouting && previous.catalogState !== 'recorded') {
            throw new Error('MANAGED_CATALOG_HISTORY_UNAVAILABLE')
          }
          await checkCurrentCatalog(previous.connection)
          connection = previous.connection
        } else {
          const resolved = await currentCatalog(id)
          if (onlyManagedRouting && resolved.status === 'unmanaged') connection = primary
          else if (onlyManagedRouting && resolved.status === 'unavailable') {
            throw new Error('MANAGED_CATALOG_UNAVAILABLE')
          } else {
            if (
              onlyManagedRouting
              && (typeof readThreadCatalog !== 'function' || typeof recordThreadCatalog !== 'function')
            ) {
              await closeCatalog(resolved.catalog)
              throw new Error('MANAGED_CATALOG_UNAVAILABLE')
            }
            if (onlyManagedRouting && message.method === 'thread/resume') {
              let proof
              try {
                proof = await readThreadCatalog(params.threadId)
              } catch { /* Unknown proof fails closed. */ }
              if (!proof || proof.providerId !== id || proof.revision !== resolved.catalog?.revision) {
                await closeCatalog(resolved.catalog)
                throw new Error(proof ? 'MANAGED_CATALOG_CHANGED' : 'MANAGED_CATALOG_HISTORY_UNAVAILABLE')
              }
            }
            const source = message.method === 'thread/resume' ? unloaded.get(params.threadId) : undefined
            if (
              source && (source.providerId !== id
                || (source.catalog?.revision ?? null) !== (resolved.catalog?.revision ?? null))
            ) {
              await closeCatalog(resolved.catalog)
              throw new Error('MANAGED_CATALOG_CHANGED')
            }
            if (source && !source.closed) {
              await closeCatalog(resolved.catalog)
              connection = source
            } else {
              connection = await workerFor(id, resolved.catalog)
            }
          }
        }
      } else if (id === 'openai') connection = primary
    }
    if (connection !== primary && ['thread/start', 'thread/fork'].includes(message.method)) {
      await checkCurrentCatalog(connection)
    }
    if (disposed || connection.closed) throw new Error('Native provider connection closed')
    if (message.id !== undefined && message.method !== undefined) {
      connection.pending.set(key(message.id), { id: message.id, method: message.method, threadId: params?.threadId })
    }
    const write = connection === primary ? primaryWrite : connection.write
    await new Promise((resolve, reject) => write(original + '\n', error => error ? reject(error) : resolve()))
  }
  let fragments = []
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const input = chunk.toString('utf8')
      const frames = []
      let start = 0
      for (;;) {
        const boundary = input.indexOf('\n', start)
        const fragment = input.slice(start, boundary < 0 ? undefined : boundary)
        if (fragment.length > 0) fragments.push(fragment)
        if (boundary < 0) break
        const line = fragments.length === 1 ? fragments[0] : fragments.join('')
        fragments = []
        start = boundary + 1
        try {
          frames.push({ message: JSON.parse(line), original: line })
        } catch {
          primaryWrite(line + '\n')
        }
      }
      void (async () => {
        for (const { message: frame, original } of frames) {
          try {
            await route(frame, original)
          } catch (error) {
            if (frame.id !== undefined) {
              if (
                ![
                  'MANAGED_CATALOG_CHANGED',
                  'MANAGED_CATALOG_UNAVAILABLE',
                  'MANAGED_CATALOG_SOURCE_IN_USE',
                  'MANAGED_CATALOG_HISTORY_UNAVAILABLE',
                ].includes(
                  error?.message,
                )
              ) {
                uncertain?.(frame.id)
              }
              emit({
                id: frame.id,
                error: {
                  code: -32000,
                  message: error?.message === 'MANAGED_CATALOG_CHANGED'
                    ? 'Model metadata changed; this conversation cannot safely continue with its previous catalog.'
                    : error?.message === 'MANAGED_CATALOG_UNAVAILABLE'
                    ? 'Model metadata is unavailable. Contact an administrator or try again later.'
                    : error?.message === 'MANAGED_CATALOG_SOURCE_IN_USE'
                    ? 'The previous model worker did not stop safely. Contact an administrator.'
                    : error?.message === 'MANAGED_CATALOG_HISTORY_UNAVAILABLE'
                    ? "This conversation's model metadata cannot be verified. Contact an administrator."
                    : error?.message?.startsWith('REVIEW_')
                    ? error.message
                    : 'Native provider transport unavailable. Check thread history before retrying.',
                },
              })
            }
          }
        }
      })().then(() => callback(), callback)
    },
    final(callback) {
      primary.stdin.end(callback)
    },
  })
  const close = () => {
    if (disposed) return
    disposed = true
    for (const worker of workers.values()) {
      worker.rejectReady(new Error('Native provider transport disposed'))
      if (worker.child.exitCode === null) worker.child.kill('SIGTERM')
    }
    workers.clear()
    owners.clear()
    unloaded.clear()
    serverRequests.clear()
    fragments = []
    stdin.destroy()
    stdout.end()
  }
  primary.once('exit', close)
  return {
    stdin,
    stdout,
    close,
    workers: () => [...workers.values()].map(w => ({ providerId: w.providerId, pid: w.child.pid })),
  }
}
