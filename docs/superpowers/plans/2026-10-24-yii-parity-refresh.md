# Current Yii2 Compatibility Refresh Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to execute the disjoint tasks below, with test-first changes and independent spec and quality reviews.

**Goal:** Match the backend changes in `gdgeek/game@64901c9ac79271aa54027c8c33abc6f1fa3c8394` before replacing the `x.b0` / `x.b1` upstreams with `x2.b0` / `x2.b1`.

**Architecture:** Keep the existing Node route, database, authentication and response layers. Add the missing device creation timestamp and `/v2/server/info` version-reporting behavior, then refresh the source provenance only after every changed PHP file has been classified. Preserve the already verified payment language fix on develop.

**Tech Stack:** TypeScript, NestJS/Express, mysql2, Redis, Vitest; Yii2 source and its regression tests are the compatibility reference. Use Node 24 (`PATH=/Users/dirui/.nvm/versions/node/v24.12.0/bin:$PATH`) locally.

## Reference and boundaries

- Clean Yii reference: `/private/tmp/game-c4mr-publish-20261024`, commit `64901c9ac79271aa54027c8c33abc6f1fa3c8394`.
- Node release worktree: `/private/tmp/wechat-yii-parity-20261024`, based on `origin/develop@14de80a9a70f311f69275b00ebf6812489d28d9c`.
- Initial device/auth production PHP differences: `api/components/AdminDeviceService.php`, `AdminTokenService.php`, `AdminTokenStore.php`, `api/modules/v2/controllers/ServerController.php`, `api/modules/v2/helper/Server.php`.
- Clean-source audit also found payment SDK/controller changes, three new payment adapter classes, and `files/api/config/web.php`; these are classified in the release audit, with two missing behaviors below.
- Token service/store differences are only the default issuer domain and are already mirrored. No JWT key regeneration, identity-domain changes, authorization-scope changes or bulk rewrites of Redis/device business data are authorized by this implementation.
- `updatedAt` remains setup timestamp first, otherwise device timestamp. Do not introduce a maximum-of-timestamps rule.
- Keep legacy mini program version 0 on `https://x.4mr.cn/v2`; version 1 uses `https://c.4mr.cn/api/v2`.

## Task 1: Device creation timestamp

**Files:** `src/admin/devices.ts`; new `tests/admin-created-at.test.ts`.

- [x] Add contract tests against `normalizeDevice` and the existing service response: device `created_at` must be exposed as string `createdAt`, independently of setup timestamps; null/missing values become `''`.
  ```ts
  expect(normalizeDevice({ id: 1, created_at: '2026-10-23 09:10:11', updated_at: 'device-time' }, { updated_at: 'setup-time' }))
    .toMatchObject({ createdAt: '2026-10-23 09:10:11', updatedAt: 'setup-time' });
  ```
- [x] Run `npm test -- tests/admin-created-at.test.ts --maxWorkers=1`; verify failure because `createdAt` is missing.
- [x] Add only the missing `createdAt: String(device.created_at ?? '')` response field. Preserve all existing field and permission behavior.
- [x] Run the new tests plus `tests/admin.test.ts`, `tests/admin-jwt.test.ts`, and `tests/device-delete.test.ts`; verify success.
- [x] Independently review contract compliance and then code quality.


## Task 2: Server info version reporting

**Files:** `src/v2/index.ts`, `src/v2/server.ts`; new `tests/server-info-version.test.ts`.

- [x] Add tests that `/v2/server/info` defaults missing `version` to 0; accepts the same nonnegative int32 integer/query-string forms as PHP; and rejects negative, fractional, nonnumeric, array and out-of-range values with HTTP 400 before persistence.
- [x] Cover existing/new UUIDs, unchanged version performing no write, changed version updating only `device.version`, unchanged `updated_at`/setup fields, default-scene failures creating no orphan device, and internal `getInfo(s, uuid)` preserving a previously reported version.
  ```ts
  await expect(request({ uuid: 'known', version: '-1' })).rejects.toMatchObject({ status: 400 });
  expect(dbWrites).toEqual([]);
  await request({ uuid: 'known', version: '2' });
  expect(dbWrites).toContainEqual({ sql: 'UPDATE device SET version = ? WHERE id = ?', params: [2, 7] });
  expect(device.updated_at).toBe(originalUpdatedAt);
  ```
- [x] Run the new test file and confirm expected failures before implementation.
- [x] Reuse the existing version validator rather than adding a conflicting parser; route validation occurs before `getInfo` persistence. Extend the helper with optional validated version defaulting to `null`, and perform a direct version-only SQL update only when it differs.
- [x] Run the new tests with `tests/v2.test.ts` and record-preservation tests; verify success.
- [x] Independently review contract compliance and then code quality.


## Task 3: Payment callback acknowledgements

**Files:** `src/integrations/routes.ts`, `tests/integrations.payments.test.ts`, focused new callback regression tests if needed.

- [x] First add failing tests for all four successful notify/refund routes: JSON `{code: 'SUCCESS', message: '成功'}`, including XML Accept headers.
- [x] Return the current Yii SDK acknowledgement and force JSON for v1 notify and v1/v2 refund-notify. Preserve verified v2 business handlers and stronger signature/merchant/timestamp/event checks.
- [x] Run targeted payment and HTTP tests, then independent spec and quality review. Use stubbed provider transports; no real transactions.

## Task 4: Legacy rotating platform certificates

**Files:** `src/integrations/integrations.ts`, targeted environment tests and fixture certificates.

- [x] First add failing tests for `WECHAT_PLATFORM_CERTS` JSON path arrays, X509 serial indexes, two serial rotation, duplicate/conflicting serials, malformed/invalid/missing files, and variable precedence.
- [x] Add strict legacy certificate support. Preserve explicit modern single-key > modern map > legacy primary/list precedence. Invalid configured legacy arrays must fail closed even when modern keys overlap.
- [x] Reject incomplete or damaged legacy verification configuration before an outgoing payment request; retain supported modern-only map configurations.
- [x] Run targeted integration tests, then independent spec and quality review. Never print real key material.

## Task 5: Source provenance and complete verification

**Files:** `docs/source-manifest.json`, `docs/route-parity.json`, compatibility documentation, this checklist.

- [x] Classify every manifest difference against the clean Yii reference, including source tests/docs. Record why every production delta is mirrored or already identical.
- [x] Refresh hashes and source revision to the committed reference. Re-capture route metadata using `php scripts/capture-source-routes.php /private/tmp/game-c4mr-publish-20261024`; retain reviewed route behavior/test mappings and all intentional 404/verb preservation rules.
- [x] Run `npm run parity -- --source-root /private/tmp/game-c4mr-publish-20261024`; require zero stale source files, missing routes, unexplained extras and unexplained response/verb changes.
- [x] Run `npm test -- --maxWorkers=2 --no-file-parallelism`, `npm run build`, and `git diff --check`. Use CI's real MySQL/MariaDB/Redis matrix for the integration gate; do not hide unavailable local service tests.
- [x] Complete independent whole-diff review before release.


## Task 6: CI, runtime verification and conditional switch

- [ ] Commit only this compatibility refresh. Push develop and wait for the exact commit's complete CI success.
- [ ] Merge the verified develop work into a clean worktree from latest origin/main, retaining the payment language fix; verify and push main, then wait for its complete CI success. Do not create an absent publish branch.
- [ ] Update the Node deployments to the verified image using existing credentials/configuration. Check both x2 endpoints with strict TLS, shared database/Redis and unchanged authentication configuration. No real payment or destructive business-data tests.
- [ ] Confirm Nginx's actual upstream Host/SNI is accepted by both Node nodes before changing routing; test both fixed nodes and the automatic gateway.
- [ ] Only after both nodes and compatibility gates pass, switch the existing management and mini program upstream configuration to the two Node origins, then verify health/commit, login/permission contracts, new version reporting and frontend response fields.
- [ ] Preserve the original dirty checkouts, clean only this task's worktrees, and record exact CI SHAs/run URLs and any remaining platform/manual verification limits.
