# Work-item Runs Implementation Plan

> Historical implementation plan. Current behavior and verification are documented in README.md and docs/verification.md.

**Goal:** Make board, workflow and records share stable workspace/item/Run identity with explicit acceptance and bounded factual history.

**Architecture:** Increment the existing storage contract with optional item/scope snapshots and per-Run bounded events. Worker alone validates all writes and acceptance; panel navigation retains exact Run IDs and never guesses by title. Existing native transport has no reliable resume contract, so expose manual processing guidance only.

**Tech Stack:** Orca trusted worker, JavaScript domain helpers, TypeScript component panel, node:test and Orca offline harness.

## Approved design and constraints
- Use incremental changes and preserve existing user records.
- Validation uses offline fixtures: do not operate other projects, launch real bots, retry blocked tasks, or read credentials.
- Preserve old data and frozen workspace/roles. Legacy runs lack event history until actual observed changes; no invented backfill.
- Four-stage execution completion is separate from user acceptance and sprint completion.

### Task 1: Worker contracts and regression tests
Files: tests/native-flow.test.mjs, worker/flow-domain.mjs, worker/main.mjs.
1. Add offline tests for stable item link, frozen acceptance/scope, deduplicated events, archive protection, manual legacy link and acceptance.
2. Run `node --test tests/*.test.mjs` and capture RED.
3. Add bounded event helpers; validate optional launch snapshots and exact workspace item ownership. Reject item completion with linked Run outside explicit acceptance.
4. Add confirmed same-workspace linking and confirmed acceptance handlers. Keep replay unavailable.
5. Re-run node tests to GREEN.

### Task 2: Shared UI navigation
Files: src/protocol.ts, src/panel.tsx, src/panel.test.ts.
1. Add offline panel tests for exact board → workflow → records → board navigation and workspace isolation.
2. Add shared selected Run/item atoms; board opens existing Run instead of another launch.
3. Workflow emphasizes selected task/epic/sprint, frozen role bindings, four-stage evidence, blockers/next action; collapse rules and templates when running.
4. Records retain independent workspace-scoped grouped list and selected details; no start/retry controls. Display factual events, receipts, raw errors, IDs and confirmed legacy linking.
5. Run Orca offline tests and fix regressions.

### Task 3: Verification and handoff
Files: docs/verification.md.
1. Run complete `orca plugin test`, `orca plugin check`, `orca plugin validate`, TypeScript `noEmit`, node tests and `git diff --check`.
2. Inspect changed authorization/storage/recovery paths; request independent read-only review if permitted (no extra developers).
3. Record actual evidence, remaining gaps, and send worker_done once. No commit/push.
