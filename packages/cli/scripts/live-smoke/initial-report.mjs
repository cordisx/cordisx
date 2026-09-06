export async function readInitialReport({
  send,
}) {
  const evaluated = await send('Runtime.evaluate', {
    expression: `(() => {
      const runtime = globalThis.__cordisxRuntime
      const snapshot = runtime?.snapshot?.()
      const panel = document.querySelector('[data-cordisx-demo-marker]')
        ?? document.querySelector('[data-cordisx-contribution="hello-toolbar.panel"] section')
      const rect = panel?.getBoundingClientRect()
      return {
        title: document.title,
        url: location.href,
        ready: document.documentElement.dataset.cordisxReady === 'true',
        version: runtime?.version ?? null,
        pluginIds: runtime?.pluginIds ?? [],
        pluginStates: snapshot?.plugins?.map(plugin => ({ id: plugin.id, status: plugin.status })) ?? [],
        platform: snapshot?.platform ?? null,
        permissions: snapshot?.permissions?.map(permission => ({
          pluginId: permission.identity.id,
          capability: permission.capability,
          required: permission.required,
          policy: permission.policy,
          reasonText: permission.reasonText,
          scope: permission.scope,
          lastRequested: permission.lastRequested ?? null,
          denialCount: permission.denialCount,
          availability: permission.availability,
        })) ?? [],
        capabilityProviders: snapshot?.capabilityProviders ?? [],
        serviceConfigBinding: {
          request: typeof globalThis.__cordisxServiceConfigRequestV1,
          receiver: typeof globalThis.__cordisxServiceConfigReceiveV1,
        },
        surfaceClick: globalThis.__cordisxSmokeSurfaceClick ?? null,
        localization: snapshot?.localization ?? null,
        contributions: snapshot?.registrations?.map(item => ({
          owner: item.owner, surface: item.surface, id: item.id, valid: item.valid,
          visible: item.visible, rendered: item.rendered, pending: item.pending,
          error: item.error ?? null,
        })) ?? [],
        commands: snapshot?.commands?.map(command => ({ id: command.qualifiedId, running: command.running, error: command.error ?? null })) ?? [],
        routes: snapshot?.navigation?.routes?.map(route => ({ id: route.qualifiedId, valid: route.valid, error: route.error ?? null })) ?? [],
        pages: snapshot?.navigation?.pages?.map(page => page.qualifiedId) ?? [],
        outlets: snapshot?.navigation?.outlets?.map(outlet => ({
          id: outlet.id, available: outlet.available, contextKey: outlet.contextKey ?? null,
          placement: outlet.placement, mounted: outlet.mounted, activeRoute: outlet.activeRoute ?? null,
          error: outlet.error ?? null,
        })) ?? [],
        native: {
          mainAnchors: document.querySelectorAll('[data-app-shell-main-content-layout="thread-edge-scroll"]').length,
          sessionAnchors: document.querySelectorAll('[data-codex-thread-reference-drop-target]').length,
          selectedThread: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
          threadRows: document.querySelectorAll('[data-app-action-sidebar-thread-id]').length,
          rightPanels: document.querySelectorAll('[data-pip-home-surface="thread-summary-panel"]').length,
          bottomPanels: document.querySelectorAll('[data-panel-location="bottom"], [data-bottom-panel]').length,
          responseMarkers: [...document.querySelectorAll('[data-response-annotation-conversation]')].map(element => ({
            sessionId: element.getAttribute('data-response-annotation-conversation'),
            visible: element.getClientRects().length > 0,
            ancestors: [...function * () { for (let current = element.parentElement, depth = 0; current !== null && depth < 20; current = current.parentElement, depth += 1) yield current }()]
              .map(current => ({ tag: current.tagName.toLowerCase(), data: Object.fromEntries([...current.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value])) })),
          })),
          composerMarkers: [...document.querySelectorAll('[data-above-composer-conversation-id]')].map(element => ({
            sessionId: element.getAttribute('data-above-composer-conversation-id'),
            visible: element.getClientRects().length > 0,
            ancestors: [...function * () { for (let current = element.parentElement, depth = 0; current !== null && depth < 20; current = current.parentElement, depth += 1) yield current }()]
              .map(current => ({ tag: current.tagName.toLowerCase(), data: Object.fromEntries([...current.attributes].filter(attribute => attribute.name.startsWith('data-')).map(attribute => [attribute.name, attribute.value])) })),
          })),
          sessionAnchorProbe: (() => {
            const selectedRaw = document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id')
            const sessionId = selectedRaw?.startsWith('local:') ? selectedRaw.slice('local:'.length) : null
            const rect = (element) => {
              const value = element.getBoundingClientRect()
              return { x: value.x, y: value.y, width: value.width, height: value.height }
            }
            const data = (element) => Object.fromEntries([...element.attributes]
              .filter(attribute => attribute.name.startsWith('data-') && !attribute.name.startsWith('data-cordisx-'))
              .map(attribute => [attribute.name, attribute.value]))
            const response = sessionId === null ? [] : [...document.querySelectorAll('[data-response-annotation-conversation]')]
              .filter(element => element.getAttribute('data-response-annotation-conversation') === sessionId)
            const composer = sessionId === null ? [] : [...document.querySelectorAll('[data-above-composer-conversation-id]')]
              .filter(element => element.getAttribute('data-above-composer-conversation-id') === sessionId)
            const semantic = [...document.querySelectorAll('[data-pip-anchor-host="codex-main-thread"][data-app-action-timeline-scroll]')]
              .map((element, index) => {
                const responseMatches = sessionId === null ? 0 : [...element.querySelectorAll('[data-response-annotation-conversation]')]
                  .filter(marker => marker.getAttribute('data-response-annotation-conversation') === sessionId).length
                const composerMatches = sessionId === null ? 0 : [...element.querySelectorAll('[data-above-composer-conversation-id]')]
                  .filter(marker => marker.getAttribute('data-above-composer-conversation-id') === sessionId).length
                const value = element.getBoundingClientRect()
                return {
                  index, data: data(element), rect: rect(element), visible: element.getClientRects().length > 0 && value.width > 0 && value.height > 0,
                  responseMatches, composerMatches, joined: responseMatches === 1 && composerMatches === 1,
                }
              })
            let commonAncestor = null
            if (response.length === 1 && composer.length === 1) {
              const composerAncestors = new Set(function * () { for (let current = composer[0]; current !== null; current = current.parentElement) yield current }())
              const candidate = [...function * () { for (let current = response[0]; current !== null; current = current.parentElement) yield current }()]
                .find(element => composerAncestors.has(element))
              if (candidate !== undefined) commonAncestor = {
                tag: candidate.tagName.toLowerCase(), data: data(candidate), rect: rect(candidate),
                semantic: candidate.matches('[data-pip-anchor-host="codex-main-thread"][data-app-action-timeline-scroll]'),
              }
            }
            return {
              selectedRaw: selectedRaw ?? null, sessionId, responseMatches: response.length, composerMatches: composer.length,
              legacyCandidates: document.querySelectorAll('[data-codex-thread-reference-drop-target]').length,
              semanticCandidates: semantic, commonAncestor,
            }
          })(),
          sessionCandidates: [...document.querySelectorAll('[data-codex-thread-reference-drop-target]')].map((element, index) => {
            const rect = element.getBoundingClientRect()
            return {
              index, connected: element.isConnected, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              display: getComputedStyle(element).display,
              visibility: getComputedStyle(element).visibility,
              responseSession: element.querySelector('[data-response-annotation-conversation]')?.getAttribute('data-response-annotation-conversation') ?? null,
              composerSession: element.querySelector('[data-above-composer-conversation-id]')?.getAttribute('data-above-composer-conversation-id') ?? null,
            }
          }),
        },
        controls: [...document.querySelectorAll('button')].map(button => ({
          label: button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent?.trim() ?? '',
          pressed: button.getAttribute('aria-pressed'),
          expanded: button.getAttribute('aria-expanded'),
        })).filter(item => item.label !== '').slice(0, 120),
        separators: [...document.querySelectorAll('[role="separator"]')].map(separator => {
          const rect = separator.getBoundingClientRect()
          return { orientation: separator.getAttribute('aria-orientation'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }),
        threadCandidates: [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')].filter(element => element.getClientRects().length > 0).slice(0, 8).map(element => ({
          id: element.getAttribute('data-app-action-sidebar-thread-id'),
          text: element.textContent?.trim().slice(0, 120) ?? '',
          selected: element.getAttribute('data-app-action-sidebar-thread-selected'),
        })),
        managerTrigger: document.querySelector('[data-cordisx-manager-trigger]') !== null,
        marker: panel?.getAttribute('data-cordisx-demo-marker')
          ?? panel?.querySelector('strong')?.textContent
          ?? null,
        markerRect: rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }
    })()`,
    returnByValue: true,
  })

  const report = evaluated.result?.value

  if (report === undefined) throw new Error('CDP evaluation returned no report')

  console.log(JSON.stringify(report, null, 2))

  return { report }
}
