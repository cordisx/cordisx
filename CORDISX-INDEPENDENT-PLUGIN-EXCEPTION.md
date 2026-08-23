# CordisX Independent Plugin Exception

Version 1.0, 24 August 2026

This Exception is an additional permission under section 7 of the GNU Affero
General Public License, version 3 or any later version (the "AGPL"). It applies
only when a CordisX covered work includes a notice that this Exception applies.

## 1. Definitions

"Public Stable Plugin Interface" means a versioned interface that CordisX
public documentation expressly identifies as a public plugin interface. For
this beta, that term is limited to:

- the public exports of `cordisx/contracts`;
- the versioned plugin, manifest, capability, structured-contribution, command,
  route, page, outlet, locale, and extension-point schemas published by
  `cordisx/cordisx-protocol`; and
- behavior required to invoke those exports and schemas through the documented
  CordisX plugin lifecycle.

"Interface Material" means only the declarations, type definitions, schemas,
and minimal interface examples that are reasonably necessary to implement or
use a Public Stable Plugin Interface. It does not include an implementation of
the CordisX host, runtime, CLI, manager, launcher, adapter, or any private or
undocumented interface.

"Marked Template Material" means the files distributed inside
`packages/create-cordisx-plugin/template`, and the corresponding files in a
project generated from that template.

"Independent Plugin" means a work whose purpose is to add plugin functionality
to CordisX, which interacts with CordisX exclusively through Public Stable
Plugin Interfaces, and which does not copy, modify, embed, or incorporate any
other portion of a CordisX covered work except Interface Material or Marked
Template Material as permitted below.

## 2. Additional permission for independent plugins

Notwithstanding the AGPL, you may:

1. use, reproduce, and adapt Interface Material only as reasonably necessary to
   create, build, test, document, distribute, or run an Independent Plugin;
2. use, reproduce, and adapt Marked Template Material to create an Independent
   Plugin; and
3. license, distribute, sell, and commercially exploit that Independent Plugin
   under terms chosen by its copyright holder, including proprietary terms.

An Independent Plugin is not required to be licensed under the AGPL merely
because it uses a Public Stable Plugin Interface, uses Interface Material as
permitted above, was created from Marked Template Material, or runs together
with CordisX.

## 3. No exception for CordisX host code

This Exception does not grant permission beyond the AGPL for any work that
copies, modifies, embeds, incorporates, or repackages CordisX host, runtime,
CLI, manager, launcher, adapter, or `create-cordisx-plugin` implementation
code, other than Marked Template Material. It does not cover a substitute or
competing host implementation, or any use of private or undocumented CordisX
interfaces. Those works remain governed by the AGPL.

## 4. Notices and trademarks

When you distribute Interface Material or Marked Template Material itself, you
must keep a copy of this Exception or an accessible reference to it. This
Exception grants no rights in CordisX names, logos, or trademarks.

## 5. Status of this exception

This is a CordisX-specific additional permission. It is not a standard SPDX
license exception and has not been reviewed or approved by the Open Source
Initiative or the Free Software Foundation. Legal review is recommended before
the first stable CordisX release.
