# CordisX user experience Q&A

This guide records reusable, evidence-backed answers to common CordisX usage
questions that span more than one product guide. It does not replace versioned
product documentation. Each answer states where it applies and points to its
basis; a repeated experience becomes a product rule only when the owning
documentation or public contract says so.

For installation and launch failures, use the existing
[startup Q&A](startup-qa.md) instead of duplicating it here.

## How do I choose the right source when several sources contain plugins?

**Answer:** Keep source management and plugin commands on the same selected
profile. Pass either the canonical source URL or the exact short name previously
configured for that profile. A short name is only a local convenience: it does
not change source identity, and resolution fails rather than guessing when the
name is missing, disabled, or ambiguous.

**Applies when:** More than one Marketplace source is configured or the same
source is used from multiple CordisX profiles.

**Basis:** [Manage plugins and discovery sources](getting-started.md#manage-plugins-and-discovery-sources)
defines profile-local name resolution. [Marketplace source management](marketplace-source-management.md#source-store)
defines the canonical URL as source identity and preserves source configuration
independently of cached feed data. Use the complete command flow from those
owner guides rather than copying it into Q&A.

## Why can a plugin be installed while its model is still unavailable?

**Answer:** Installation, activation, permission review, provider readiness,
and external account authentication are different states. An installed artifact
may remain inactive when required permissions or readiness fail. A model provider
must also have a ready service and any plugin- or provider-owned login or API-key
setup; branding or an installed settings page does not establish that readiness.

**Applies when:** A plugin appears in installed-plugin management but its models
or provider action are unavailable. Native model providers are currently
documented as experimental, so verify the installed version's support.

**Basis:** [Dynamic plugin lifecycle](dynamic-plugin-lifecycle.md#install-and-upgrade)
separates staging, permission authorization, readiness, and activation.
[Native model providers](native-model-providers.md#ownership) separates provider
registration and readiness from authentication or API-key setup. Follow the
owning plugin or provider documentation for its actual login flow.

## Should I reinstall CordisX when I want to keep my existing configuration and login?

**Answer:** Usually not. Start the same named profile in `shared` data mode to
reuse the existing Codex account, conversations, projects, models, Host
configuration, and that profile's CordisX source/plugin settings. Use
`host-isolated` only when separate Host data is intentional. Diagnose the
selected profile, activation, or external login before replacing an installation.

**Applies when:** A previously working setup appears empty, logged out, or
differently configured after changing commands or profiles.

**Basis:** [Startup Q&A](startup-qa.md#what-is-the-difference-between-shared-and-host-isolated)
and [the getting-started profile guidance](getting-started.md#configure-cliproxyapi-providers)
describe the shared and isolated data boundaries. A changed plugin version or
permission declaration may still require normal review; reuse of a profile is
not a promise that every reinstall can bypass permissions.

## Do I need to choose a CordisX Skill before asking for help?

**Answer:** No. Describe the goal to the `cordisx` entry. It routes standard
documentation, practical Q&A, and plugin-development work to the relevant
bundled guidance in the same task. The underlying Skills remain independently
discoverable for clients or users that invoke them directly.

**Applies when:** The installed CordisX distribution includes the `cordisx`
entry and its compatible sibling Skills. A third-party Skill picker is not
required to hide the sibling entries or reproduce CordisX routing.

**Basis:** The bundled Skill set and the installed launcher's deployment
behavior. Check the installed version before claiming that all entries are
present.

## Does a third-party plugin need a CordisX package scope?

**Answer:** No. A plugin may use any legal unscoped package name or a scope the
publisher controls. The plugin id, package name, and distribution metadata must
still satisfy the applicable public contract and registry rules.

**Applies when:** Developing or distributing a third-party plugin. CordisX's
own repository naming, branch, approval, and release conventions apply to
CordisX-owned changes, not to admission of third-party plugins.

**Basis:** Public plugin compatibility is defined by the versioned Protocol and
Host package contracts, not by the maintainer workflow of this repository.

## Must every plugin change launch the native App?

**Answer:** No. Match verification to the claim. Markdown, metadata, static
schema, and other non-runtime changes can use focused checks. A Playground may
cover behavior that it actually hosts. Claims about native `app://` behavior,
Host injection, native layout, or native lifecycle require the real native path
and explicit authorization to start it.

**Applies when:** Selecting evidence for plugin development or documentation.

**Basis:** [Host testing](testing.md), the
[native development guide](vite-native-development.md), and the plugin
development Skill's verification reference.

## Does asking a question authorize CordisX to change my environment?

**Answer:** No. Reading documentation or asking for experience is read-only.
It does not authorize a configuration edit, permission grant, App launch,
upload, publication, or release. A later explicit implementation request may
authorize the relevant change, subject to the active repository, Host, and tool
permissions.

**Applies when:** The user asks how something works, what is available, or why
an observed behavior occurred without requesting a change.

**Basis:** CordisX authority is action- and owner-specific. Guidance can explain
an authorization path but cannot manufacture a grant.

## Will CordisX automatically publish what I tell it as experience?

**Answer:** No. A conversation is not a public Q&A record. When you ask to save
experience, it can go into your own notes or a project Q&A; access to CordisX's
documentation repositories is not required. If a shared source is unavailable,
a local draft preserves the experience without publishing it. Contributions to
shared documentation need a suitable owning document, evidence, and removal of
private or internal-only details. An observation stays contextual unless a
maintained product source establishes it as a general rule.

**Applies when:** A user wants a workaround, decision, or lesson preserved for
future users.

**Basis:** The Host documentation maintenance rule separates public product
guidance from temporary coordination, private evidence, and user data.
