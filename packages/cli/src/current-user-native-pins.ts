/** Exact audited native account clients. Unknown builds must fail closed. */
export const CURRENT_USER_NATIVE_PINS = Object.freeze(
  [
    Object.freeze({
      appVersion: '26.903.61454',
      buildNumber: '8378',
      buildFlavor: 'prod',
      module: 'app://-/assets/app-initial-1b87ae739476.js',
      clientExport: 'gJt',
    }),
    Object.freeze({
      appVersion: '26.908.40834',
      buildNumber: '8881',
      buildFlavor: 'prod',
      module: 'app://-/assets/app-initial-9b95fa538c62.js',
      clientExport: 'mJt',
    }),
    Object.freeze({
      appVersion: '26.908.70816',
      buildNumber: '9275',
      buildFlavor: 'prod',
      module: 'app://-/assets/app-initial-4d7ea7f81c2d.js',
      clientExport: 'mJt',
    }),
  ] as const,
)
