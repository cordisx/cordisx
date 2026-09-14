import { spawn } from 'node:child_process'

/** Static AppleScriptObjC program. Input is data in argv, never interpolated into source. */
export const WALLET_SPEND_NATIVE_SCRIPT = `
function run(argv) {
  ObjC.import('Cocoa');
  var input = JSON.parse(argv[0]);
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1);
  var alert = $.NSAlert.alloc.init;
  alert.messageText = 'CordisX Wallet';
  alert.informativeText = input.summary;
  alert.addButtonWithTitle('Cancel');
  alert.addButtonWithTitle('Approve exact terms');
  alert.buttons.objectAtIndex(1).keyEquivalent = '';
  var scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(0, 0, 640, 360));
  scroll.hasVerticalScroller = true;
  scroll.hasHorizontalScroller = true;
  var text = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, 620, 360));
  text.editable = false;
  text.selectable = true;
  text.richText = false;
  text.verticallyResizable = true;
  text.horizontallyResizable = false;
  text.maxSize = $.NSMakeSize(620, 10000000);
  text.textContainer.widthTracksTextView = true;
  text.font = $.NSFont.userFixedPitchFontOfSize(12);
  text.string = input.document;
  scroll.documentView = text;
  alert.accessoryView = scroll;
  app.activateIgnoringOtherApps(true);
  return Number(alert.runModal) === 1001 ? 'approved' : 'denied';
}`

/** A separate native process owns the complete scrollable document and approval event. */
export async function confirmWalletSpendNative(input: {
  readonly summary: string
  readonly document: string
  readonly signal: AbortSignal
}): Promise<boolean> {
  if (process.platform !== 'darwin' || input.signal.aborted) return false
  return new Promise(resolve => {
    const child = spawn('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      WALLET_SPEND_NATIVE_SCRIPT,
      JSON.stringify({ summary: input.summary, document: input.document }),
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    let output = '', complete = false
    const finish = (approved: boolean) => {
      if (complete) return
      complete = true
      input.signal.removeEventListener('abort', abort)
      resolve(approved)
    }
    const abort = () => {
      child.kill('SIGTERM')
      finish(false)
    }
    input.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', data => {
      output += data.toString()
      if (output.length > 128) abort()
    })
    child.on('error', () => finish(false))
    child.on('close', code => finish(!input.signal.aborted && code === 0 && output.trim() === 'approved'))
    if (input.signal.aborted) abort()
  })
}
