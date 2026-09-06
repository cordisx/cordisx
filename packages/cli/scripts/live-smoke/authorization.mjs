export async function runAuthorizationExercise({
  values,
  evaluateByValue,
  capture,
  pointerClick,
}) {
  let authorizationReport

  if (values['authorization-plugin'] !== undefined) {
    const pluginId = values['authorization-plugin']
    const decision = values['authorization-decision']
    if (decision !== undefined && !['allow', 'allow-once', 'deny'].includes(decision)) {
      throw new Error(`unknown authorization decision: ${decision}`)
    }
    const opened = await evaluateByValue(
      `(async () => {
      const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX runtime is unavailable')
      document.querySelector('[data-permission-authorization] [data-authorization-decision="cancel"]')?.click()
      document.querySelector('.cxm-close')?.click()
      await runtime.setPluginBlocked(${JSON.stringify(pluginId)}, true)
      document.querySelector('[data-cordisx-manager-trigger]')?.click()
      document.querySelector('[data-tab="plugins"]')?.click()
      document.querySelector('[data-plugin-id=${JSON.stringify(pluginId)}]')?.click()
      document.querySelector('[data-plugin-detail-tab="runtime"]')?.click()
      document.querySelector('.cxm-plugin-runtime-action')?.click()
      await wait(180)
      const dialog = document.querySelector('[data-permission-authorization=${JSON.stringify(pluginId)}]')
      const rect = dialog?.getBoundingClientRect()
      const items = [...(dialog?.querySelectorAll('[role="listitem"]') ?? [])]
      const primary = dialog?.querySelector('[data-authorization-decision="allow"]')
      return rect === undefined ? null : {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        title: dialog.querySelector('h2')?.textContent ?? null,
        headings: dialog.querySelectorAll('h2').length,
        titleOccurrences: (dialog.textContent?.match(/启用授权/g) ?? []).length,
        flat: dialog.querySelector('.cxm-slot-card') === null && items.every(item => item.querySelector('[role="listitem"]') === null),
        primary: primary?.textContent ?? null,
        primaryFocused: document.activeElement === primary,
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        items: items.map(item => ({
          capability: item.getAttribute('data-authorization-capability'),
          text: item.textContent?.trim() ?? '',
          checked: item.querySelector('input')?.checked ?? null,
          disabled: item.querySelector('input')?.disabled ?? null,
        })),
      }
    })()`,
      true,
    )
    if (opened?.rect === undefined) throw new Error(`authorization dialog did not open for ${pluginId}`)
    if (values['authorization-screenshot'] !== undefined) {
      await capture(opened.rect, values['authorization-screenshot'], 'CordisX authorization dialog')
    }
    let completed
    if (decision !== undefined) {
      if (values['authorization-decline-optional']) {
        const optionalRect = await evaluateByValue(`(() => {
          const choice = [...document.querySelectorAll('[data-permission-authorization=${
          JSON.stringify(pluginId)
        }] [data-authorization-choice]')]
            .find(item => !item.disabled)
          const rect = choice?.getBoundingClientRect()
          return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        })()`)
        if (optionalRect === null) throw new Error('authorization dialog has no optional capability choice')
        await pointerClick(optionalRect)
      }
      const actionRect = await evaluateByValue(`(() => {
        const action = document.querySelector('[data-permission-authorization=${
        JSON.stringify(pluginId)
      }] [data-authorization-decision=${JSON.stringify(decision)}]')
        const rect = action?.getBoundingClientRect()
        return rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })()`)
      if (actionRect === null) throw new Error(`authorization action is unavailable: ${decision}`)
      await pointerClick(actionRect)
      await new Promise(resolve => setTimeout(resolve, 400))
      completed = await evaluateByValue(`(() => {
        const snapshot = globalThis.__cordisxRuntime.snapshot()
        return {
          dialogPresent: document.querySelector('[data-permission-authorization=${JSON.stringify(pluginId)}]') !== null,
          plugin: snapshot.plugins.find(item => item.id === ${JSON.stringify(pluginId)}) ?? null,
          permissions: snapshot.permissions.filter(item => item.identity.id === ${
        JSON.stringify(pluginId)
      }).map(item => ({
            capability: item.capability, required: item.required, policy: item.policy,
          })),
          browserPolicies: localStorage.getItem('cordisx.platform.permissionPolicies.v2'),
        }
      })()`)
    }
    authorizationReport = { pluginId, opened, decision: decision ?? null, completed: completed ?? null }
    console.log(`authorization=${JSON.stringify(authorizationReport, null, 2)}`)
  }

  return { authorizationReport }
}
