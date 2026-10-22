# Game TypeScript parity implementation plan

> For agentic workers: use subagent-driven-development with independent ownership and review. Every checklist item requires implementation and verification evidence.

**Goal:** Preserve all production HTTP routes and business capabilities of the current gdgeek/game Yii2 working tree in gdgeek/wechat, using Node.js and TypeScript.

**Architecture:** A NestJS modular monolith with compatibility routing. Keep existing MySQL tables, Yii Redis ActiveRecord keys, response envelopes, pagination, JWT identity domains, and browser Session/CSRF boundaries. External WeChat, WeChat Pay and Tencent Cloud adapters use native HTTP/crypto. No PHP process or forwarding to the old application.

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
