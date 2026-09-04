# Feasibility assessment

Run this assessment before creating a project or editing an existing plugin for
a requested product behavior. The goal is to distinguish a supported plugin
from a platform capability gap without burdening straightforward requests with
an architecture discussion.

## Establish evidence

Translate the request into the smallest set of required surfaces, triggers,
data, effects, and permissions. Then inspect the installed CordisX version:

- public, versioned contracts and injected services;
- extension-point and structured-presentation catalogs;
- the active Host adapter's supported, degraded, or unavailable capabilities;
- maintained examples and tests that exercise the same public seam; and
- lifecycle, permission, localization, packaging, and trust constraints.

A visible Codex control, DOM node, renderer global, private bridge, or internal
React state is not evidence of a plugin capability. A declared type without an
active Host adapter is also not enough to claim support.

## Classify the request

Use one of these outcomes:

- **Plugin-ready:** A public contract and active Host implementation cover the
  behavior. Proceed with the independent plugin without asking for another
  confirmation.
- **Plugin-ready with degradation:** The core behavior is public, but an
  optional capability may be unavailable. Proceed only with an honest disabled
  or unavailable state; tell the user about the material limitation.
- **CordisX capability gap:** The behavior needs a new Host event, command,
  structured presentation, data projection, permission, service, extension
  point, or adapter implementation. Do not scaffold or patch private Host
  internals. Explain the missing public seam and propose a CordisX contribution.
- **Cordis capability gap:** The missing primitive is general context, service
  composition, dependency, or lifecycle behavior independent of CordisX and
  any specific Host. Propose the primitive in Cordis first, followed by the
  smallest CordisX adoption change.
- **Not viable:** The request conflicts with the Host trust boundary or cannot
  be expressed safely even with a reasonable public capability. Explain the
  constraint and, when possible, offer a supported product alternative.

## Route a capability contribution

For a CordisX gap, describe the smallest reviewable path:

1. the user outcome and host-neutral public contract;
2. a versioned Protocol change when the contract crosses package boundaries;
3. the Host runtime or adapter implementation with permission and lifecycle
   ownership;
4. localization, accessibility, focused tests, and public documentation; and
5. the plugin change that consumes the released contract.

For a Cordis gap, keep the proposal host-neutral. Do not move Codex selectors,
private renderer behavior, or CordisX policy into Cordis merely to bypass a
CordisX boundary.

An ordinary plugin request authorizes only the plugin. When a gap exists, ask
whether the user wants the platform contribution after presenting the bounded
path. If the user already requested the PR or the missing capability itself,
do not ask again; follow the owning repository's contribution workflow.

## Communicate the result

For a plugin-ready request, keep the assessment implicit and proceed. In the
final result, name the public capability used and any real limitation. For a
gap or non-viable request, lead with the feasibility conclusion, name the exact
missing seam, and give the minimal PR path. Never claim that a private fallback
made the request feasible.
