export const PLUGIN_MANAGEMENT_HELP = `Usage:
  cordisx plugin list [--include-hidden] [--profile <profile>] [--json]
  cordisx plugin search <query> [--source <url-or-name>] [--include-hidden] [--profile <profile>] [--json]
  cordisx plugin info <plugin-id> [--source <url-or-name>] [--profile <profile>] [--json]
  cordisx plugin install <plugin-id> [--source <url-or-name>] [--version <version>] [options]
  cordisx plugin update <plugin-id> [--source <url-or-name>] [--version <version>] [options]
  cordisx plugin enable|disable|uninstall <plugin-id> [options]
  cordisx plugin hide|unhide <plugin-id> [--source <source-url>] [options]

Mutation options:
  --dry-run             Print the management plan without changing persistent state
  --yes                 Confirm the management change without prompting

Common options:
  --source <url-or-name> Select a Marketplace by canonical URL or its configured local name
  --profile <profile>   Select the configured Host profile
  --json                Emit machine-readable JSON
  -h, --help            Show plugin management help

--yes never approves plugin permissions. Permission review remains a separate
Host-owned action.`

export const SOURCE_MANAGEMENT_HELP = `Usage:
  cordisx source list [--profile <profile>] [--json]
  cordisx source add <url> [--name <name>] [--description <text>] [--trusted|--untrusted] [options]
  cordisx source edit <source-url> [--url <url>] [--name <name>] [--description <text>] [--trusted|--untrusted] [options]
  cordisx source enable|disable|remove <source-url> [options]
  cordisx source refresh [source-url] [options]

Mutation options:
  --trusted             Accept exact certification evidence published by this source
  --untrusted           Never use this source as a certification authority
  --dry-run             Print the management plan without changing persistent state
  --yes                 Confirm the management change without prompting

Common options:
  --profile <profile>   Select the configured Host profile
  --json                Emit machine-readable JSON
  -h, --help            Show source management help`
