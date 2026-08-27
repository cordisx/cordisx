# Permission V2 Smoke — Expanded Update

This development-only package is the version `1.1.0` update fixture for Permission V2 Smoke. It keeps the same public command probes while exercising package update, permission-scope expansion, and module-generation invalidation through the Host-owned lifecycle.

## What it validates

- the updated package can replace the earlier explicit-local fixture;
- the Host recomputes permissions for the new package generation;
- stale module-generation authority cannot survive the update;
- the Agent-event and task-catalog probes still pass through the public brokers.

An installed or active state does not prove that either requested capability was granted. Review the Manager permission and runtime diagnostics for the current generation.

## Current boundary

This package is an unsigned update fixture, not a standalone product plugin. Its package id intentionally matches Permission V2 Smoke so it can exercise replacement behavior in controlled tests.
