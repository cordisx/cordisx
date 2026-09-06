import path from 'node:path'
export async function runPermissionExercises({
  values,
  report,
  evaluateByValue,
  capture,
}) {
  let permissionV2Report

  if (values['permission-v2-source'] !== undefined) {
    const pluginId = 'permission-v2-smoke'
    const sourceDirectory = values['permission-v2-source']
    const expandedSourceDirectory = values['permission-v2-expanded-source']
    const reportPath = path.resolve(values.report)
    const authorizationScreenshot = path.join(
      path.dirname(reportPath),
      `${path.basename(reportPath, path.extname(reportPath))}.permission-v2-authorization.png`,
    )
    const opened = await evaluateByValue(
      `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          const value = predicate()
          if (value) return value
          await wait(50)
        }
        throw new Error('timed out waiting for ' + label)
      }
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      document.querySelector('[data-permission-authorization] [data-permission-action="cancel"]')?.click()
      const modal = document.querySelector('[data-cordisx-manager-modal]')
      if (modal?.hidden !== false) document.querySelector('[data-cordisx-manager-trigger]')?.click()
      document.querySelector('[data-tab="plugins"]')?.click()
      const install = await waitFor(() => document.querySelector('[data-import-local-plugin]:not(:disabled)'), 'local import action')
      install.click()
      const input = await waitFor(() => document.querySelector('.cxm-lifecycle-dialog [data-import-local-path]'), 'local package input')
      input.value = ${JSON.stringify(sourceDirectory)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const submit = document.querySelector('[data-import-local-submit]')
      if (!(submit instanceof HTMLElement)) throw new Error('local import submit action is unavailable')
      submit.click()
      const dialog = await waitFor(() => {
        const authorization = document.querySelector('.cxp-overlay[data-permission-authorization]')
        if (authorization !== null) return authorization
        const lifecycleError = document.querySelector('[data-cordisx-manager-modal] .cxm-content > .cxm-error')
          ?.textContent?.trim()
        if (lifecycleError) throw new Error('local package inspection failed: ' + lifecycleError)
        return null
      }, 'permission v2 install authorization')
      const rect = dialog.querySelector('[role="dialog"]')?.getBoundingClientRect()
      const items = [...dialog.querySelectorAll('[data-permission-capability]')].map(item => ({
        capability: item.getAttribute('data-permission-capability'),
        reviewMode: item.querySelector('[data-permission-review-mode]')?.getAttribute('data-permission-review-mode') ?? null,
        decisions: [...item.querySelectorAll('[data-permission-decision]')].map(input => ({
          decision: input.getAttribute('data-permission-decision'), checked: input.checked,
        })),
        text: item.textContent?.trim() ?? '',
      }))
      return rect === undefined ? null : {
        appRenderer: location.href === 'app://-/index.html',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        theme: dialog.getAttribute('data-cordisx-app-theme'),
        heading: dialog.querySelector('h2')?.textContent ?? null,
        headings: dialog.querySelectorAll('h2').length,
        items,
      }
    })()`,
      true,
    )
    if (opened?.rect === undefined) throw new Error('permission v2 authorization dialog did not open')
    const screenshot = await capture(opened.rect, authorizationScreenshot, 'permission v2 authorization')
    const exercised = await evaluateByValue(
      `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const value = predicate()
          if (value) return value
          await wait(50)
        }
        throw new Error('timed out waiting for ' + label)
      }
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      const pluginId = ${JSON.stringify(pluginId)}
      const select = (capability, decision) => {
        const input = document.querySelector(
          '[data-permission-capability="' + CSS.escape(capability) + '"] [data-permission-decision="' + CSS.escape(decision) + '"]',
        )
        if (!(input instanceof HTMLInputElement)) throw new Error('missing permission choice ' + capability + '/' + decision)
        input.click()
      }
      select('agent.events.read', 'allow-once')
      select('tasks.catalog.read', 'allow-persistent')
      select('tasks.control', 'deny-persistent')
      document.querySelector('.cxp-overlay [data-permission-action="confirm"]')?.click()
      const installed = await waitFor(
        () => runtime.snapshot().plugins.find(item => item.id === pluginId && item.status === 'active'),
        'active permission v2 plugin',
      )
      await waitFor(
        () => document.querySelector('[data-import-local-plugin]:not(:disabled)'),
        'settled permission v2 install transaction',
      )
      const initialActivation = runtime.activePluginGeneration().plugins.find(item => item.id === pluginId)
      const narrowPlan = runtime.permissionAuthorizationPlanV2(pluginId)
      const taskFirst = await runtime.execute(pluginId, { id: 'probe-tasks' })
      const taskSecond = await runtime.execute(pluginId, { id: 'probe-tasks' })
      const taskPrompted = document.querySelector('[data-permission-authorization]') !== null

      const inspection = await runtime.requestPluginLifecycle({
        kind: 'inspect-local', sourceDirectory: ${JSON.stringify(expandedSourceDirectory)},
      })
      if (inspection.outcome !== 'planned' || inspection.candidateId === undefined) {
        throw new Error('expanded permission package did not produce an update candidate')
      }
      const expandedPlan = await runtime.permissionLifecycleReviewPlanV2({
        kind: 'candidate', candidateId: inspection.candidateId,
      })
      if (expandedPlan === undefined) throw new Error('expanded permission package did not produce a v2 plan')
      const expandedDecision = {
        $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v2.schema.json',
        schemaVersion: 2,
        planId: expandedPlan.planId,
        operation: expandedPlan.operation,
        profileId: expandedPlan.profileId,
        identity: expandedPlan.identity,
        binding: expandedPlan.binding,
        decisions: expandedPlan.declarations.map(item => ({
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
          decision: item.capability === 'agent.events.read' ? 'allow-once'
            : item.capability === 'tasks.catalog.read' ? 'allow-persistent' : 'deny-persistent',
        })),
      }
      const updated = await runtime.applyPermissionLifecycleReviewV2(expandedDecision)
      if (updated.outcome !== 'applied') throw new Error('expanded permission update was not applied')
      await waitFor(
        () => runtime.snapshot().plugins.find(item => item.id === pluginId && item.package?.version === '1.1.0' && item.status === 'active'),
        'updated permission v2 plugin',
      )
      await waitFor(
        () => document.querySelector('[data-import-local-plugin]:not(:disabled)'),
        'settled permission v2 update transaction',
      )
      const updatedActivation = runtime.activePluginGeneration().plugins.find(item => item.id === pluginId)
      const updatedPlan = runtime.permissionAuthorizationPlanV2(pluginId)
      const firstEvent = await runtime.execute(pluginId, { id: 'probe-agent-events' })
      const firstEventPrompted = document.querySelector('[data-permission-authorization]') !== null
      let secondSettled = false
      const secondEventPending = runtime.execute(pluginId, { id: 'probe-agent-events' }).then(value => {
        secondSettled = true
        return value
      })
      const runtimeDialog = await waitFor(
        () => document.querySelector('.cxp-overlay[data-permission-authorization]'),
        'runtime permission v2 prompt after allow-once consumption',
      )
      const runtimePrompt = {
        operation: runtimeDialog.querySelector('h2')?.textContent ?? null,
        secondSettledBeforeDecision: secondSettled,
        moduleGeneration: runtimeDialog.querySelector('[data-permission-capability="agent.events.read"]')?.textContent?.includes(updatedActivation?.moduleGeneration ?? '') ?? false,
      }
      const deny = runtimeDialog.querySelector(
        '[data-permission-capability="agent.events.read"] [data-permission-decision="deny-persistent"]',
      )
      if (!(deny instanceof HTMLInputElement)) throw new Error('runtime persistent deny is unavailable')
      deny.click()
      runtimeDialog.querySelector('[data-permission-action="confirm"]')?.click()
      const secondEvent = await secondEventPending
      const finalPlan = runtime.permissionAuthorizationPlanV2(pluginId)
      return {
        installed: { id: installed.id, status: installed.status, version: installed.package?.version ?? null },
        taskCalls: { first: taskFirst, second: taskSecond, prompted: taskPrompted },
        narrowPlan,
        expandedPlan,
        update: {
          outcome: updated.outcome,
          initialModuleGeneration: initialActivation?.moduleGeneration ?? null,
          updatedModuleGeneration: updatedActivation?.moduleGeneration ?? null,
          updatedPlan,
        },
        allowOnce: { first: firstEvent, firstPrompted: firstEventPrompted, second: secondEvent, runtimePrompt },
        finalPlan,
        appRenderer: location.href === 'app://-/index.html',
      }
    })()`,
      true,
    )
    const narrowTasks = exercised.narrowPlan?.declarations?.find(item => item.capability === 'tasks.catalog.read')
    const expandedTasks = exercised.expandedPlan?.declarations?.find(item => item.capability === 'tasks.catalog.read')
    const expandedEvents = exercised.expandedPlan?.declarations?.find(item => item.capability === 'agent.events.read')
    const finalEvents = exercised.finalPlan?.declarations?.find(item => item.capability === 'agent.events.read')
    const finalTasks = exercised.finalPlan?.declarations?.find(item => item.capability === 'tasks.catalog.read')
    const assertions = {
      appRenderer: opened.appRenderer && exercised.appRenderer,
      theme: opened.theme === (values['color-scheme'] ?? opened.theme),
      informationArchitecture: opened.headings === 1 && opened.items.length === 3,
      batchAndExplicit: opened.items.filter(item => item.reviewMode === 'batch-eligible').length === 1
        && opened.items.filter(item => item.reviewMode === 'explicit').length === 2,
      persistentAllow: narrowTasks?.policy === 'allow-persistent' && exercised.taskCalls.prompted === false
        && finalTasks?.policy === 'allow-persistent',
      scopeExpansion: narrowTasks?.scope?.providers?.length === 1 && expandedTasks?.scope?.providers?.length === 2
        && expandedTasks?.policy === 'ask' && expandedTasks?.decisionRequired === true
        && narrowTasks?.securityFingerprint !== expandedTasks?.securityFingerprint,
      generationInvalidation: exercised.update.initialModuleGeneration !== exercised.update.updatedModuleGeneration
        && expandedEvents?.policy === 'ask' && expandedEvents?.decisionRequired === true,
      exactAllowOnce: exercised.allowOnce.firstPrompted === false
        && exercised.allowOnce.runtimePrompt.secondSettledBeforeDecision === false
        && exercised.allowOnce.runtimePrompt.moduleGeneration === true,
      persistentDeny: exercised.allowOnce.second?.ok === false
        && exercised.allowOnce.second?.error?.code === 'permission-denied'
        && finalEvents?.policy === 'deny-persistent',
    }
    permissionV2Report = {
      result: Object.values(assertions).every(Boolean) ? 'pass' : 'fail',
      opened,
      exercised,
      screenshot,
      assertions,
    }
    console.log(`permission-v2=${JSON.stringify(permissionV2Report, null, 2)}`)
  }

  return { permissionV2Report }
}
