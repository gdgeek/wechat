# WeChat Pay request language implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this bounded task. Scope and execution are already authorized.

**Goal:** Prevent Node Fetch's wildcard language from causing WeChat Pay to reject payment API requests.

**Architecture:** Add one explicit header inside `Integrations.payment()`. Exercise the real Node HTTP transport against a loopback endpoint that returns RSA-signed success or rejection according to the received language.

**Tech Stack:** Node 24, TypeScript, Vitest, node:http, existing RSA test fixtures.

- [x] Confirm independent repository, clean baseline, and isolated branch at `d6bf62475106cceb31e94485ec942f35537e29e2`; existing payment integration tests: 52 passed.
- [x] Extend `tests/integrations.payments.test.ts` with a loopback server that returns signed HTTP 406 `PARAM_ERROR` for wildcard language and signed `{ data: [] }` HTTP 200 for `zh-CN`. Use real `fetch` to confirm the default rejection, then call `Integrations.payment('GET', '/v3/certificates')` through an origin-only transport adapter and expect the successful body.
- [x] Run `npm test -- tests/integrations.payments.test.ts -t 'uses a supported language with real Node fetch'` before the fix. Require a failure from the signed provider rejection, not a setup or network error. Save the output outside the repository.
- [x] In `src/integrations/integrations.ts`, add `'Accept-Language': 'zh-CN'` next to `Accept: 'application/json'` in the payment request headers, without other production changes.
- [x] Re-run the regression, then `npm test -- tests/integrations.payments.test.ts tests/integrations.test.ts tests/integrations-parity.test.ts tests/integrations.routes.test.ts`, `npm run build`, and `npm test`. Preserve exit codes and logs in `/private/tmp/wechat-pay-language-evidence/`.
- [x] Review the diff and `git diff --check`; commit only this fix, its regression test and these two documents. Hand the branch and test evidence to the parent for independent review. Do not push or deploy.

## Verification evidence

Runtime: Node 24.12.0. The loopback tests require permission to listen on
127.0.0.1; the initial sandbox-only attempt failed with EPERM and was not
counted as the red regression. The authorized local-server run produced:

- `01-red.log`: exit 1, the expected success rejected with `微信支付请求失败` after the signed HTTP 406 passed response verification.
- `02-green.log`: exit 0, regression passed with the one-header fix.
- `03-payment-tests.log`: exit 0, 4 files and 53 tests passed.
- `04-build.log`: exit 0, TypeScript build passed.
- `05-full-suite.log`: exit 0, 20 files / 272 tests passed; 4 files / 465 tests skipped because external integration opt-ins `RUN_INTEGRATION` and `V1_MYSQL_TEST_URL` were unset.

Only the existing Node SQLite experimental warning appeared. Logs are local
review evidence, not committed artifacts. No external payment request was made.
