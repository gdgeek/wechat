# Yii HTTP compatibility and deployment plan

> For agentic workers: use focused parallel tasks with independent review and test-first fixes.

**Goal:** Align the Node backend with the current Yii backend's routes, request handling, response contracts and business behavior, then deploy the verified image to b0 and b1.

**Architecture:** Retain the Node/Nest application, existing databases and identity domains. Compare against a frozen copy of Yii sources captured on 2026-10-23 at 02:42:40 Asia/Shanghai, from game HEAD `412ce84b7a6c3f33d0917e5be35435f04db842e1` plus current uncommitted backend changes. Frontend, mini-program and original Yii files remain outside the change scope. Provider tests use controlled transports; production verification uses read-only probes.

**Tech stack:** Node 24, TypeScript, Nest/Express, PHP/Yii reference runner, Vitest, MariaDB/MySQL, Redis, GitHub Actions and Portainer.

- [x] Preserve existing working changes and freeze the current Yii source with hashes; identify changes since the previous accepted snapshot.
- [x] Core HTTP: reproduce error type, unresolved-route HTML, content negotiation, request parsing and health timeout differences in focused failing tests; implement source-equivalent responses and bounded health checks in `src/application.ts` and `src/core/`.
- [x] Business APIs: compare v1/v2 controllers/models/helpers with `src/v1/` and `src/v2/`, add regression tests for concrete differences in validation, pagination, serialization and timestamps, then fix them.
- [x] Admin and providers: implement newly added image previews and device version fields; compare admin authentication/scan tickets and provider/payment adapters; test failures and successful behavior without live charges.
- [x] Source-derived validation: regenerate the independent route snapshot and source manifest, retain invalid source routes, and extend tests to exercise actual HTTP requests against the reference where feasible.
- [x] Run all unit/contract tests plus isolated database/Redis integration tests, production build and source-route freshness checks. Review the final diff and unresolved findings before publication.
- [x] Publish through the existing CI pipeline only after local checks pass; require every database matrix job and image publication to succeed before deployment.
- [x] Deploy the verified `wechat2` image to both existing Stacks; confirm running image commit/digest, container health and read-only response comparisons on both x2 domains against x domains.
- [x] Record exact test results, source baseline, CI run and deployment evidence. Distinguish tested compatibility from external real-transaction/device acceptance; never infer universal equivalence from route coverage alone.

Verification commands use Node 24: `npm run build`, `npm test`, `npm run parity -- --source-root /private/tmp/wechat-yii-align-20261023`, plus `RUN_INTEGRATION=1` against a dedicated localhost test database and Redis instance. The CI matrix covers MariaDB 10.4, MariaDB 11.4 and MySQL 8.4. Production writes, real payments/refunds and device commands are not test fixtures.

- [ ] Complete Swagger credential migration and authenticated production verification after explicit credential-reuse authorization. Both new Stacks currently lack SWAGGER_USERNAME/PASSWORD; anonymous Swagger 500 versus Yii 401 remains documented. Automatic approval rejected reuse without this authorization; user choice is pending.
