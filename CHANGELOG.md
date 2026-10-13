# Changelog

## 0.1.3 — 2026-10-12

- Performance: one pass over the request payload instead of two; this runs on every provider request.
- Code: no `let` bindings; mutable state lives in one named object. Behaviour is unchanged.
- Tests run with temporary Pi and prjct folders, so they never touch your real configuration.

## 0.1.2 — 2026-10-06

- Preserve conversation and reasoning by default. Make payload pruning explicit and stop recommending compaction on model changes.

- Move to an independent repository and release with declared npm dependencies.
