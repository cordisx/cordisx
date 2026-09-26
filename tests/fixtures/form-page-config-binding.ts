import { mountManagerContentConfigForm } from '../../packages/cli/src/renderer/manager-content-config-form.js'
import type { ManagerContentConfigBindingHandle } from '../../packages/cli/src/renderer/manager-content-config.js'
import { HOST_FORM_REACT_STYLES } from '../../packages/cli/src/renderer/host-ui/HostForm.js'
import { HOST_TDESIGN_REACT_STYLES } from '../../packages/cli/src/renderer/host-ui/tdesign-styles.js'
import { HostThemeProjection } from '../../packages/cli/src/renderer/host-theme.js'
import { formPageFields, formPageValue } from './form-page-schema.js'

/** Read-only data fixture through the production config-binding mount, with no backend mutation. */
export async function startConfigBinding() {
  const container = document.createElement('div')
  container.className = 'cxh-tdesign-root'
  const style = document.createElement('style')
  style.textContent = HOST_TDESIGN_REACT_STYLES + HOST_FORM_REACT_STYLES
  document.body.append(style, container)
  const theme = new HostThemeProjection(document)
  theme.attach(container)
  const binding = {
    bindingId: 'fixture:config-pages',
    identity: { source: 'fixture:form-pages', pluginId: 'fixture' },
    scope: { profileId: 'fixture', generation: 'fixture' },
    declarationId: 'settings',
    namespace: 'fixture',
  }
  const configuration = {
    namespace: 'fixture',
    schemaKind: 'schemastery',
    applies: 'live',
    writable: true,
    revision: 1,
    lastGoodRevision: 1,
    value: formPageValue,
    fields: formPageFields(),
    secrets: [],
  }
  const handle = {
    owner: 'fixture',
    declarationId: 'settings',
    moduleGeneration: 'fixture',
    contractVersion: 1,
    body: { kind: 'plugin-config-form', namespace: 'fixture' },
    source: {
      binding,
      snapshot: async () => ({ status: 'available', body: { sequence: 0, configuration } }),
      subscribe: async () => ({ status: 'unavailable' }),
      execute: async () => {
        throw new Error('Read-only fixture must not save')
      },
    },
    snapshotForHost: () => configuration,
    close() {},
  } as unknown as ManagerContentConfigBindingHandle
  const dispose = mountManagerContentConfigForm(container, handle, () => 'zh-CN')
  await new Promise(resolve => setTimeout(resolve, 70))
  return () => {
    dispose()
    theme.dispose()
    style.remove()
    container.remove()
  }
}
