# Lifecycle Smoke

This local-only package fixture exercises the CordisX v1 package lifecycle in
an isolated renderer. It contributes one structured route, page, command, and
sidebar item. Global counters record `apply`, `dispose`, and command invocation
so a smoke run can verify owning-fiber reload and complete uninstall cleanup.

Install the absolute directory through Manager → Plugins → Install local
plugin. The permission review contains one optional `models.read` declaration;
the fixture does not require it to activate.

This fixture does not demonstrate remote download, package signing, or a
security sandbox. Its canonical source is public and contains no local path,
configuration, or credential data.
