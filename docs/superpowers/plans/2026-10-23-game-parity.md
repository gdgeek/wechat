# Game TypeScript parity implementation plan

> For agentic workers: use subagent-driven-development with independent ownership and review. Every checklist item requires implementation and verification evidence.

**Goal:** Preserve all production HTTP routes and business capabilities of the current gdgeek/game Yii2 working tree in gdgeek/wechat, using Node.js and TypeScript.

**Architecture:** A NestJS modular monolith with compatibility routing. Keep existing MySQL tables, Yii Redis ActiveRecord keys, response envelopes, pagination and JWT identity domains. Administration follows the current Yii game-admin ES256 Bearer/refresh-token contract and shared Redis state. External WeChat, WeChat Pay and Tencent Cloud adapters use native HTTP/crypto. No PHP process or forwarding to the old application.

**Tech stack:** Node.js 24 LTS, TypeScript, NestJS, mysql2, Redis, Vitest, Docker.

- [x] Inventory explicit routes, generated REST routes, data models and migrations against the Yii2 snapshot; keep invalid legacy routes documented separately.
- [x] Write failing contract tests for routing, JWT domains, model serialization, browser session and CSRF, device ownership, scene pagination, and replay prevention.
- [x] Implement shared parameterized MySQL repository and transaction support; preserve JSON fields and legacy Redis keys.
- [x] Port v1 identity, player/shop/device CRUD, game scoring, awards/gifts, checkin/local/report/file workflows and route response shapes.
- [x] Port v2 device/setup/file CRUD, dynamic scene defaults, state/report coordination, applet and file associations.
- [x] Port WeChat login/profile/phone, token refresh, payments/query/refund/callbacks, cloud STS and COS signed URLs for both versions.
- [x] Port admin password/session/CSRF/rate limits, device manager scope, atomic scan tickets and configuration writes; health and OpenAPI endpoints.
- [x] Scope confirmed: migrate backend only. Do not modify or copy Vue administration UI, small program, or the source repository deployment files. Preserve their existing HTTP contracts.
- [x] Provide repeatable schema/bootstrap migration, env template, Docker Compose and GitHub Actions.
- [x] Run build, contract/unit tests, isolated MySQL/Redis HTTP integration tests, route parity check and independent review. Document any external checks requiring real credentials.
- [x] Inspect repository diff for credentials and unrelated changes, commit and push to gdgeek/wechat; verify remote commit and CI.

## Acceptance

`npm ci && npm run build && npm test && npm run parity` must pass. Integration tests exercise a dedicated database and Redis database, never production. A route inventory alone does not prove functional parity; entries must link to implementation and behavioral tests. Payment/provider live acceptance and external hardware tests must remain explicitly distinct from locally verified behavior.

## Current-game alignment (2026-10-23)

The user approved aligning the Node backend with the current game backend while leaving every client unchanged. Comparison targets: remote game main `5fbcc93` plus the local device-version reporting change in `api/modules/v2/helper/Server.php`. Initial Node main: `74f935d`. Work only inside this separate repository on `codex/align-current-game`; preserve concurrent changes in the source checkout.

- [x] Replace admin browser Session/CSRF with the current independent ES256 game-admin JWT, rotating refresh token, eight-hour family deadline, revocation and shared Redis store. Preserve source key names, issuer/domain checks, fail-closed behavior and live device-manager scope. First write and observe failing contract tests, then implement in `src/admin/` and verify token interoperability and HTTP flows.
- [x] Align scan tickets with `X-Admin-Scan-Owner`, shared owner locks, same audience rules and once-only consumption; password/scan login return `{user, token, authMode:"jwt"}`. Test independent browsers, lock loss, replay and mixed Node/PHP state.
- [x] Reproduce and fix v1 numeric input validation and device version sorting, v2 nested wildcard field serialization, and UUID device version reporting. Implement regression cases in `tests/v1-contracts.test.ts` and `tests/v2.test.ts` before modifying their handlers.
- [x] Reproduce and fix provider compatibility: legacy PEM/path private keys, request-derived v1/v2 payment callbacks when no override is set, and duplicate phone binding response. Keep the provider transport injected and avoid live payments.
- [x] Refresh the independent source manifest/routes for the current admin refresh route. Add a source freshness check that compares an explicitly provided Yii checkout rather than only comparing stored manifests to each other.
- [x] Update real HTTP integration tests for the unchanged JWT frontend, shared token state, scan owner proof, refresh/revoke and concurrency. Run build/unit/parity plus isolated SQL/Redis integration tests, and independently review all changes.
- [x] Update README, environment/deployment guidance and validation record; publish the verified backend commit to gdgeek/wechat and check CI. External live credentials/hardware acceptance remains separately documented.

The new source-freshness gate detected concurrent device-deletion work during execution. Include its currently used DELETE endpoint and record-preservation semantics in this same backend-only alignment:

- [x] Port password-admin-only `DELETE /admin-api/devices/:id`, missing/forbidden responses, transactional cleanup, retained history and failure rollback; align conditional Record.device_id validation.
- [x] Add an idempotent record preservation migration and real populated-schema coverage for existing arbitrary-name CASCADE foreign keys, without changing business rows.
- [x] Recapture source evidence after this addition, then run all final checks and independent review.

Final local evidence: MySQL 8.4 and MariaDB 11.4 each pass all 197 tests; build, Docker production build, true PHP/Node ES256 + Redis interoperability and 249-route/current-source checks pass. Production provider/hardware acceptance remains external.

Final source gate caught the concurrent file-download contract before publication; this is the last included feature batch for this alignment snapshot.

- [x] Align current file ownership reads, removed write actions, per-recording integer-cent prices, unknown historical prices and the new nullable-price migration.
- [x] Align v2 file order preparation and authenticated payment confirmation/notification; preserve the v1 payment contract.
- [x] Align recordingPriceInCents with the frozen source and document retained legacy recording-key owner behavior.
- [x] Recapture this final source batch after all full SQL/HTTP tests, build, container and review checks pass. Publication and remote CI are recorded below.

- [x] Complete the immutable local file_payment_order reservation contract included in the final frozen source, preserving case-sensitive order identity, idempotent retry, owner checks and pending-payment responses.

Acceptance is pinned to source-manifest.json captured at 2026-10-22T17:52:58Z. Schema regeneration uses explicit YII2_MIGRATIONS pointing at that frozen directory; normal Node tests never silently read a changing parent checkout.

Published code: d5024cf0b7706c5db67bc916e3b28ad722cd8776 on gdgeek/wechat main. GitHub Actions run 39827497011 completed successfully for MySQL 8.4, MariaDB 11.4 and MariaDB 10.4. Local full tests are 197/197 on both tested database families; temporary task containers and network removed.
