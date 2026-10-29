const valueOptions = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '-p',
  '--profile',
  '-C',
  '--cd',
  '--startup-client-info',
  '--cloud-skills-snapshot',
  '--code-mode-host',
  '--listen',
  '--ws-auth',
  '--ws-token-file',
  '--ws-token-sha256',
  '--ws-shared-secret-file',
  '--ws-issuer',
  '--ws-audience',
  '--ws-max-clock-skew-seconds',
])
const switches = new Set(['--analytics-default-enabled', '--strict-config', '--startup-sign-out'])
const help = new Set(['--help', '-h', '--version', '-V'])
const tools = new Set(['generate-ts', 'generate-json-schema', 'help', 'daemon'])

/** Only a serving stdio invocation owns chat's private control peer. Values are never interpreted as commands. */
export function nativeCliInvocation(args) {
  let appServer = false, transport = 'stdio://'
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (help.has(argument)) return 'help-or-version'
    if (appServer && argument === '--print-startup-config') return 'startup-config'
    if (appServer && tools.has(argument)) return 'app-server-tool'
    if (appServer && argument === '--stdio') {
      transport = 'stdio://'
      continue
    }
    if (switches.has(argument)) continue
    const equals = argument.indexOf('=')
    const option = equals < 0 ? argument : argument.slice(0, equals)
    if (valueOptions.has(option)) {
      const value = equals < 0 ? args[++index] : argument.slice(equals + 1)
      if (value === undefined) return 'unsupported-arguments'
      if (option === '--listen') transport = value
      continue
    }
    if (argument.startsWith('-c') && argument.length > 2) continue
    if (!appServer && argument === 'app-server') {
      appServer = true
      continue
    }
    // The native CLI remains responsible for unsupported command syntax and validation.
    return 'other-cli'
  }
  return appServer && transport === 'stdio://' ? 'app-server-stdio' : 'other-cli'
}
