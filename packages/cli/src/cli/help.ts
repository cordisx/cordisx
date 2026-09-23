export const HELP = `Usage:
  cordisx [app] [profile] [--data shared|host-isolated] [options] [-- host-arguments...]
  cordisx start|status|logs|stop|restart [app] [profile] [options]
  cordisx app [check|update]
  cordisx setup
  cordisx config
  cordisx doctor
  cordisx feedback <collect|inspect|export> [options]
  cordisx dev [plugin-path | --config path] [options] [-- host-arguments...]
  cordisx plugin <command> [options]
  cordisx source <command> [options]

Options:
  --attach                 Attach to an existing loopback CDP endpoint
  --system                 Use the host's system Chromium profile (escape hatch)
  --profile-dir <path>     Override this launch profile's independent Chromium directory
  --executable <path>      Override the host executable
  --debug-port <port>      Override the loopback CDP port
  --online-devtools        Allow the official online DevTools frontend
  --dry-run                Resolve and print the plan without starting the host
  --recover-startup        Replace a legacy start lock after older CordisX starts have exited
  --write-config           Enable plugin saves to an explicit dev --config file
  --work-scope-guard <scope/epoch>  Require the original dev work ledger identity on admission
  dev without a path       Discover .cordisx/config.json (or cordisx.config.json) upwards
  plugin --help            Show plugin management commands
  source --help            Show source management commands
  feedback --help          Show local, privacy-filtered feedback commands
  --create-shortcut        Create/update a macOS launch entry after readiness
  -h, --help               Show this help`
