/** Generated renderer boot/entry sources share one captured installation lifetime. */
export function nativeViteBootModuleSource(input: {
  reactPrepareUrl: string
  entryUrl: string
}): string {
  return `
let queue = Promise.resolve();
let currentStartup;
export function start(startup = currentStartup) {
  currentStartup = startup;
  const task = queue.catch(() => {}).then(async () => {
    for (let attempt = 0; ; attempt++) {
      startup.check();
      try {
        await import(/* @vite-ignore */ ${JSON.stringify(input.reactPrepareUrl)} + '?t=' + Date.now());
        startup.check();
        const entry = await import(/* @vite-ignore */ ${JSON.stringify(input.entryUrl)} + '?t=' + Date.now());
        startup.check();
        return await entry.start(startup);
      } catch (error) {
        startup.check();
        if (attempt >= 4) throw error;
        await new Promise((resolve, reject) => {
          const finish = () => { startup.signal.removeEventListener('abort', abort); resolve(); };
          const timer = setTimeout(finish, 500);
          const abort = () => { clearTimeout(timer); startup.signal.removeEventListener('abort', abort); reject(startup.signal.reason); };
          startup.signal.addEventListener('abort', abort, { once: true });
          if (startup.signal.aborted) abort();
        });
      }
    }
  });
  queue = task;
  return task;
}
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.on('cordisx:restart-host', () => { void start().catch(error => console.error('[cordisx] Vite Host reload failed', error)); });
}
`
}

export function nativeViteEntryModuleSource(input: {
  hostImport: string
  helperImport: string
  pluginsSource: string
  metadataSource: string
  pluginImports: readonly string[]
  pluginUrls: readonly string[]
}): string {
  return `
import { installCordisX, prepareCordisXViteReactRuntime } from ${JSON.stringify(input.hostImport)};
import { NativeViteDevelopmentClient } from ${JSON.stringify(input.helperImport)};
// Importing the entry has no activation side effects. The boot passes its captured lifetime.
export async function start(startup) {
startup.check();
const previous = globalThis.__cordisxViteClient;
let certifiedPermissionChannel = previous?.releaseCertifiedPermissionChannel();
if (previous) {
  try { await previous.dispose(true); startup.check(); }
  catch (error) { certifiedPermissionChannel?.dispose(); throw error; }
}
const disposeSharedReactRuntime = prepareCordisXViteReactRuntime(document);
const descriptors = ${input.pluginsSource};
const pluginUrls = ${JSON.stringify(input.pluginUrls)};
const withDescriptor = artifact => ({ ...artifact, plugin: { ...descriptors.find(item => item.id === artifact.plugin.id), ...artifact.plugin } });
const replacePlugin = (pluginId, timestamp) => {
  const index = descriptors.findIndex(plugin => plugin.id === pluginId);
  const pluginUrl = pluginUrls[index];
  if (!pluginUrl) return Promise.reject(new Error('Unknown Vite development plugin: ' + pluginId));
  return import(/* @vite-ignore */ pluginUrl + '?t=' + timestamp)
    .then(module => module.load())
    .then(withDescriptor)
    .then(artifact => client.update(artifact));
};
let client;
const reloadWaiters = new Map();
const generationWaiters = new Map();
const developmentReloadPlugin = pluginId => new Promise((resolve, reject) => {
  if (!import.meta.hot) { reject(new Error('Vite HMR is unavailable')); return; }
  const requestId = crypto.randomUUID();
  const timeout = setTimeout(() => { reloadWaiters.delete(requestId); reject(new Error('Vite plugin reload timed out')); }, 10000);
  reloadWaiters.set(requestId, { pluginId, resolve, reject, timeout });
  import.meta.hot.send('cordisx:reload-plugin', { pluginId, requestId });
});
const requestPluginGeneration = (action, pluginId, moduleGeneration, transactionId) => new Promise((resolve, reject) => {
  if (!import.meta.hot) { reject(new Error('Vite HMR is unavailable')); return; }
  const requestId = crypto.randomUUID();
  const timeout = setTimeout(() => { generationWaiters.delete(requestId); reject(new Error('Vite plugin generation transaction timed out')); }, 10000);
  generationWaiters.set(requestId, { resolve, reject, timeout });
  import.meta.hot.send('cordisx:plugin-generation-transaction', { action, pluginId, moduleGeneration, transactionId, requestId });
});
const stagePluginGeneration = async (pluginId, moduleGeneration) => {
  const transactionId = crypto.randomUUID();
  const managedServiceUICapabilities = await requestPluginGeneration('stage', pluginId, moduleGeneration, transactionId);
  return {
    managedServiceUICapabilities,
    commit: () => requestPluginGeneration('commit', pluginId, moduleGeneration, transactionId),
    rollback: () => requestPluginGeneration('rollback', pluginId, moduleGeneration, transactionId),
  };
};
try {
  // Plugins can import cordisx/react. Load them only after the Host has
  // published the shared React runtime; static ESM imports would evaluate
  // before prepareCordisXViteReactRuntime() on a cold renderer.
  const modules = await Promise.all(pluginUrls.map(url => import(/* @vite-ignore */ url).then(module => module.load())));
  startup.check();
  const initial = descriptors.map(plugin => {
    const artifact = modules.find(item => item.plugin.id === plugin.id);
    return artifact ? withDescriptor(artifact) : { plugin, ownerDocumentBindings: [] };
  });
  client = new NativeViteDevelopmentClient({ ...${input.metadataSource}, developmentReloadPlugin }, initial, disposeSharedReactRuntime, stagePluginGeneration, certifiedPermissionChannel);
  certifiedPermissionChannel = undefined;
  globalThis.__cordisxViteClient = client;
} catch (error) {
  certifiedPermissionChannel?.dispose();
  disposeSharedReactRuntime();
  throw error;
}
const ready = client.restart((plugins, metadata, bootstrap, _signal, options) => {
  startup.check();
  return installCordisX(plugins, metadata, bootstrap, startup.signal, options);
});
if (import.meta.hot) {
  ${
    input.pluginImports.length === 0
      ? ''
      : `import.meta.hot.accept(${
        JSON.stringify(input.pluginImports)
      }, modules => { for (const module of modules) if (module) void module.load().then(withDescriptor).then(artifact => client.update(artifact)).catch(() => {}); });`
  }
  import.meta.hot.on('cordisx:reload-plugin-result', data => {
    const waiter = reloadWaiters.get(data.requestId);
    if (!waiter) return;
    reloadWaiters.delete(data.requestId);
    clearTimeout(waiter.timeout);
    if (data.error) { waiter.reject(new Error(data.error)); return; }
    replacePlugin(waiter.pluginId, data.timestamp).then(waiter.resolve, waiter.reject);
  });
  import.meta.hot.on('cordisx:plugin-generation-transaction-result', data => {
    const waiter = generationWaiters.get(data.requestId);
    if (!waiter) return;
    generationWaiters.delete(data.requestId);
    clearTimeout(waiter.timeout);
    if (data.error) waiter.reject(new Error(data.error)); else waiter.resolve(data.managedServiceUICapabilities);
  });
  import.meta.hot.on('cordisx:replace-plugin', data => {
    void replacePlugin(data.pluginId, data.timestamp).catch(error => console.error('[cordisx] Vite plugin replacement failed', error));
  });
}
return await ready;
}
`
}
