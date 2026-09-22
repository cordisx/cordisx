import { spawn } from 'node:child_process'
import { CatalogError } from './contracts.js'

export const MANAGED_PROVIDER_CAPTURE_SCRIPT = `
function run() {
  ObjC.import('Cocoa');
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1);
  var alert = $.NSAlert.alloc.init;
  alert.messageText = 'CordisX Provider credential';
  alert.informativeText = 'Enter the API key for this CordisX-managed connection.';
  alert.addButtonWithTitle('Cancel');
  alert.addButtonWithTitle('Save');
  var field = $.NSSecureTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 420, 24));
  alert.accessoryView = field;
  alert.window.initialFirstResponder = field;
  app.activateIgnoringOtherApps(true);
  return Number(alert.runModal) === 1001 ? JSON.stringify({key:ObjC.unwrap(field.stringValue)}) : '{}';
}`

/** Static native prompt; the key travels only over this child's private stdout pipe. */
export function captureManagedProviderCredential(signal: AbortSignal): Promise<string> {
  if (process.platform !== 'darwin' || signal.aborted) return Promise.reject(new CatalogError('cancelled'))
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MANAGED_PROVIDER_CAPTURE_SCRIPT], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = '', failed = false
    let kill: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      failed = true
      child.kill('SIGTERM')
      kill ??= setTimeout(() => child.kill('SIGKILL'), 1_000)
      kill.unref?.()
    }
    const deadline = setTimeout(abort, 60_000)
    signal.addEventListener('abort', abort, { once: true })
    const cleanup = () => {
      clearTimeout(deadline)
      clearTimeout(kill)
      signal.removeEventListener('abort', abort)
    }
    child.stdout.on('data', data => {
      output += data.toString()
      if (output.length > 16_384) abort()
    })
    child.once('error', () => {
      cleanup()
      reject(new CatalogError('credential-unavailable'))
    })
    child.once('close', code => {
      cleanup()
      try {
        if (failed || signal.aborted || code !== 0) throw new Error('cancelled')
        const value = JSON.parse(output)
        output = ''
        if (typeof value.key !== 'string' || !value.key || value.key.length > 8192 || /\s/u.test(value.key)) {
          throw new Error('cancelled')
        }
        resolve(value.key)
      } catch {
        reject(new CatalogError('cancelled'))
      }
    })
    if (signal.aborted) abort()
  })
}
