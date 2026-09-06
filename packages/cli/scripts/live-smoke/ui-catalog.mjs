import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
export async function runUiCatalogExercises({
  values,
  evaluateByValue,
  report,
  capture,
  send,
  pointerClick,
}) {
  let uiCatalogReport

  if (values['ui-catalog']) {
    uiCatalogReport = await evaluateByValue(
      `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (predicate()) return true
          await wait(50)
        }
        return false
      }
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) return { result: 'fail', error: 'CordisX runtime is unavailable', assertions: [] }
      document.querySelector('.cxm-close')?.click()
      for (const page of document.querySelectorAll('[data-cordisx-page]')) page.querySelector('button[aria-label="Close"]')?.click()
      await wait(120)
      const rect = element => {
        const value = element?.getBoundingClientRect()
        return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom }
      }
      const visible = element => {
        if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false
        const value = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return value.width > 0 && value.height > 0 && value.right > 0 && value.bottom > 0
          && value.left < innerWidth && value.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const selectorFor = key => '[data-cordisx-surface-host="' + key + '"]'
      const pointConfig = [{
        id: 'session.header.actions', key: 'session.header.actions', contributionId: 'slot-showcase:trace',
      }, {
        id: 'composer.toolbar.items', key: 'composer.submit.before', contributionId: 'slot-showcase:submit-before',
      }]
      const rootFor = config => document.querySelector(selectorFor(config.key))
      const contributionFor = config => rootFor(config)?.querySelector('[data-cordisx-contribution-id="' + CSS.escape(config.contributionId) + '"]') ?? null
      await waitFor(() => pointConfig.every(config => visible(rootFor(config))), 'initial extension seats')
      const nativeFor = root => {
        const anchor = root?.nextSibling
        if (!(anchor instanceof HTMLElement)) return { anchor: null, control: null }
        return { anchor, control: anchor.matches('button') ? anchor : anchor.querySelector('button') }
      }
      const initial = new Map(pointConfig.map(config => {
        const root = rootFor(config)
        const native = nativeFor(root)
        return [config.id, { root, nativeAnchor: native.anchor, nativeControl: native.control, nativeParent: native.anchor?.parentElement ?? null }]
      }))
      const mutation = { cordisxChildChanges: 0, unexpectedChildChanges: 0, nativeAttributeChanges: 0 }
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes') mutation.nativeAttributeChanges += 1
          else {
            const changed = [...record.addedNodes, ...record.removedNodes]
            if (changed.every(node => node instanceof HTMLElement && node.matches('[data-cordisx-surface-host]'))) mutation.cordisxChildChanges += 1
            else mutation.unexpectedChildChanges += 1
          }
        }
      })
      for (const value of initial.values()) {
        if (value.nativeParent !== null) observer.observe(value.nativeParent, { childList: true })
        if (value.nativeControl !== null) observer.observe(value.nativeControl, { attributes: true, attributeFilter: ['style', 'hidden', 'aria-hidden'] })
      }
      const plugin = runtime.snapshot().plugins.find(item => item.id === 'slot-showcase')
      const policyTransitions = []
      if (plugin !== undefined && typeof runtime.setExtensionPointPolicy === 'function') {
        for (const config of pointConfig) {
          const before = initial.get(config.id)
          const original = runtime.snapshot().extensionPoints.policies.find(item => item.identity.source === plugin.source
            && item.identity.pluginId === 'slot-showcase' && item.identity.pointId === config.id)?.policy ?? 'inherit'
          try {
            await runtime.setExtensionPointPolicy(plugin.source, 'slot-showcase', config.id, 'deny')
            const hidden = await waitFor(() => contributionFor(config) === null
              && runtime.snapshot().registrations.find(item => item.owner === 'slot-showcase' && item.surface === config.id)?.authorized === false, config.id + ' deny')
            const nativeWhileDenied = before?.nativeControl?.isConnected === true
              && before.nativeAnchor?.parentElement === before.nativeParent && visible(before.nativeControl)
            await runtime.setExtensionPointPolicy(plugin.source, 'slot-showcase', config.id, 'allow')
            const restored = await waitFor(() => visible(contributionFor(config)), config.id + ' allow')
            const after = rootFor(config)
            policyTransitions.push({ id: config.id, original, hidden, restored, sameSeat: after === before?.root,
              nativeWhileDenied, sameNative: nativeFor(after).control === before?.nativeControl,
              sameNativeParent: before?.nativeAnchor?.parentElement === before?.nativeParent })
          } finally {
            await runtime.setExtensionPointPolicy(plugin.source, 'slot-showcase', config.id, original)
            if (original !== 'deny') await waitFor(() => visible(contributionFor(config)), config.id + ' policy restore')
          }
        }
      }
      let pluginBlock = null
      if (typeof runtime.setPluginBlocked === 'function') {
        await runtime.setPluginBlocked('slot-showcase', true)
        const blocked = await waitFor(() => pointConfig.every(config => contributionFor(config) === null)
          && runtime.snapshot().plugins.find(item => item.id === 'slot-showcase')?.status === 'blocked', 'plugin block')
        const nativeWhileBlocked = pointConfig.every(config => {
          const before = initial.get(config.id)
          return before?.nativeControl?.isConnected === true && before.nativeAnchor?.parentElement === before.nativeParent
            && visible(before.nativeControl)
        })
        await runtime.setPluginBlocked('slot-showcase', false)
        const restored = await waitFor(() => pointConfig.every(config => visible(contributionFor(config)))
          && runtime.snapshot().plugins.find(item => item.id === 'slot-showcase')?.status === 'active', 'plugin restore')
        const sameNative = pointConfig.every(config => nativeFor(rootFor(config)).control === initial.get(config.id)?.nativeControl)
        pluginBlock = { blocked, nativeWhileBlocked, restored, sameNative }
      }
      observer.disconnect()
      const snapshot = runtime.snapshot()
      const points = pointConfig.map(config => {
        const root = rootFor(config)
        const native = nativeFor(root)
        const rootRect = rect(root)
        const nativeRect = rect(native.control)
        const parentRect = rect(root?.parentElement)
        const style = root === null ? null : getComputedStyle(root)
        const action = contributionFor(config) ?? root?.querySelector('button') ?? null
        const actionStyle = action === null ? null : getComputedStyle(action)
        const point = snapshot.extensionPoints.points.find(item => item.id === config.id)
        const registration = snapshot.registrations.find(item => item.owner === 'slot-showcase' && item.surface === config.id)
        const insideViewport = rootRect !== null && rootRect.x >= 0 && rootRect.y >= 0 && rootRect.right <= innerWidth && rootRect.bottom <= innerHeight
        const nonOverlapping = rootRect !== null && nativeRect !== null && rootRect.right <= nativeRect.x + 0.5
        return {
          id: config.id, key: config.key, contributionId: config.contributionId,
          availability: point === undefined ? null : { stability: point.stability, availability: point.availability, available: point.available,
            code: point.availabilityCode ?? null, detail: point.availabilityDetail ?? null, anchors: point.anchors ?? [] },
          registration: registration === undefined ? null : { valid: registration.valid, authorized: registration.authorized,
            visible: registration.visible, rendered: registration.rendered, pending: registration.pending, error: registration.error ?? null },
          candidateCount: document.querySelectorAll(selectorFor(config.key)).length,
          relationship: { sameParent: root?.parentElement === native.anchor?.parentElement, beforeNative: root?.nextSibling === native.anchor,
            nativeConnected: native.control?.isConnected ?? false, nativeParentConnected: native.anchor?.parentElement?.isConnected ?? false },
          geometry: { root: rootRect, native: nativeRect, parent: parentRect, nonOverlapping },
          hostNativeAvailable: rootRect !== null && nativeRect !== null,
          computed: { display: style?.display ?? null, position: style?.position ?? null, transform: style?.transform ?? null,
            appRegion: style?.getPropertyValue('-webkit-app-region') ?? null, actionAppRegion: actionStyle?.getPropertyValue('-webkit-app-region') ?? null },
          a11y: { actionLabel: action?.getAttribute('aria-label') ?? null, tooltipText: action?.dataset.cordisxTooltip ?? null,
            noDragData: root?.dataset.cordisxNoDrag ?? null },
          viewport: { width: innerWidth, height: innerHeight, inside: insideViewport },
          captureRect: rootRect === null || nativeRect === null ? null : {
            x: Math.min(rootRect.x, nativeRect.x), y: Math.min(rootRect.y, nativeRect.y),
            width: Math.max(rootRect.right, nativeRect.right) - Math.min(rootRect.x, nativeRect.x),
            height: Math.max(rootRect.bottom, nativeRect.bottom) - Math.min(rootRect.y, nativeRect.y),
          },
        }
      })
      const iconControls = [...document.querySelectorAll('[data-cordisx-surface-host] .cordisx-native-icon-action')]
        .filter(visible)
        .map(action => {
          const root = action.closest('[data-cordisx-surface-host]')
          const wrapper = action.querySelector('.cordisx-host-icon')
          const glyph = wrapper?.querySelector('svg') ?? null
          const actionRect = rect(action)
          const wrapperRect = rect(wrapper)
          const glyphRect = rect(glyph)
          const actionStyle = getComputedStyle(action)
          const reduced = action.classList.contains('cordisx-icon-only-control')
          const compact = action.classList.contains('cordisx-shortcut-action')
          const expectedGlyphSize = reduced ? (compact ? 12 : 16) : null
          const centered = wrapperRect !== null && glyphRect !== null
            && Math.abs((wrapperRect.x + wrapperRect.width / 2) - (glyphRect.x + glyphRect.width / 2)) <= 0.5
            && Math.abs((wrapperRect.y + wrapperRect.height / 2) - (glyphRect.y + glyphRect.height / 2)) <= 0.5
          return {
            surface: root?.dataset.cordisxSurfaceHost ?? null,
            label: action.getAttribute('aria-label'),
            reduced,
            compact,
            expectedGlyphSize,
            token: actionStyle.getPropertyValue('--cordisx-icon-only-glyph-size').trim(),
            geometry: { action: actionRect, wrapper: wrapperRect, glyph: glyphRect, centered },
          }
        })
      const managerTrigger = document.querySelector('[data-cordisx-manager-trigger]')
      const managerMark = managerTrigger?.querySelector('[data-cordisx-brand-mark]') ?? null
      const managerActionRect = rect(managerTrigger)
      const managerGlyphRect = rect(managerMark)
      const managerBrand = {
        reduced: managerTrigger?.classList.contains('cordisx-icon-only-control') ?? false,
        geometry: { action: managerActionRect, glyph: managerGlyphRect,
          centered: managerActionRect !== null && managerGlyphRect !== null
            && Math.abs((managerActionRect.x + managerActionRect.width / 2) - (managerGlyphRect.x + managerGlyphRect.width / 2)) <= 0.5
            && Math.abs((managerActionRect.y + managerActionRect.height / 2) - (managerGlyphRect.y + managerGlyphRect.height / 2)) <= 0.5 },
      }
      const assertions = []
      const assert = (id, pass, actual, expected, skipped = false) => assertions.push({ id, pass: Boolean(pass), actual, expected, ...(skipped ? { skipped: true } : {}) })
      for (const point of points) {
        if (!point.hostNativeAvailable) {
          assert(point.id + '.session-unavailable', true,
            { availability: point.availability, registration: point.registration, geometry: point.geometry },
            'skipped because the clean isolated renderer has no native session anchor', true)
          continue
        }
        assert(point.id + '.unique-seat', point.candidateCount === 1, point.candidateCount, 1)
        assert(point.id + '.rendered', point.registration?.rendered === true, point.registration, 'rendered=true')
        assert(point.id + '.sibling-before-native', point.relationship.sameParent && point.relationship.beforeNative, point.relationship, 'same parent and immediate preceding sibling')
        assert(point.id + '.normal-flow', point.computed.position === 'static' && point.computed.transform === 'none', point.computed, 'position=static, transform=none')
        assert(point.id + '.native-continuity', point.relationship.nativeConnected && point.relationship.nativeParentConnected, point.relationship, 'native node and parent connected')
        assert(point.id + '.non-overlap', point.geometry.nonOverlapping, point.geometry, 'CordisX root ends before native control')
        assert(point.id + '.no-drag', point.a11y.noDragData === 'true' && point.computed.appRegion === 'no-drag'
          && point.computed.actionAppRegion === 'no-drag', { a11y: point.a11y, computed: point.computed }, 'root/action no-drag')
        assert(point.id + '.viewport', point.viewport.inside, point.viewport, 'inside viewport')
      }
      for (const transition of policyTransitions) {
        if (points.find(point => point.id === transition.id)?.hostNativeAvailable !== true) {
          assert(transition.id + '.policy-hide-restore', true, transition,
            'skipped because the clean isolated renderer has no native session anchor', true)
          continue
        }
        assert(transition.id + '.policy-hide-restore', transition.hidden && transition.restored && transition.nativeWhileDenied
          && transition.sameNative && transition.sameNativeParent, transition, 'hide/restore without changing native control')
      }
      assert('native.no-unexpected-child-mutations', mutation.unexpectedChildChanges === 0, mutation, 'only CordisX seat child changes')
      assert('native.no-attribute-mutations', mutation.nativeAttributeChanges === 0, mutation, 'no native style/hidden/aria-hidden mutations')
      const nativeSurfaceUnavailable = points.some(point => !point.hostNativeAvailable)
      assert('plugin.block-restore', nativeSurfaceUnavailable || (pluginBlock?.blocked === true && pluginBlock.nativeWhileBlocked === true
        && pluginBlock.restored === true && pluginBlock.sameNative === true), pluginBlock,
      nativeSurfaceUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'plugin block/restore without changing native controls', nativeSurfaceUnavailable)
      for (const control of iconControls.filter(item => item.reduced)) {
        const expectedToken = control.expectedGlyphSize + 'px'
        assert('icon.' + control.surface + '.' + control.label + '.glyph-size', control.token === expectedToken
          && control.geometry.glyph?.width === control.expectedGlyphSize && control.geometry.glyph?.height === control.expectedGlyphSize,
        control, 'host token and rendered glyph are exactly ' + expectedToken)
        assert('icon.' + control.surface + '.' + control.label + '.hit-area', (control.geometry.action?.width ?? 0) >= 24
          && (control.geometry.action?.height ?? 0) >= 24, control.geometry.action, 'button hit area remains at least 24x24')
        assert('icon.' + control.surface + '.' + control.label + '.centered', control.geometry.centered,
          control.geometry, 'glyph is horizontally and vertically centered in its unchanged wrapper')
      }
      const composerControl = iconControls.find(item => item.surface === 'composer.submit.before')
      assert('composer.toolbar.items.appearance-preserved', nativeSurfaceUnavailable || (composerControl?.reduced === false && composerControl?.token === ''
        && composerControl.geometry.glyph?.width === 16 && composerControl.geometry.glyph?.height === 16),
      composerControl, nativeSurfaceUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'composer keeps its existing 16px glyph and does not opt into the shell reduction', nativeSurfaceUnavailable)
      assert('manager.brand-trigger.size-preserved', nativeSurfaceUnavailable || (managerBrand.reduced === false && managerBrand.geometry.action?.width === 32
        && managerBrand.geometry.action?.height === 32 && managerBrand.geometry.glyph?.width === 20 && managerBrand.geometry.glyph?.height === 20
        && managerBrand.geometry.centered),
      managerBrand, nativeSurfaceUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'brand trigger remains a 20px mark in its 32px button', nativeSurfaceUnavailable)
      const titlebar = [...document.querySelectorAll('header[data-app-shell-application-menu-bar]')].find(visible)
      const titlebarRect = rect(titlebar)
      const safeLeft = titlebarRect === null ? null : Math.max(12, Math.ceil(Math.min(...[...titlebar.querySelectorAll('button')]
        .filter(visible).map(button => button.getBoundingClientRect().x).filter(x => x >= titlebarRect.x + 64 && x < titlebarRect.x + 180), titlebarRect.x + 88) - titlebarRect.x))
      const sessionPoint = points.find(point => point.id === 'session.header.actions')
      assert('session.header.actions.safe-inset', nativeSurfaceUnavailable || (safeLeft !== null && sessionPoint?.geometry.root?.x >= safeLeft),
        { safeLeft, rootX: sessionPoint?.geometry.root?.x ?? null }, nativeSurfaceUnavailable ? 'skipped because the clean isolated renderer has no native session anchor' : 'root starts after titlebar safe inset', nativeSurfaceUnavailable)
      return { result: assertions.every(item => item.pass) ? 'pass' : 'fail', sessionId: snapshot.extensionPoints === undefined ? null
        : document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id')?.replace(/^local:/, '') ?? null,
        points, iconControls, managerBrand, policyTransitions, pluginBlock, nativeMutation: mutation, safeInsets: { titlebar: titlebarRect, safeLeft }, assertions }
    })()`,
      true,
    )

    const reportPath = path.resolve(values.report)
    const extension = path.extname(reportPath)
    const stem = path.basename(reportPath, extension)
    const artifact = suffix => path.join(path.dirname(reportPath), `${stem}.${suffix}.png`)
    const screenshots = {}
    for (
      const [id, suffix] of [['session.header.actions', 'session-header-actions'], [
        'composer.toolbar.items',
        'composer-submit-before',
      ]]
    ) {
      const point = uiCatalogReport.points?.find(item => item.id === id)
      if (point?.captureRect !== null && point?.captureRect !== undefined) {
        screenshots[id] = await capture(point.captureRect, artifact(suffix), id)
      }
    }
    const tooltipEvidence = async (id, key, suffix) => {
      const activations = []
      let evidence = { pass: false, error: 'tooltip unavailable' }
      for (let attempt = 1; attempt <= 3 && !evidence.pass; attempt += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 100, pointerType: 'mouse' })
        await new Promise(resolve => setTimeout(resolve, 80))
        const trigger = await evaluateByValue(`(() => {
          const button = document.querySelector('[data-cordisx-surface-host=${JSON.stringify(key)}] button')
          const rect = button?.getBoundingClientRect()
          return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        })()`)
        if (trigger === null) return { pass: false, error: 'trigger unavailable', activations }
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: trigger.x + trigger.width / 2,
          y: trigger.y + trigger.height / 2,
          pointerType: 'mouse',
        })
        const activation = await evaluateByValue(`(() => {
          const button = document.querySelector('[data-cordisx-surface-host=${JSON.stringify(key)}] button')
          if (!(button instanceof HTMLElement)) return { focused: false, pointerDispatched: false, connected: false }
          button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))
          button.focus()
          return { focused: document.activeElement === button, pointerDispatched: true, connected: button.isConnected }
        })()`)
        activations.push({ attempt, ...activation })
        await new Promise(resolve => setTimeout(resolve, 900))
        evidence = await evaluateByValue(`(() => {
          const button = document.querySelector('[data-cordisx-surface-host=${JSON.stringify(key)}] button')
          const tooltip = document.querySelector('.cordisx-host-tooltip')
          if (button === null || tooltip === null) return { pass: false, error: 'tooltip unavailable' }
          const trigger = button.getBoundingClientRect()
          const tip = tooltip.getBoundingClientRect()
          const rect = { x: Math.min(trigger.x, tip.x), y: Math.min(trigger.y, tip.y),
            width: Math.max(trigger.right, tip.right) - Math.min(trigger.x, tip.x),
            height: Math.max(trigger.bottom, tip.bottom) - Math.min(trigger.y, tip.y) }
          const role = tooltip.getAttribute('role') ?? tooltip.role ?? null
          return { pass: role === 'tooltip' && button.getAttribute('aria-describedby') === tooltip.id && tip.x >= 0 && tip.y >= 0
            && tip.right <= innerWidth && tip.bottom <= innerHeight, text: tooltip.textContent, side: tooltip.dataset.side,
            role, describedBy: button.getAttribute('aria-describedby'), tooltipId: tooltip.id, rect }
        })()`)
      }
      evidence.activations = activations
      if (evidence.rect !== undefined) {
        evidence.screenshot = await capture(evidence.rect, artifact(suffix), `${id} tooltip`)
      }
      await evaluateByValue(
        `document.querySelector('[data-cordisx-surface-host=${JSON.stringify(key)}] button')?.blur()`,
      )
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 100, pointerType: 'mouse' })
      await new Promise(resolve => setTimeout(resolve, 80))
      evidence.dismissed = await evaluateByValue(`document.querySelector('.cordisx-host-tooltip') === null`)
      evidence.pass &&= evidence.dismissed
      return evidence
    }
    const tooltips = {
      'session.header.actions': await tooltipEvidence(
        'session.header.actions',
        'session.header.actions',
        'session-header-actions-tooltip',
      ),
      'composer.toolbar.items': await tooltipEvidence(
        'composer.toolbar.items',
        'composer.submit.before',
        'composer-submit-before-tooltip',
      ),
    }
    for (const [id, evidence] of Object.entries(tooltips)) {
      const point = uiCatalogReport.points?.find(item => item.id === id)
      const sessionUnavailable = point?.hostNativeAvailable !== true
      uiCatalogReport.assertions.push({
        id: `${id}.tooltip`,
        pass: sessionUnavailable || evidence.pass,
        actual: evidence,
        expected: sessionUnavailable
          ? 'skipped because the clean isolated renderer has no native session anchor'
          : 'described, in viewport, dismissed',
        ...(sessionUnavailable ? { skipped: true } : {}),
      })
    }

    const toolbarSnapshot = () =>
      evaluateByValue(`(() => {
      const rect = element => {
        const value = element?.getBoundingClientRect()
        return value === undefined ? null : { x: value.x, y: value.y, width: value.width, height: value.height, right: value.right, bottom: value.bottom }
      }
      const row = element => {
        if (!(element instanceof HTMLButtonElement)) return null
        const geometry = rect(element)
        const style = getComputedStyle(element)
        const hit = geometry === null ? null : document.elementFromPoint(geometry.x + geometry.width / 2, geometry.y + geometry.height / 2)
        return {
          owner: element.dataset.cordisxOwner ?? null,
          surface: element.dataset.cordisxSurface ?? null,
          contributionId: element.dataset.cordisxContributionId ?? null,
          label: element.getAttribute('aria-label'),
          pressed: element.getAttribute('aria-pressed'),
          routeState: element.dataset.cordisxRouteState ?? null,
          state: element.getAttribute('data-state'),
          disabled: element.disabled,
          focused: document.activeElement === element,
          className: element.className,
          background: style.backgroundColor,
          color: style.color,
          outline: style.outline,
          geometry,
          hit: hit === null ? null : {
            tag: hit.tagName,
            label: hit.getAttribute?.('aria-label') ?? null,
            contributionId: hit.closest?.('[data-cordisx-contribution-id]')?.dataset.cordisxContributionId ?? null,
          },
        }
      }
      const sessionRoot = document.querySelector('[data-cordisx-surface-host="session.header.actions"]')
      const nativeAnchor = sessionRoot?.nextElementSibling ?? null
      const nativeSummary = nativeAnchor?.matches('button') ? nativeAnchor : nativeAnchor?.querySelector('button') ?? null
      const sessionActions = [...(sessionRoot?.querySelectorAll(':scope > button') ?? [])].map(row).filter(Boolean)
      const sessionRootRect = rect(sessionRoot)
      const nativeSummaryRow = row(nativeSummary)
      const actionGaps = sessionActions.slice(1).map((item, index) => item.geometry.x - sessionActions[index].geometry.right)
      const nativeGap = sessionRootRect === null || nativeSummaryRow?.geometry === null ? null : nativeSummaryRow.geometry.x - sessionRootRect.right

      const beforeRoot = document.querySelector('[data-cordisx-surface-host="toolbar.before"]')
      const afterRoot = document.querySelector('[data-cordisx-surface-host="toolbar.after"]')
      const workspaceAnchor = beforeRoot?.nextElementSibling ?? null
      const workspaceNative = workspaceAnchor?.matches('button') ? workspaceAnchor : workspaceAnchor?.querySelector('button') ?? null
      const beforeRect = rect(beforeRoot)
      const afterRect = rect(afterRoot)
      const workspaceNativeRect = rect(workspaceNative)
      const slot = beforeRoot?.closest('[data-test-id="header-shell-slot"]') ?? null
      const alignmentGroup = beforeRoot?.parentElement ?? null
      return {
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        selectedThread: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') ?? null,
        agentTracePresented: document.querySelector('[data-agent-trace-showcase="true"]') !== null,
        session: {
          root: sessionRoot === null ? null : { className: sessionRoot.className, geometry: sessionRootRect,
            gap: getComputedStyle(sessionRoot).gap, marginInlineEnd: getComputedStyle(sessionRoot).marginInlineEnd,
            background: getComputedStyle(sessionRoot).backgroundColor },
          actions: sessionActions,
          native: nativeSummaryRow,
          actionGaps,
          nativeGap,
          relationship: { sameParent: sessionRoot?.parentElement === nativeAnchor?.parentElement, immediateBefore: sessionRoot?.nextElementSibling === nativeAnchor },
        },
        workspace: {
          before: { root: beforeRect, action: row(beforeRoot?.querySelector(':scope > button') ?? null) },
          native: row(workspaceNative),
          after: { root: afterRect, action: row(afterRoot?.querySelector(':scope > button') ?? null) },
          compactGaps: {
            beforeToNative: beforeRect === null || workspaceNativeRect === null ? null : workspaceNativeRect.x - beforeRect.right,
            nativeToAfter: workspaceNativeRect === null || afterRect === null ? null : afterRect.x - workspaceNativeRect.right,
          },
          outerGapFromSummary: nativeSummaryRow?.geometry === null || beforeRect === null ? null : beforeRect.x - nativeSummaryRow.geometry.right,
          slot: slot === null ? null : { className: slot.className, inlineWidth: slot.style.width, computedWidth: getComputedStyle(slot).width, geometry: rect(slot) },
          alignmentGroup: alignmentGroup === null ? null : { className: alignmentGroup.className, hasMsAuto: alignmentGroup.classList.contains('ms-auto'), geometry: rect(alignmentGroup) },
        },
      }
    })()`)

    const annotateToolbar = async (label, suffix) => {
      const clip = await evaluateByValue(`(() => {
        document.querySelector('[data-cordisx-toolbar-smoke-annotation]')?.remove()
        const root = document.querySelector('[data-cordisx-surface-host="session.header.actions"]')
        const nativeAnchor = root?.nextElementSibling
        const native = nativeAnchor?.matches('button') ? nativeAnchor : nativeAnchor?.querySelector('button')
        const buttons = [...(root?.querySelectorAll(':scope > button') ?? []), native].filter(Boolean)
        if (root === null || !(native instanceof HTMLElement) || buttons.length < 2) return null
        const rootRect = root.getBoundingClientRect()
        const nativeRect = native.getBoundingClientRect()
        const layer = document.createElement('div')
        layer.dataset.cordisxToolbarSmokeAnnotation = 'true'
        Object.assign(layer.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none', font: '600 10px/1.2 ui-monospace, monospace', color: '#d51f3f' })
        const add = (text, left, top, width = null) => {
          const item = document.createElement('span')
          item.textContent = text
          Object.assign(item.style, { position: 'fixed', left: left + 'px', top: top + 'px', padding: '2px 3px', borderRadius: '3px', background: 'rgba(255,255,255,.94)', boxShadow: '0 0 0 1px rgba(213,31,63,.35)' })
          if (width !== null) item.style.width = width + 'px'
          layer.append(item)
        }
        const all = buttons.map(button => ({ button, rect: button.getBoundingClientRect() }))
        for (let index = 1; index < all.length; index += 1) {
          const left = all[index - 1].rect.right
          const right = all[index].rect.x
          const line = document.createElement('i')
          Object.assign(line.style, { position: 'fixed', left: left + 'px', top: '39px', width: Math.max(1, right - left) + 'px', height: '2px', background: '#d51f3f' })
          layer.append(line)
          add(Math.round((right - left) * 100) / 100 + 'px', left - 7, 43)
        }
        add(${JSON.stringify(label)}, rootRect.x, 64)
        document.body.append(layer)
        return { x: Math.max(0, rootRect.x - 18), y: 0, width: nativeRect.right - rootRect.x + 36, height: 84 }
      })()`)
      if (clip === null) return null
      const evidence = await capture(clip, artifact(suffix), label)
      await evaluateByValue(`document.querySelector('[data-cordisx-toolbar-smoke-annotation]')?.remove()`)
      return evidence
    }

    let toolbarRegression
    const initialToolbarSnapshot = await toolbarSnapshot()
    const toolbarNativeGeometry = initialToolbarSnapshot.session.native?.geometry
    if (toolbarNativeGeometry === null || toolbarNativeGeometry === undefined) {
      // A clean isolated renderer has no selected session/native summary.  The
      // catalog itself is still useful there, but a pointer exercise against a
      // non-existent host control is neither a product failure nor valid smoke
      // evidence.
      const status = initialToolbarSnapshot.session.native === null
        ? 'session-unavailable'
        : 'native-geometry-unavailable'
      uiCatalogReport.assertions.push({
        id: 'toolbar.session-native',
        pass: true,
        skipped: true,
        actual: { status, session: initialToolbarSnapshot.session },
        expected: 'skipped when the isolated renderer has no session native control',
      })
      toolbarRegression = { status, skipped: true, initial: initialToolbarSnapshot }
    } else {
      let inactive = initialToolbarSnapshot
      const initialNativePressed = inactive.session.native?.pressed
      if (initialNativePressed === 'true') {
        await pointerClick(inactive.session.native.geometry)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
      await new Promise(resolve => setTimeout(resolve, 160))
      inactive = await toolbarSnapshot()
      screenshots['toolbar.inactive'] = await annotateToolbar(
        'inactive · independent gaps',
        'toolbar-inactive-annotated',
      )

      const originalThread = inactive.selectedThread
      const threadTarget = await evaluateByValue(`(() => {
      const selected = ${JSON.stringify(inactive.selectedThread)}
      const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
        .find(element => element.getClientRects().length > 0 && element.getAttribute('data-app-action-sidebar-thread-id') !== selected)
      const rect = row?.getBoundingClientRect()
      return rect === undefined ? null : { id: row.getAttribute('data-app-action-sidebar-thread-id'), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
      let threadSwitch = { attempted: false }
      if (threadTarget !== null && originalThread !== null) {
        await evaluateByValue(`(() => {
        globalThis.__cordisxToolbarSmokeIdentity = {
          root: document.querySelector('[data-cordisx-surface-host="session.header.actions"]'),
          native: (() => { const root = document.querySelector('[data-cordisx-surface-host="session.header.actions"]'); const anchor = root?.nextElementSibling; return anchor?.matches('button') ? anchor : anchor?.querySelector('button') ?? null })(),
        }
        return true
      })()`)
        await pointerClick(threadTarget)
        await new Promise(resolve => setTimeout(resolve, 1800))
        const originalTarget = await evaluateByValue(`(() => {
        const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
          .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === ${
          JSON.stringify(originalThread)
        })
        const rect = row?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)
        if (originalTarget !== null) {
          await pointerClick(originalTarget)
          await new Promise(resolve => setTimeout(resolve, 1800))
        }
        threadSwitch = await evaluateByValue(`(() => {
        const root = document.querySelector('[data-cordisx-surface-host="session.header.actions"]')
        const anchor = root?.nextElementSibling
        const native = anchor?.matches('button') ? anchor : anchor?.querySelector('button') ?? null
        return { attempted: true, alternate: ${
          JSON.stringify(threadTarget.id)
        }, restored: document.querySelector('[data-app-action-sidebar-thread-selected="true"]')?.getAttribute('data-app-action-sidebar-thread-id') === ${
          JSON.stringify(originalThread)
        },
          rootConnected: root?.isConnected ?? false, immediateBefore: root?.nextElementSibling === anchor,
          rootIdentityPreserved: root === globalThis.__cordisxToolbarSmokeIdentity?.root,
          nativeIdentityPreserved: native === globalThis.__cordisxToolbarSmokeIdentity?.native }
      })()`)
      }

      inactive = await toolbarSnapshot()
      await pointerClick(inactive.session.native.geometry)
      await new Promise(resolve => setTimeout(resolve, 500))
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
      await new Promise(resolve => setTimeout(resolve, 160))
      const nativeActive = await toolbarSnapshot()
      screenshots['toolbar.native-active'] = await annotateToolbar(
        'native pressed · CordisX idle',
        'toolbar-native-active-annotated',
      )

      if (nativeActive.session.native?.geometry !== null && nativeActive.session.native?.geometry !== undefined) {
        const target = nativeActive.session.native.geometry
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: target.x + target.width / 2,
          y: target.y + target.height / 2,
          pointerType: 'mouse',
        })
        await new Promise(resolve => setTimeout(resolve, 160))
      }
      const nativeActiveHovered = await toolbarSnapshot()

      const hoverTarget = nativeActive.session.actions[0]?.geometry
      if (hoverTarget !== null && hoverTarget !== undefined) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: hoverTarget.x + hoverTarget.width / 2,
          y: hoverTarget.y + hoverTarget.height / 2,
          pointerType: 'mouse',
        })
        await new Promise(resolve => setTimeout(resolve, 160))
      }
      const hovered = await toolbarSnapshot()
      screenshots['toolbar.hover'] = await annotateToolbar('hover first · sibling idle', 'toolbar-hover-annotated')

      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
      await evaluateByValue(
        `document.querySelector('[data-cordisx-surface-host="session.header.actions"] > button:nth-of-type(2)')?.focus()`,
      )
      await new Promise(resolve => setTimeout(resolve, 120))
      const focused = await toolbarSnapshot()
      screenshots['toolbar.focus'] = await annotateToolbar('focus second · state isolated', 'toolbar-focus-annotated')

      await evaluateByValue(`document.activeElement?.blur?.()`)
      const beforeRoute = await toolbarSnapshot()
      if (beforeRoute.session.native?.pressed === 'true') {
        await pointerClick(beforeRoute.session.native.geometry)
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      const routeTargetState = await toolbarSnapshot()
      const routeTarget = routeTargetState.session.actions.find(item => item.routeState !== null)?.geometry ?? null
      if (routeTarget !== null) {
        await pointerClick(routeTarget)
        await new Promise(resolve => setTimeout(resolve, 500))
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
        await new Promise(resolve => setTimeout(resolve, 160))
      }
      const routeActive = await toolbarSnapshot()
      screenshots['toolbar.route-active'] = await annotateToolbar(
        'single CordisX route pressed',
        'toolbar-route-active-annotated',
      )

      const activeRouteTarget = routeActive.session.actions.find(item => item.pressed === 'true')?.geometry ?? null
      if (activeRouteTarget !== null) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: activeRouteTarget.x + activeRouteTarget.width / 2,
          y: activeRouteTarget.y + activeRouteTarget.height / 2,
          pointerType: 'mouse',
        })
        await new Promise(resolve => setTimeout(resolve, 160))
      }
      const routeHovered = await toolbarSnapshot()
      screenshots['toolbar.route-active-hover'] = await annotateToolbar(
        'route pressed + hover · siblings idle',
        'toolbar-route-active-hover-annotated',
      )

      let routeSessionSwitch = { attempted: false }
      if (threadTarget !== null && originalThread !== null) {
        const alternateTarget = await evaluateByValue(`(() => {
        const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
          .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === ${
          JSON.stringify(threadTarget.id)
        })
        const rect = row?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)
        if (alternateTarget !== null) {
          await pointerClick(alternateTarget)
          await new Promise(resolve => setTimeout(resolve, 1800))
          const alternate = await toolbarSnapshot()
          const originalTarget = await evaluateByValue(`(() => {
          const row = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')]
            .find(element => element.getAttribute('data-app-action-sidebar-thread-id') === ${
            JSON.stringify(originalThread)
          })
          const rect = row?.getBoundingClientRect()
          return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        })()`)
          if (originalTarget !== null) {
            await pointerClick(originalTarget)
            await new Promise(resolve => setTimeout(resolve, 1800))
          }
          const restored = await toolbarSnapshot()
          routeSessionSwitch = { attempted: true, alternate, restored }
        }
      }

      let beforeClose = await toolbarSnapshot()
      if (!beforeClose.session.actions.some(item => item.pressed === 'true')) {
        const reopenTarget = beforeClose.session.actions.find(item => item.routeState !== null)?.geometry ?? null
        if (reopenTarget !== null) {
          await pointerClick(reopenTarget)
          await new Promise(resolve => setTimeout(resolve, 500))
          beforeClose = await toolbarSnapshot()
        }
      }
      const closeTarget = beforeClose.session.actions.find(item => item.pressed === 'true')?.geometry ?? null
      if (closeTarget !== null) {
        await pointerClick(closeTarget)
        await new Promise(resolve => setTimeout(resolve, 500))
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 500, pointerType: 'mouse' })
        await new Promise(resolve => setTimeout(resolve, 160))
      }
      const routeClosed = await toolbarSnapshot()
      screenshots['toolbar.route-closed'] = await annotateToolbar(
        'route closed · active cleared',
        'toolbar-route-closed-annotated',
      )

      const originalViewport = routeActive.viewport
      await send('Emulation.setDeviceMetricsOverride', {
        width: Math.max(1100, originalViewport.width - 180),
        height: Math.max(760, originalViewport.height - 120),
        deviceScaleFactor: originalViewport.dpr,
        mobile: false,
      })
      await new Promise(resolve => setTimeout(resolve, 500))
      const resized = await toolbarSnapshot()
      await send('Emulation.clearDeviceMetricsOverride')
      await new Promise(resolve => setTimeout(resolve, 300))

      const transparent = value => value === 'rgba(0, 0, 0, 0)' || value === 'transparent'
      const six = value => value !== null && Math.abs(value - 6) <= 0.5
      const inactivePass = inactive.session.native?.pressed === 'false'
        && inactive.session.actions.every(item => item.pressed !== 'true' && transparent(item.background))
      const nativeActivePass = nativeActive.session.native?.pressed === 'true'
        && nativeActive.session.actions.every(item =>
          item.pressed !== 'true' && transparent(item.background)
          && !item.className.includes('bg-text/5') && !item.className.includes('codex-toolbar-button')
        )
      const spacingPass = nativeActive.session.actionGaps.every(six) && six(nativeActive.session.nativeGap)
      const hoverPass = hovered.session.actions[0]?.background !== inactive.session.actions[0]?.background
        && hovered.session.actions.slice(1).every((item, index) =>
          item.background === inactive.session.actions[index + 1]?.background
        )
        && hovered.session.actions.every(item => item.pressed !== 'true')
      const focusPass = focused.session.actions[1]?.focused === true && focused.session.actions[1]?.pressed !== 'true'
        && focused.session.actions[0]?.pressed !== 'true' && focused.session.native?.pressed === 'true'
      const routePressed = routeActive.session.actions.filter(item =>
        item.pressed === 'true' && item.routeState === 'presented'
      )
      const routePass = routePressed.length === 1
        && routePressed[0]?.owner === 'agent-trace-showcase'
        && routePressed[0]?.background === nativeActive.session.native?.background
        && routePressed[0]?.color === nativeActive.session.native?.color
        && routePressed[0]?.geometry?.width === nativeActive.session.native?.geometry?.width
        && routePressed[0]?.geometry?.height === nativeActive.session.native?.geometry?.height
        && routeActive.session.actions.filter(item => item.pressed !== 'true').every(item =>
          transparent(item.background)
        )
        && routeActive.session.native?.pressed === 'false'
        && routeActive.agentTracePresented === true
      const routeHoverPressed = routeHovered.session.actions.filter(item =>
        item.pressed === 'true' && item.routeState === 'presented'
      )
      const routeHoverPass = routeHoverPressed.length === 1
        && routeHoverPressed[0]?.background === nativeActiveHovered.session.native?.background
        && routeHoverPressed[0]?.background !== routePressed[0]?.background
        && routeHovered.session.actions.filter(item => item.pressed !== 'true').every(item =>
          transparent(item.background)
        )
      const routeClosePass = routeClosed.agentTracePresented === false
        && routeClosed.session.actions.every(item =>
          item.pressed !== 'true' && item.routeState !== 'presented' && transparent(item.background)
        )
      const routeSessionPass = routeSessionSwitch.attempted === false || (
        routeSessionSwitch.alternate.selectedThread === threadTarget?.id
        && routeSessionSwitch.alternate.agentTracePresented === false
        && routeSessionSwitch.alternate.session.actions.every(item =>
          item.pressed !== 'true' && item.routeState !== 'presented'
        )
        && routeSessionSwitch.restored.selectedThread === originalThread
        && routeSessionSwitch.restored.agentTracePresented === false
        && routeSessionSwitch.restored.session.actions.every(item =>
          item.pressed !== 'true' && item.routeState !== 'presented'
        )
      )
      const workspacePass = nativeActive.workspace.slot?.inlineWidth === '126px'
        && nativeActive.workspace.alignmentGroup?.hasMsAuto === true && six(nativeActive.workspace.outerGapFromSummary)
      const resizePass = resized.session.actionGaps.every(six) && six(resized.session.nativeGap)
        && resized.workspace.slot?.inlineWidth === '126px'
        && resized.session.root?.geometry?.right <= resized.viewport.width
      uiCatalogReport.assertions.push(
        {
          id: 'toolbar.state.inactive',
          pass: inactivePass,
          actual: inactive.session,
          expected: 'all controls inactive and transparent',
        },
        {
          id: 'toolbar.state.native-isolated',
          pass: nativeActivePass,
          actual: nativeActive.session,
          expected: 'only native summary pressed',
        },
        {
          id: 'toolbar.state.hover-isolated',
          pass: hoverPass,
          actual: hovered.session,
          expected: 'only hovered CordisX action changes background',
        },
        {
          id: 'toolbar.state.focus-isolated',
          pass: focusPass,
          actual: focused.session,
          expected: 'focus belongs to one unpressed sibling',
        },
        {
          id: 'toolbar.state.route-isolated',
          pass: routePass,
          actual: { route: routeActive.session, nativeReference: nativeActive.session.native },
          expected: 'only Agent Trace uses the native-equivalent pressed token and 28px geometry',
        },
        {
          id: 'toolbar.state.route-hover-isolated',
          pass: routeHoverPass,
          actual: { route: routeHovered.session, nativeReference: nativeActiveHovered.session.native },
          expected: 'only the pressed Agent Trace action uses the native-equivalent pressed-hover token',
        },
        {
          id: 'toolbar.state.route-closed',
          pass: routeClosePass,
          actual: routeClosed,
          expected: 'second real pointer activation closes the page and clears every active projection',
        },
        {
          id: 'toolbar.state.route-session-isolated',
          pass: routeSessionPass,
          actual: routeSessionSwitch,
          expected: 'active route state is cleared on A/B switch and does not return to A',
        },
        {
          id: 'toolbar.spacing.session',
          pass: spacingPass,
          actual: { actionGaps: nativeActive.session.actionGaps, nativeGap: nativeActive.session.nativeGap },
          expected: '6px action and native boundary gaps',
        },
        {
          id: 'toolbar.spacing.workspace-contract',
          pass: workspacePass,
          actual: nativeActive.workspace,
          expected: '126px slot, ms-auto, 6px outer group gap',
        },
        {
          id: 'toolbar.resize',
          pass: resizePass,
          actual: resized,
          expected: 'state geometry survives renderer resize',
        },
        {
          id: 'toolbar.thread-switch-reconcile',
          pass: threadSwitch.attempted === false
            || (threadSwitch.restored && threadSwitch.rootConnected && threadSwitch.immediateBefore),
          actual: threadSwitch,
          expected: 'real thread switch restores the selected session and valid sibling seat',
        },
      )
      toolbarRegression = {
        initialNativePressed,
        inactive,
        nativeActive,
        nativeActiveHovered,
        hovered,
        focused,
        routeActive,
        routeHovered,
        routeClosed,
        resized,
        threadSwitch,
        routeSessionSwitch,
      }
    }
    uiCatalogReport = {
      ...uiCatalogReport,
      screenshots,
      tooltips,
      toolbarRegression,
      result: uiCatalogReport.assertions.every(item => item.pass) ? 'pass' : 'fail',
    }
    console.log(`ui-catalog=${JSON.stringify(uiCatalogReport, null, 2)}`)
  }

  if (values.screenshot !== undefined) {
    const markerRect = await evaluateByValue(`(() => {
      const panel = document.querySelector('[data-cordisx-page]') ?? document.querySelector('[data-cordisx-demo-marker]')
      const rect = panel?.getBoundingClientRect()
      return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })()`)
    await capture(markerRect, values.screenshot, 'CordisX marker')
  }

  if (values['app-screenshot'] !== undefined) {
    const captured = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    })
    if (typeof captured.data !== 'string') throw new Error('CDP app screenshot returned no image')
    const screenshotPath = path.resolve(values['app-screenshot'])
    await mkdir(path.dirname(screenshotPath), { recursive: true })
    await writeFile(screenshotPath, Buffer.from(captured.data, 'base64'))
    console.log(`app-screenshot=${screenshotPath}`)
  }

  return { uiCatalogReport }
}
