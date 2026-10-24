# Yii HTTP compatibility verification — 2026-10-23

Historical release record. The current committed-source comparison and callback contracts are recorded in [the 2026-10-24 refresh](HTTP-COMPATIBILITY-2026-10-24.md).

This backend-only update compares against game HEAD `412ce84b7a6c3f33d0917e5be35435f04db842e1` and its local backend edits frozen at **02:42:40 Asia/Shanghai**. File hashes are in `source-manifest.json`; this is a defined acceptance baseline, not a claim that future changes in another repository are automatically mirrored.

## Aligned contracts

- All **250 source-resolvable method/path pairs** are registered, including the new authenticated device image-preview endpoint. The source's 239 missing-action/controller declarations and seven additional negative route probes remain unavailable.
- HTTP responses preserve public Yii exception class names, status names, JSON/XML negotiation, HEAD content types, strict URL patterns, PHP path decoding, request method overrides, repeated parameter handling and lazy JSON errors after authentication. Unresolved routes return an HTML error page with the source Cache-Control, Expires and Pragma cache policy, including HEAD.
- Health checks return Shanghai timestamps and build-time formatting, validate Redis PONG, and bound both stalled handshakes and PING reads. Build commit and time continue to describe the actual Node image.
- Admin device responses include version; previews sign only images saved on authorized devices within the configured COS bucket, using the original 300-second lifetime.
- v1/v2 regressions cover model validation, search filters and wildcard escaping, PHP numeric/empty conversions, raw model create/update responses versus subsequent database reads, SQL timestamp-expression serialization, role updates and financial validation before writes.
- WeChat and payment regressions cover parameter binding, profile/login limits, signed provider requests/responses, callback decryption, immutable local order ownership and amount checks. A notification whose authoritative query still says unpaid returns HTTP 500 with the SDK-compatible retry envelope, rather than acknowledging success.

## Independent HTTP oracle

`tests/fixtures/yii-anonymous-http.json` contains **441 actual PHP/Yii responses**, grouped by identical response, for anonymous requests, authentication/precondition failures, declared missing routes and OPTIONS fallbacks. Expected values were obtained by running the frozen Yii controllers against disposable local MariaDB/Redis, not derived from Node handlers. `tests/integration/yii-http.test.ts` checks the Node service against every case and verifies source provenance.

The reference can be checked again with:

```sh
node --import tsx scripts/verify-yii-http.ts \
  --source-root /path/to/accepted-game-checkout \
  --reference http://127.0.0.1:33181
```

The reference service must use its vendor dependencies, production URL configuration with `YII_DEBUG=true` as in the deployed source, `ADMIN_AUTH_ISSUER` and `ADMIN_SCAN_LOGIN_ORIGIN` set to `https://isolated.example`, and disposable local databases. The script refuses remote reference URLs. It never emits cookies, credentials or full server-error traces. Successful business operations and provider interactions are covered by separate contract/cryptographic/SQL integration suites; this anonymous matrix alone does not prove every business scenario.

## Deliberate boundaries

These existing safeguards are retained and must not be described as byte-for-byte legacy equivalence:

- Diagnostic outputs redact credentials; PHP runtime paths, SQL details and internal stacks are not exposed. Invalid legacy JWT parsing fails as an authentication error instead of reproducing an uncaught PHP parser error.
- Invalid or unsigned payment/refund callbacks remain rejected even where old fluent SDK callbacks serialize an empty object without executing verification. Successful verified legacy callbacks now match the empty JSON/SDK XML response.
- Tencent credentials must be configured, STS remains restricted to the configured bucket, provider errors are sanitized and scene fetching validates TLS. Broken `/v1/q-cloud/object-url` source behavior remains repaired with COS signing rather than calling an undefined PHP method.
- HTML errors match status, media type, title and message; PHP layout assets, session/CSRF cookies and framework branding are not copied. Swagger describes this Node implementation and its actual runtime metadata.
- Existing legacy Local/Checkin crashes caused by non-nullable optional arguments or undeclared Redis attributes are not reproduced.

No real customer charge/refund or physical device command is part of automated tests or production smoke checks. Such live acceptance needs the corresponding real-world fixture; cryptographic provider simulations and stateful local tests are not represented as live transactions.

## Release evidence

At 03:12 Asia/Shanghai, local MariaDB 11.4/Redis verification passed **736 tests in 24 files**, with no skipped tests. Build, all 250 routes, source freshness against both the frozen snapshot and current Yii checkout, and 441/441 actual PHP reference responses passed. CI requires all MariaDB 10.4, MariaDB 11.4 and MySQL 8.4 verification jobs to pass before publishing `wechat2`. The CI run, image identity and b0/b1 verification are recorded in the deployment record after publication.

The first production comparison after commit `51fc10d767af19b33464f6bcde88ee51f8bbc18f` found two additional deployment-facing differences: HTML error responses lacked PHP session no-cache headers, and the Node Stacks had no Swagger credentials configured. The cache policy is now covered by six additional regressions. After the user explicitly authorized reusing the existing Swagger credentials, both Stacks received only SWAGGER_USERNAME/PASSWORD and authenticated production checks passed. The first rollout alone is not treated as the final acceptance result.

Final CI [39838170598](https://github.com/gdgeek/wechat/actions/runs/39838170598) passed 736/736 tests on each of the three database engines and published commit `9b212ce6a6d8fe993d2a85b8673b1468a5057248`. Both b0/b1 are deployed and healthy. After the authorized Swagger configuration update at 13:56–13:57 Asia/Shanghai, production comparison passed **50/50 paired cases** and separate Swagger verification passed **40/40 checks** across all four old/new endpoints. Anonymous and invalid credentials receive 401; authorized credentials receive valid HTML/OpenAPI responses; CSS/JS GET and HEAD checks pass. Business image and code remain at the verified commit above. Exact image and deployment evidence are in [the deployment record](DEPLOYMENT-2026-10-23.md).
