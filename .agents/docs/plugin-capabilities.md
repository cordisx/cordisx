# Plugin capabilities and contribution paths

A CordisX plugin is an independently buildable, installable, and shareable
project. Whether a request belongs in a plugin or needs platform work first
depends on whether it can be implemented through a public, versioned CordisX
interface.

## What plugins can do

Through public interfaces, plugins can declare and implement:

- commands, actions, slots, and collection items;
- routes, pages, and CordisX Manager content;
- configuration schemas, permission requests, localized copy, and Host icons;
- business state and calls to granted Platform or Agent capabilities.

Plugins own business logic and data. CordisX owns rendering, lifecycle,
permissions, and Host adaptation.

## What plugins cannot do

Plugins cannot bypass CordisX to modify the Codex DOM, private React tree, or
unpublished interfaces. They cannot replace Host navigation, page chrome,
themes, accessibility behavior, or permission policy. When a public capability
does not exist, a plugin must report that it is unavailable instead of using a
private hook or hidden DOM patch to imitate support.

## When a capability is missing

If a request needs a new extension point, event, data projection, service, or
Host adapter, start with the concrete use case in
[CordisX Issues](https://github.com/cordisx/cordisx/issues), then contribute a
minimal, general, versioned public capability. Its public protocol and Host
implementation should include lifecycle, permissions, localization,
accessibility, tests, and documentation. Once released, plugins can consume it
through the public interface.

If the missing primitive is general context, service composition, or lifecycle
behavior independent of any Host, contribute it to the underlying
[Cordis](https://github.com/deepseek-ai/DeepSeek-Harness). Do not move
Host-private behavior into Cordis to bypass the platform boundary.

Read the [contribution guide](../../CONTRIBUTING.md) before submitting code.
