/** Keep the initial owned manifest within a wall-clock budget and its installation lifetime. */
export function nativeViteManifestLoaderSource(url: string): string {
  return `(() => {
    const controller = new AbortController(), signal = controller.signal;
    const check = () => signal.throwIfAborted();
    const owner = {
      signal,
      abort: () => controller.abort(Error('CordisX Vite startup canceled')),
      check,
      read: async () => {
        const deadline = setTimeout(() => controller.abort(Error('CordisX Vite manifest fetch timed out')), 20000);
        try { for (;;) {
          check();
          try { return await new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            Promise.resolve(fetch(${JSON.stringify(url)}, { signal })).then(resolve, reject)
              .finally(() => signal.removeEventListener('abort', abort));
            if (signal.aborted) abort();
          }); } catch (error) {
            check();
            await new Promise((resolve, reject) => {
              const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
              const timer = setTimeout(finish, 250);
              const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            });
          }
        } } finally { clearTimeout(deadline); }
      },
    };
    globalThis.__cordisxViteStartupAbort = owner.abort;
    return owner;
  })()`
}
