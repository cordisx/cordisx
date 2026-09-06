import { randomUUID } from 'node:crypto'
import * as support from './cdp-installation-support.js'

export async function install(
  target: support.CdpTarget,
  source: string,
  provider?: { readonly fleet: support.ProviderFleet; readonly token: string },
  history?: { readonly host: support.CodexAgentHistoryHost; readonly token: string },
  config?: support.ConfigBridgeHandler,
  ownerDocuments?: support.OwnerDocumentBridgeHandler,
  serviceConfig?: support.ServiceConfigBridgeHandler,
  credential?: support.ChannelCredentialBridgeHandler,
  actions?: support.ChannelActionsBridgeHandler,
  permission?: support.PermissionPersistenceContext,
  iconThemePreference?: support.IconThemePreferencePersistenceContext,
  iconThemePreferenceBroadcast?: support.IconThemePreferenceBroadcastHub,
  lifecycle?: {
    readonly handler: support.PluginLifecycleBridgeHandler
    readonly runtime: support.CdpPluginLifecycleRuntime
  },
  developmentRuntime?: support.CdpPluginLifecycleRuntime,
  publisherGrant?: support.PublisherGrantBridgeHandler,
  certifiedPermission?: Readonly<{
    authority: support.LauncherMarketplaceCertifiedAuthority
    token: string
    profileId: string
    runtimeGeneration: string
  }>,
  newDocumentSource?: string,
  stale?: support.InstalledScript,
  viteDevelopment = false,
  loopbackModules = false,
  viteLoopbackPermissions?: support.ViteLoopbackPermissionCoordinator,
  signal?: AbortSignal,
  hostMutationGate?: support.CdpLifecycleRequestGate,
): Promise<support.InstalledScript> {
  if (iconThemePreferenceBroadcast !== undefined) {
    if (iconThemePreference === undefined) {
      throw new Error('icon theme preference broadcast requires persistence context')
    }
    iconThemePreferenceBroadcast.assertScope(iconThemePreference)
  }
  const url = target.webSocketDebuggerUrl
  if (url === undefined) throw new Error(`target ${target.id} has no websocket URL`)
  const session = await support.CdpSession.connect(url)
  const marketplaceController = new AbortController()
  const providerController = provider === undefined ? undefined : new AbortController()
  const historyController = history === undefined ? undefined : new AbortController()
  const configController = config === undefined ? undefined : new AbortController()
  const ownerDocumentController = ownerDocuments === undefined ? undefined : new AbortController()
  const serviceConfigController = serviceConfig === undefined ? undefined : new AbortController()
  const credentialController = credential === undefined ? undefined : new AbortController()
  const actionsController = actions === undefined ? undefined : new AbortController()
  const permissionController = permission === undefined ? undefined : new AbortController()
  const iconThemePreferenceController = iconThemePreference === undefined ? undefined : new AbortController()
  const lifecycleController = lifecycle === undefined ? undefined : new AbortController()
  const publisherGrantController = publisherGrant === undefined ? undefined : new AbortController()
  const lifecycleRequests = hostMutationGate ?? new support.CdpLifecycleRequestGate()
  let removeBindingListener = (): void => {}
  let removeProviderBindingListener = (): void => {}
  let removeHistoryBindingListener = (): void => {}
  let removeConfigBindingListener = (): void => {}
  let removeOwnerDocumentBindingListener = (): void => {}
  let removeServiceConfigBindingListener = (): void => {}
  let removeCredentialBindingListener = (): void => {}
  let removeActionsBindingListener = (): void => {}
  let removePermissionBindingListener = (): void => {}
  let removeIconThemePreferenceBindingListener = (): void => {}
  let unregisterCurrentIconThemeDocument: (() => void) | undefined
  let activeIconThemeDocumentController: AbortController | undefined
  let iconThemeDocumentFence = 0
  let iconThemeDocumentQueue = Promise.resolve()
  const iconThemeSessionId = randomUUID()
  const iconThemePreferenceClosed = (): boolean => iconThemePreferenceController?.signal.aborted === true
  const unregisterIconThemePreferenceBroadcast = iconThemePreferenceBroadcast === undefined
    ? undefined
    : (): void => {
      iconThemeDocumentFence += 1
      activeIconThemeDocumentController?.abort()
      activeIconThemeDocumentController = undefined
      unregisterCurrentIconThemeDocument?.()
      unregisterCurrentIconThemeDocument = undefined
    }
  let removeLifecycleBindingListener = (): void => {}
  let unregisterLifecycleSession = (): void => {}
  let generationJoin: ReturnType<support.CdpPluginLifecycleRuntime['beginJoin']> | undefined
  let removePublisherGrantBindingListener = (): void => {}
  let certifiedPermissionChannel: support.CdpCertifiedPermissionChannel | undefined
  let identifier: string | undefined
  let viteLoopbackPermission: { readonly name: string; readonly origin: string } | undefined
  let loopbackReloadStarted = false
  try {
    if (certifiedPermission !== undefined) {
      certifiedPermissionChannel = new support.CdpCertifiedPermissionChannel(session, {
        ...certifiedPermission,
        targetId: target.id,
      })
    }
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    if (loopbackModules) {
      viteLoopbackPermission = viteLoopbackPermissions === undefined
        ? await support.enableViteLoopbackPermission(session, target)
        : await viteLoopbackPermissions.acquire(session, target)
      await session.send('Page.setBypassCSP', { enabled: true })
    }
    if (stale !== undefined) {
      await session.send('Page.removeScriptToEvaluateOnNewDocument', {
        identifier: stale.identifier,
      }).catch(() => undefined)
      await Promise.allSettled(
        support.installedBindingNames(stale).map(async name => {
          await session.send('Runtime.removeBinding', { name })
        }),
      )
    }
    await session.send('Runtime.addBinding', { name: support.MARKETPLACE_BINDING })
    if (provider !== undefined) await session.send('Runtime.addBinding', { name: support.PROVIDER_BINDING })
    if (history !== undefined) await session.send('Runtime.addBinding', { name: support.AGENT_HISTORY_BINDING })
    if (config !== undefined) await session.send('Runtime.addBinding', { name: support.CONFIG_BINDING })
    if (ownerDocuments !== undefined) await session.send('Runtime.addBinding', { name: support.OWNER_DOCUMENT_BINDING })
    if (serviceConfig !== undefined) await session.send('Runtime.addBinding', { name: support.SERVICE_CONFIG_BINDING })
    if (credential !== undefined) await session.send('Runtime.addBinding', { name: support.CHANNEL_CREDENTIAL_BINDING })
    if (actions !== undefined) await session.send('Runtime.addBinding', { name: support.CHANNEL_ACTIONS_BINDING })
    if (permission !== undefined) await session.send('Runtime.addBinding', { name: support.PERMISSION_BINDING })
    if (iconThemePreference !== undefined) {
      await session.send('Runtime.addBinding', { name: support.ICON_THEME_PREFERENCE_BINDING })
    }
    if (lifecycle !== undefined) await session.send('Runtime.addBinding', { name: support.PLUGIN_LIFECYCLE_BINDING })
    if (publisherGrant !== undefined) {
      await session.send('Runtime.addBinding', { name: support.PUBLISHER_GRANT_BINDING })
    }
    let activeMarketplaceRequests = 0
    removeBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
      if (params.name !== support.MARKETPLACE_BINDING || typeof params.payload !== 'string') return
      const payload = params.payload
      void (async () => {
        let requestId = 'invalid'
        try {
          const requestValue = support.parseMarketplaceBindingRequest(JSON.parse(payload) as unknown)
          requestId = requestValue.requestId
          if (activeMarketplaceRequests >= support.MAX_MARKETPLACE_REQUESTS) {
            throw new Error('too many concurrent marketplace feed requests')
          }
          activeMarketplaceRequests += 1
          try {
            const response = await support.fetchMarketplaceFeed(requestValue.url, marketplaceController.signal)
            await support.sendMarketplaceBindingResponse(session, {
              requestId,
              ok: response.status >= 200 && response.status < 300,
              status: response.status,
              url: response.url,
              text: response.text,
            })
          } finally {
            activeMarketplaceRequests -= 1
          }
        } catch (error) {
          await support.sendMarketplaceBindingResponse(session, {
            requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => undefined)
        }
      })()
    })
    let activeProviderRequests = 0
    if (provider !== undefined) {
      removeProviderBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== support.PROVIDER_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > support.MAX_PROVIDER_REQUEST_BYTES) {
              throw new Error('provider request exceeds maximum size')
            }
            const request = support.parseProviderBindingRequest(JSON.parse(payload) as unknown, provider.token)
            requestId = request.requestId
            if (providerController?.signal.aborted === true) throw new Error('provider request bridge is closed')
            if (activeProviderRequests >= support.MAX_PROVIDER_REQUESTS) {
              throw new Error('too many concurrent provider requests')
            }
            activeProviderRequests += 1
            try {
              const value = await support.handleProviderBindingRequest(provider.fleet, request)
              await support.sendProviderBindingResponse(session, { requestId, ok: true, value })
            } finally {
              activeProviderRequests -= 1
            }
          } catch {
            await support.sendProviderBindingResponse(session, {
              requestId,
              ok: false,
              error: 'Provider request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activeHistoryRequests = 0
    if (history !== undefined) {
      removeHistoryBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== support.AGENT_HISTORY_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > support.MAX_AGENT_HISTORY_REQUEST_BYTES) {
              throw new Error('Agent history request exceeds maximum size')
            }
            const request = support.parseAgentHistoryBindingRequest(JSON.parse(payload) as unknown, history.token)
            requestId = request.requestId
            if (historyController?.signal.aborted === true) throw new Error('Agent history bridge is closed')
            if (activeHistoryRequests >= support.MAX_AGENT_HISTORY_REQUESTS) {
              throw new Error('too many concurrent Agent history requests')
            }
            activeHistoryRequests += 1
            try {
              const value = await support.handleAgentHistoryBindingRequest(history.host, request)
              await support.sendAgentHistoryBindingResponse(session, { requestId, ok: true, value })
            } finally {
              activeHistoryRequests -= 1
            }
          } catch {
            await support.sendAgentHistoryBindingResponse(session, {
              requestId,
              ok: false,
              error: 'Agent history request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activeConfigRequests = 0
    if (config !== undefined) {
      removeConfigBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== support.CONFIG_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > support.MAX_CONFIG_REQUEST_BYTES) {
              throw new Error('config request exceeds maximum size')
            }
            const request = support.parseConfigBindingRequest(
              JSON.parse(payload) as unknown,
              config.token,
              config.profileId,
              config.generation,
            )
            requestId = request.requestId
            if (configController?.signal.aborted === true) throw new Error('config request bridge is closed')
            if (activeConfigRequests >= 1) throw new Error('another config request is already active')
            activeConfigRequests += 1
            let value: unknown
            try {
              value = await lifecycleRequests.exclusive(async () => await config.handle(request))
            } finally {
              activeConfigRequests -= 1
            }
            await support.sendConfigBindingResponse(session, { requestId, ok: true, value })
          } catch (error) {
            await support.sendConfigBindingResponse(session, {
              requestId,
              ok: false,
              ...support.configBridgeError(error),
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activeOwnerDocumentRequests = 0
    if (ownerDocuments !== undefined) {
      removeOwnerDocumentBindingListener = session.onEvent('Runtime.bindingCalled', params => {
        if (params.name !== support.OWNER_DOCUMENT_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          let entityRequest = false
          try {
            if (Buffer.byteLength(payload) > support.MAX_OWNER_DOCUMENT_REQUEST_BYTES) {
              throw new Error('owner document request exceeds maximum size')
            }
            const parsed = JSON.parse(payload) as unknown
            const generic = parsed as { readonly requestId?: unknown }
            requestId = typeof generic.requestId === 'string' ? generic.requestId : 'invalid'
            entityRequest = support.isEntityBindingRequest(parsed)
            if (ownerDocumentController?.signal.aborted === true) throw new Error('owner document bridge is closed')
            if (activeOwnerDocumentRequests >= support.MAX_OWNER_DOCUMENT_REQUESTS) {
              throw new Error('too many owner document requests')
            }
            activeOwnerDocumentRequests += 1
            try {
              const value = entityRequest && ownerDocuments.entities !== undefined
                ? await ownerDocuments.entities.handle(parsed)
                : await (async () => {
                  const request = support.parseOwnerDocumentBindingRequest(parsed)
                  return request.operation === 'load'
                    ? await ownerDocuments.load(request)
                    : await ownerDocuments.replace(request)
                })()
              await support.sendOwnerDocumentBindingResponse(session, { requestId, ok: true, value })
            } finally {
              activeOwnerDocumentRequests -= 1
            }
          } catch (error) {
            if (entityRequest) {
              await support.sendOwnerDocumentBindingResponse(session, {
                requestId,
                ok: false,
                error: error instanceof Error ? error.message : 'entity request rejected',
              }).catch(() => undefined)
              return
            }
            await support.sendOwnerDocumentBindingResponse(session, {
              requestId,
              ok: true,
              value: support.ownerDocumentBridgeError(),
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activeServiceConfigRequests = 0
    if (serviceConfig !== undefined) {
      removeServiceConfigBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== support.SERVICE_CONFIG_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        const executionContextId = typeof params.executionContextId === 'number' ? params.executionContextId : undefined
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > support.MAX_SERVICE_CONFIG_REQUEST_BYTES) {
              throw new Error('service configuration request exceeds maximum size')
            }
            const request = support.parseServiceConfigBindingRequest(
              JSON.parse(payload) as unknown,
              serviceConfig.token,
              serviceConfig.profileId,
              serviceConfig.generation,
            )
            requestId = request.requestId
            if (serviceConfigController?.signal.aborted === true) {
              throw new Error('service configuration bridge is closed')
            }
            if (activeServiceConfigRequests >= 1) {
              throw new Error('another service configuration request is already active')
            }
            activeServiceConfigRequests += 1
            let value: unknown
            try {
              value = await lifecycleRequests.exclusive(async () => await serviceConfig.handle(request))
            } finally {
              activeServiceConfigRequests -= 1
            }
            // The renderer may immediately use a descriptor to submit its CAS
            // mutation. Release the single-flight seat before publishing the
            // response, otherwise that legitimate follow-up races its own
            // completed read and is incorrectly rejected as concurrent.
            await support.sendServiceConfigBindingResponse(session, { requestId, ok: true, value }, executionContextId)
          } catch (error) {
            await support.sendServiceConfigBindingResponse(
              session,
              { requestId, ok: false, ...support.serviceConfigBridgeError(error) },
              executionContextId,
            ).catch(() => undefined)
          }
        })()
      })
    }
    if (credential !== undefined) {
      removeCredentialBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== support.CHANNEL_CREDENTIAL_BINDING || typeof params.payload !== 'string') return
        void (async () => {
          const payload = params.payload as string
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > support.MAX_CHANNEL_CREDENTIAL_REQUEST_BYTES) {
              throw new Error('channel credential request exceeds maximum size')
            }
            const raw = JSON.parse(payload) as { requestId?: unknown }
            requestId = typeof raw.requestId === 'string' ? raw.requestId : requestId
            if (credentialController?.signal.aborted === true) throw new Error('channel credential bridge is closed')
            const value = await lifecycleRequests.exclusive(async () => await credential.handle(raw))
            await support.sendChannelCredentialBindingResponse(session, { requestId, ok: true, value })
          } catch {
            await support.sendChannelCredentialBindingResponse(session, {
              requestId,
              ok: false,
              code: 'channel-credential-unavailable',
            }).catch(() => undefined)
          }
        })()
      })
    }
    if (actions !== undefined) {
      removeActionsBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== support.CHANNEL_ACTIONS_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            const raw = JSON.parse(payload) as { requestId?: unknown }
            requestId = typeof raw.requestId === 'string' ? raw.requestId : requestId
            if (actionsController?.signal.aborted === true) throw new Error('channel action bridge is closed')
            const value = await lifecycleRequests.exclusive(async () => await actions.handle(raw))
            await support.sendChannelActionsBindingResponse(session, { requestId, ok: true, value })
          } catch {
            await support.sendChannelActionsBindingResponse(session, {
              requestId,
              ok: false,
              code: 'channel-action-unavailable',
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activePermissionRequests = 0
    if (permission !== undefined) {
      removePermissionBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== support.PERMISSION_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > support.MAX_PERMISSION_REQUEST_BYTES) {
              throw new Error('permission request exceeds maximum size')
            }
            const request = support.parsePermissionBindingRequest(JSON.parse(payload) as unknown, permission)
            requestId = request.requestId
            if (permissionController?.signal.aborted === true) {
              throw new Error('permission persistence bridge is closed')
            }
            if (activePermissionRequests >= support.MAX_PERMISSION_REQUESTS) {
              throw new Error('too many concurrent permission requests')
            }
            activePermissionRequests += 1
            try {
              const value = await lifecycleRequests.exclusive(
                async () => await support.persistPermissionPolicies(permission, request.records),
              )
              await support.sendPermissionBindingResponse(session, { requestId, ok: true, value })
            } finally {
              activePermissionRequests -= 1
            }
          } catch {
            await support.sendPermissionBindingResponse(session, {
              requestId,
              ok: false,
              error: 'Permission policy request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    let activeIconThemePreferenceRequests = 0
    if (iconThemePreference !== undefined) {
      removeIconThemePreferenceBindingListener = session.onEvent('Runtime.bindingCalled', (params) => {
        if (params.name !== support.ICON_THEME_PREFERENCE_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          let documentEpoch: string | undefined
          const executionContextId = typeof params.executionContextId === 'number'
            ? params.executionContextId
            : undefined
          try {
            if (Buffer.byteLength(payload) > support.MAX_ICON_THEME_PREFERENCE_REQUEST_BYTES) {
              throw new Error('icon theme preference request exceeds maximum size')
            }
            const raw = JSON.parse(payload) as unknown
            if (raw !== null && typeof raw === 'object' && (raw as { kind?: unknown }).kind === 'document-ready') {
              const ready = support.parseIconThemePreferenceDocumentReadyRequest(raw, iconThemePreference)
              requestId = ready.requestId
              documentEpoch = ready.documentEpoch
              if (executionContextId === undefined) {
                throw new Error('icon theme preference document execution context is unavailable')
              }
              if (iconThemePreferenceBroadcast === undefined) {
                throw new Error('icon theme preference broadcast is unavailable')
              }
              const previousController = activeIconThemeDocumentController
              const previousUnregister = unregisterCurrentIconThemeDocument
              const documentController = new AbortController()
              const reservation = iconThemePreferenceBroadcast.reserve({
                targetId: target.id,
                sessionId: iconThemeSessionId,
                documentEpoch: ready.documentEpoch,
                executionContextId,
                currentRevision: ready.currentRevision,
                signal: documentController.signal,
              })
              activeIconThemeDocumentController = documentController
              unregisterCurrentIconThemeDocument = reservation.cancel
              const fence = ++iconThemeDocumentFence
              previousController?.abort()
              previousUnregister?.()
              iconThemeDocumentQueue = iconThemeDocumentQueue.catch(() => undefined).then(async () => {
                if (
                  iconThemePreferenceClosed() || documentController.signal.aborted || fence !== iconThemeDocumentFence
                ) {
                  throw new Error('icon theme preference document ready request is stale')
                }
                const registration = await reservation.register({
                  receive: async preference =>
                    await support.deliverIconThemePreferenceToDocument(
                      session,
                      { kind: 'sync', value: preference },
                      ready.documentEpoch,
                      preference.revision,
                      executionContextId,
                      documentController.signal,
                    ),
                })
                if (
                  iconThemePreferenceClosed() || documentController.signal.aborted || fence !== iconThemeDocumentFence
                ) {
                  registration.unregister()
                  throw new Error('icon theme preference document ready request is stale')
                }
                const probeAck = await support.deliverIconThemePreferenceToDocument(
                  session,
                  { kind: 'document-ready-probe' },
                  ready.documentEpoch,
                  registration.currentRevision,
                  executionContextId,
                  documentController.signal,
                )
                await registration.respondReady(
                  probeAck,
                  async (status, lease): Promise<support.IconThemePreferenceReadyResponseAck> => {
                    const ack = await support.deliverIconThemePreferenceToDocument(
                      session,
                      {
                        kind: 'document-ready',
                        requestId: ready.requestId,
                        ok: true,
                        documentEpoch: ready.documentEpoch,
                        readyLeaseToken: lease.token,
                        readyLeaseRevision: lease.revision,
                        ...status,
                      },
                      ready.documentEpoch,
                      status.currentRevision,
                      executionContextId,
                      lease.signal,
                    )
                    if (ack.readyLeaseToken !== lease.token || ack.readyLeaseRevision !== lease.revision) {
                      throw new Error('icon theme preference ready response lease acknowledgement is invalid')
                    }
                    return {
                      documentEpoch: ack.documentEpoch,
                      currentRevision: ack.currentRevision,
                      readyLeaseToken: ack.readyLeaseToken,
                      readyLeaseRevision: ack.readyLeaseRevision,
                    }
                  },
                )
              })
              await iconThemeDocumentQueue
              return
            }
            const request = support.parseIconThemePreferenceBindingRequest(raw, iconThemePreference)
            requestId = request.requestId
            if (iconThemePreferenceController?.signal.aborted === true) {
              throw new Error('icon theme preference bridge is closed')
            }
            if (activeIconThemePreferenceRequests >= 1) {
              throw new Error('another icon theme preference request is active')
            }
            activeIconThemePreferenceRequests += 1
            let value
            try {
              value = await support.persistIconThemePreference(iconThemePreference, request)
            } finally {
              activeIconThemePreferenceRequests -= 1
            }
            const synchronization = iconThemePreferenceBroadcast === undefined
              ? 'pending'
              : (await iconThemePreferenceBroadcast.broadcast(value)).pending === 0
              ? 'complete'
              : 'pending'
            await support.sendIconThemePreferenceBindingResponse(session, {
              requestId,
              ok: true,
              value,
              synchronization,
            }, executionContextId)
          } catch (error) {
            const bridgeError = support.iconThemePreferenceBridgeError(error)
            let synchronization: 'complete' | 'pending' | undefined
            if (bridgeError.currentPreference !== undefined) {
              synchronization = iconThemePreferenceBroadcast === undefined
                ? 'pending'
                : (await iconThemePreferenceBroadcast.broadcast(bridgeError.currentPreference)).pending === 0
                ? 'complete'
                : 'pending'
            }
            if (documentEpoch !== undefined && executionContextId !== undefined) {
              await support.deliverIconThemePreferenceToDocument(
                session,
                {
                  kind: 'document-ready',
                  requestId,
                  ok: false,
                  documentEpoch,
                  currentRevision: 0,
                  ...bridgeError,
                },
                documentEpoch,
                0,
                executionContextId,
              ).catch(() => undefined)
            } else {
              await support.sendIconThemePreferenceBindingResponse(session, {
                requestId,
                ok: false,
                ...bridgeError,
                ...(synchronization === undefined ? {} : { synchronization }),
              }, executionContextId).catch(() => undefined)
            }
          }
        })()
      })
    }
    if (lifecycle !== undefined) {
      removeLifecycleBindingListener = session.onEvent('Runtime.bindingCalled', params => {
        if (params.name !== support.PLUGIN_LIFECYCLE_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > support.MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES) {
              throw new Error('plugin lifecycle request exceeds maximum size')
            }
            const request = support.parsePluginLifecycleBindingRequest(
              JSON.parse(payload) as unknown,
              lifecycle.handler,
            )
            requestId = request.requestId
            if (lifecycleController?.signal.aborted === true) throw new Error('plugin lifecycle bridge is closed')
            await lifecycleRequests.run(
              async () =>
                await support.runPluginLifecycleRequestWithProjection(
                  async () => await support.handlePluginLifecycleBindingRequest(lifecycle.handler, request),
                  request.kind !== 'bundle-snapshot-v1',
                  {
                    loadActive: async () => await lifecycle.handler.coordinator.store.loadActive(),
                    refreshBrowserGraphBootstrap: async active =>
                      await lifecycle.runtime.refreshBrowserGraphBootstrap(active),
                    ...(lifecycle.handler.bundleCoordinator === undefined ? {} : {
                      loadBundleSnapshot: async () => await lifecycle.handler.bundleCoordinator!.snapshot(),
                      synchronizePluginBundles: async snapshot =>
                        await lifecycle.runtime.synchronizePluginBundles(snapshot),
                    }),
                    terminal: error => lifecycle.runtime.terminal(error),
                  },
                ),
              async value => await support.sendPluginLifecycleBindingResponse(session, { requestId, ok: true, value }),
            )
          } catch {
            await support.sendPluginLifecycleBindingResponse(session, {
              requestId,
              ok: false,
              error: 'Plugin lifecycle request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    if (publisherGrant !== undefined) {
      removePublisherGrantBindingListener = session.onEvent('Runtime.bindingCalled', params => {
        if (params.name !== support.PUBLISHER_GRANT_BINDING || typeof params.payload !== 'string') return
        const payload = params.payload
        void (async () => {
          let requestId = 'invalid'
          try {
            if (Buffer.byteLength(payload) > support.MAX_PUBLISHER_GRANT_REQUEST_BYTES) {
              throw new Error('PublisherGrant request exceeds maximum size')
            }
            const request = support.parsePublisherGrantBindingRequest(JSON.parse(payload) as unknown)
            requestId = request.requestId
            if (publisherGrantController?.signal.aborted === true) throw new Error('PublisherGrant bridge is closed')
            const value = await publisherGrant.handle(request)
            await support.sendPublisherGrantBindingResponse(session, { requestId, ok: true, value })
          } catch {
            await support.sendPublisherGrantBindingResponse(session, {
              requestId,
              ok: false,
              error: 'PublisherGrant request was rejected',
            }).catch(() => undefined)
          }
        })()
      })
    }
    const generationRuntime = lifecycle?.runtime ?? developmentRuntime
    const reloadInstallId = viteDevelopment || loopbackModules ? randomUUID() : undefined
    const documentSource = newDocumentSource ?? source
    const productionDocumentSource = reloadInstallId === undefined || viteDevelopment
      ? undefined
      : support.productionBootstrapSource(documentSource, reloadInstallId)
    const added = await support.abortable(
      session.send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: reloadInstallId === undefined
            ? documentSource
            : viteDevelopment
            ? `globalThis.__cordisxViteInstallId = ${JSON.stringify(reloadInstallId)};\n${documentSource}`
            : productionDocumentSource!,
        },
        support.CDP_INJECTION_TIMEOUT_MS,
      ),
      signal,
    )
    identifier = added.identifier as string | undefined
    if (typeof identifier !== 'string') throw new Error('CDP did not return an injection identifier')
    if (viteDevelopment || loopbackModules) {
      const deadline = Date.now() + support.CDP_INJECTION_TIMEOUT_MS
      loopbackReloadStarted = true
      await support.reloadAndWaitForBootstrap(
        session,
        viteDevelopment ? { ignoreCache: true } : {},
        viteDevelopment
          ? async () => await support.waitForViteBootstrap(session, reloadInstallId!, deadline, signal)
          : async () => await support.waitForProductionBootstrap(session, reloadInstallId!, deadline, signal),
      )
    } else {
      const evaluated = await session.send(
        'Runtime.evaluate',
        {
          expression: source,
          allowUnsafeEvalBlockedByCSP: true,
        },
        support.CDP_INJECTION_TIMEOUT_MS,
      )
      const exception = support.runtimeEvaluationException(evaluated)
      if (exception !== undefined) {
        throw new Error(`CordisX renderer injection evaluation failed: ${exception}`)
      }
    }
    if (generationRuntime !== undefined || iconThemePreferenceBroadcast !== undefined) {
      await support.evaluateRuntimeOperation(
        session,
        `(async () => { try {
        const boot = globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot
        if (boot === undefined) {
          throw new Error('CordisX renderer composition and runtime boot promises are undefined after injection')
        }
        await boot
        if (globalThis.__cordisxRuntime === undefined) {
          throw new Error('CordisX renderer runtime is undefined after boot')
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }
      } })()`,
        support.CDP_INJECTION_TIMEOUT_MS,
      )
    }
    if (generationRuntime !== undefined) {
      // Reserve this boot-ready renderer before durable recovery. The
      // reservation participates in recovery RPCs while prepare/register stay
      // fenced until all recovered/private projections are synchronized.
      generationJoin = generationRuntime.beginJoin(session)
      if (lifecycle !== undefined) {
        await lifecycle.handler.coordinator.recover()
        await generationRuntime.synchronizeRecoveredActivation(session)
        if (lifecycle.handler.bundleCoordinator !== undefined) {
          await generationRuntime.synchronizePluginBundlesFor(
            session,
            await lifecycle.handler.bundleCoordinator.snapshot(),
          )
        }
      }
      // It becomes a normal generation participant only after its bootstrap
      // and recovered/private projections are ready. Committing the reserved
      // join is atomic with respect to prepare/register.
      while (true) {
        const developmentVersion = await generationRuntime.synchronizeDevelopmentStatus(session)
        const unregister = generationJoin.commit(developmentVersion)
        if (unregister === undefined) continue
        unregisterLifecycleSession = unregister
        break
      }
      generationJoin = undefined
    }
    return {
      target,
      ...(viteDevelopment ? { viteDevelopment: true } : {}),
      ...(loopbackModules ? { loopbackModules: true } : {}),
      ...(viteLoopbackPermission === undefined ? {} : { viteLoopbackPermission }),
      identifier,
      documentSource,
      session,
      marketplaceController,
      removeBindingListener,
      ...(providerController === undefined ? {} : { providerController, removeProviderBindingListener }),
      providerBindingInstalled: provider !== undefined,
      ...(historyController === undefined ? {} : { historyController, removeHistoryBindingListener }),
      historyBindingInstalled: history !== undefined,
      ...(configController === undefined ? {} : { configController, removeConfigBindingListener }),
      configBindingInstalled: config !== undefined,
      ...(ownerDocumentController === undefined ? {} : { ownerDocumentController, removeOwnerDocumentBindingListener }),
      ownerDocumentBindingInstalled: ownerDocuments !== undefined,
      ...(serviceConfigController === undefined ? {} : { serviceConfigController, removeServiceConfigBindingListener }),
      serviceConfigBindingInstalled: serviceConfig !== undefined,
      ...(credentialController === undefined ? {} : { credentialController, removeCredentialBindingListener }),
      credentialBindingInstalled: credential !== undefined,
      ...(actionsController === undefined ? {} : { actionsController, removeActionsBindingListener }),
      actionsBindingInstalled: actions !== undefined,
      ...(permissionController === undefined ? {} : { permissionController, removePermissionBindingListener }),
      permissionBindingInstalled: permission !== undefined,
      ...(iconThemePreferenceController === undefined
        ? {}
        : { iconThemePreferenceController, removeIconThemePreferenceBindingListener }),
      iconThemePreferenceBindingInstalled: iconThemePreference !== undefined,
      ...(unregisterIconThemePreferenceBroadcast === undefined ? {} : { unregisterIconThemePreferenceBroadcast }),
      ...(lifecycleController === undefined ? {} : { lifecycleController, removeLifecycleBindingListener }),
      lifecycleBindingInstalled: lifecycle !== undefined,
      unregisterLifecycleSession,
      ...(publisherGrantController === undefined
        ? {}
        : { publisherGrantController, removePublisherGrantBindingListener }),
      publisherGrantBindingInstalled: publisherGrant !== undefined,
      ...(certifiedPermissionChannel === undefined ? {} : { certifiedPermissionChannel }),
    }
  } catch (error) {
    const strictProductionCleanup = loopbackModules && !viteDevelopment
    const cleanupFailures: unknown[] = []
    const attemptCleanup = async (operation: Promise<unknown>): Promise<boolean> => {
      try {
        await operation
        return true
      } catch (cleanupError) {
        if (strictProductionCleanup) cleanupFailures.push(cleanupError)
        return false
      }
    }
    marketplaceController.abort()
    providerController?.abort()
    historyController?.abort()
    configController?.abort()
    ownerDocumentController?.abort()
    serviceConfigController?.abort()
    credentialController?.abort()
    actionsController?.abort()
    permissionController?.abort()
    iconThemePreferenceController?.abort()
    lifecycleController?.abort()
    publisherGrantController?.abort()
    removeBindingListener()
    removeProviderBindingListener()
    removeHistoryBindingListener()
    removeConfigBindingListener()
    removeOwnerDocumentBindingListener()
    removeServiceConfigBindingListener()
    removeCredentialBindingListener()
    removeActionsBindingListener()
    removePermissionBindingListener()
    removeIconThemePreferenceBindingListener()
    unregisterIconThemePreferenceBroadcast?.()
    removeLifecycleBindingListener()
    generationJoin?.abort()
    unregisterLifecycleSession()
    removePublisherGrantBindingListener()
    await certifiedPermissionChannel?.dispose()
    const scriptRemoved = identifier === undefined
      || await attemptCleanup(session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }))
    if (viteDevelopment) {
      await attemptCleanup(session.send('Runtime.evaluate', {
        expression: support.VITE_DISPOSE_EXPRESSION,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      }))
    } else if (loopbackModules) {
      await attemptCleanup(
        support.evaluateRuntimeOperation(
          session,
          support.RENDERER_DISPOSE_EXPRESSION,
          support.CDP_INJECTION_TIMEOUT_MS,
        ),
      )
    }
    const cspRestored = !loopbackModules
      || await attemptCleanup(session.send('Page.setBypassCSP', { enabled: false }))
    if (viteLoopbackPermissions === undefined) {
      await attemptCleanup(support.restoreViteLoopbackPermission(session, viteLoopbackPermission))
    } else await attemptCleanup(viteLoopbackPermissions.release(session, viteLoopbackPermission))
    if (loopbackModules && !viteDevelopment && loopbackReloadStarted && scriptRemoved && cspRestored) {
      await attemptCleanup(session.send('Page.reload', {}, support.CDP_INJECTION_TIMEOUT_MS))
    }
    session.close()
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `CordisX production renderer installation failed and cleanup was incomplete: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    throw error
  }
}
