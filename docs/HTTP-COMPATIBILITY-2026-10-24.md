# Yii compatibility refresh — 2026-10-24

The accepted reference is clean committed `gdgeek/game@64901c9ac79271aa54027c8c33abc6f1fa3c8394`. This refresh replaces the 2026-10-23 snapshot, which included local backend edits, with hashes of 212 committed backend, configuration, test and documentation files. Generated Codeception actor files are excluded. No deployment credentials are captured.

## Contracts synchronized

| Current Yii change | Node behavior and evidence |
| --- | --- |
| `AdminDeviceService` adds the device creation timestamp | Device list/update responses expose string `createdAt` from `device.created_at`. `updatedAt` still prefers the setup timestamp, then the device timestamp. Twelve focused regressions cover normalization and service responses. |
| `/v2/server/info` accepts a reported device version | The HTTP route defaults an omitted version to 0 and validates the same nonnegative int32 forms before storage access. A changed value writes only `device.version`, preserving timestamps and setup data. Internal helper calls without a version preserve the saved version. Forty-six focused regressions cover accepted/rejected forms and record preservation. |
| Payment controllers return the actual SDK callback response | All four successful payment/refund callbacks return HTTP 200 JSON `{"code":"SUCCESS","message":"成功"}` even with an XML Accept header. Eight actual Node HTTP regressions cover both media preferences. Existing v2 authoritative payment requery and retry responses remain intact. |
| `Wechat` and deployment config accept rotating platform certificates | `WECHAT_PLATFORM_CERTS` accepts a JSON array of X509 file paths, indexed by actual certificate serial. Invalid configuration is rejected before payment traffic. Thirty focused regressions cover dual serials, notifications, signed empty 204 responses, duplicate/conflicting paths, malformed input and configuration precedence. |
| New `WechatPayApplication`, `WechatPayClient`, `WechatPayServer` wrappers | Node already authenticates exact response/request bytes before consuming payment data or decrypting notifications, rejects non-success provider HTTP responses, and sends `Wechatpay-Serial` on every request. The rotation tests strengthen evidence for consecutive requests and multiple trusted serials. |
| Default issuer domain in `AdminTokenService` / `AdminTokenStore` | Already synchronized to `c.4mr.cn` in the preceding domain change. Explicit deployed issuer, keys and authentication Redis are retained. |
| Saved image-preview route and associated source tests/docs | Already implemented and covered by authenticated image-preview tests. No additional route or permission change is introduced. |

The existing `Accept-Language: zh-CN` payment fix from develop is retained when promoting this refresh to main. This release does not create a missing publish branch.

## Source and HTTP evidence

Re-capturing the strict Yii URL rules and reflection metadata produces the same 489 method/path declarations. All 250 resolvable declarations are covered, all 239 source 404 declarations and seven negative probes remain unavailable, with zero missing routes or unexplained extras. `npm run parity -- --source-root <clean-current-game-checkout>` also verifies every captured source hash against the committed reference.

The independent PHP HTTP oracle was executed against the clean reference using disposable local MariaDB 11.4 and Redis 7.4, with the repository's existing schema migrations applied. All **441/441** anonymous/precondition responses matched the stored expectations. Only the fixture's source revision, capture time and URL-configuration hash changed; no expected response was rewritten from Node output. These cases do not exercise successful customer operations or real provider traffic.

Local Node 24 validation with those isolated services passed **833/833 tests in 27 files**, with no skipped tests. TypeScript build, strict-source parity and `git diff --check` are required before upload. CI additionally gates image publication on MariaDB 10.4, MariaDB 11.4 and MySQL 8.4, including the production image's compiled migration command. Deployment and live routing are separate gates and must be recorded after the image is running.

## Retained boundaries

Compatibility does not mean every failure response is byte-for-byte identical:

- Node rejects unknown or cross-endpoint payment event categories, whereas the current PHP SDK may acknowledge a signed unknown event without running business handlers. Node also rejects signatures more than five minutes into the future, malformed timestamps, test signatures and unknown serials.
- Notification merchant/AppID validation and immutable local order/file/account/amount ownership remain mandatory. Callback data alone never unlocks a file; v2 rechecks the authenticated provider result, and unpaid results request a retry.
- Provider failures and internal errors remain sanitized. Diagnostic credential redaction, separate business/admin identity domains, configured-bucket STS restrictions and TLS verification remain enabled.
- The pre-existing broken QCloud action remains repaired with COS signing; legacy runtime crashes and PHP session/framework assets are not reproduced.

Modern explicit single-key configuration takes precedence over modern key maps, which take precedence over legacy primary/list values. A complete modern configuration can replace an unused legacy primary, but a configured invalid legacy certificate list is never ignored. Payment configuration errors are deferred to payment/notification use, so unrelated login and COS operations remain available.

No real charge, refund, customer login or physical device operation is performed by these tests. Production verification must use strict TLS on both nodes and the intended upstream Host/SNI, report the actual image commit, and preserve existing issuer/key/Redis configuration before switching the gateway.
