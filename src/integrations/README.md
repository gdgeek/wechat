# WeChat and Tencent integrations

`new Integrations()` reads deployment environment variables. Tests can inject
`fetch`, `now` (Unix seconds), `nonce`, and provider configuration through
`IntegrationOptions`. `registerIntegrations(router, services)` registers the
existing v1/v2 HTTP routes. There is no forwarding to the former PHP backend.

## Configuration

Modern names take precedence over the existing Yii variable names:

| Purpose | Modern variable | Existing Yii fallback |
| --- | --- | --- |
| Mini program AppID | `WECHAT_APP_ID` | same |
| Mini program secret | `WECHAT_APP_SECRET` | `WECHAT_SECRET` |
| Merchant ID | `WECHAT_PAY_MCH_ID` | `WECHAT_MCH_ID` |
| Merchant serial | `WECHAT_PAY_SERIAL_NO` | extracted from X.509 file `WECHAT_CERTIFICATE` |
| Merchant private key | `WECHAT_PAY_PRIVATE_KEY` (PEM) / `WECHAT_PAY_PRIVATE_KEY_PATH` | `WECHAT_PRIVATE_KEY` (path) |
| APIv3 key | `WECHAT_PAY_API_V3_KEY` | `WECHAT_SECRET_KEY` |
| Platform public key ID | `WECHAT_PAY_PLATFORM_SERIAL_NO` | `WECHAT_PUB_KEY_ID` |
| Platform public key | `WECHAT_PAY_PLATFORM_PUBLIC_KEY` (PEM) / `WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH` | `WECHAT_PUB_KEY` (path) |
| Tencent credentials | `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | `SECRET_ID` / `SECRET_KEY` |
| COS bucket and region | `COS_BUCKET` / `COS_REGION` | `COS_BUCKETS_BUCKET` / `COS_BUCKETS_REGION` |

`WECHAT_PAY_PLATFORM_KEYS_JSON` accepts a JSON object mapping platform key IDs or
certificate serials to trusted PEM public keys/certificates. Configure both keys
during rotation. Unknown serials are rejected; keys are never downloaded and
trusted automatically. When a public key ID is configured it is also sent in the
`Wechatpay-Serial` request header. `WECHAT_PAY_NOTIFY_URL` defaults to
`PUBLIC_ORIGIN/v1/wechat-pay/notify`. `WECHAT_PAY_REFUND_NOTIFY_URL` is optional.

Signing credentials stay on the server. The client receives only mini program
payment parameters, presigned object URLs, and scoped temporary STS credentials.
Provider errors are sanitized so URLs containing application secrets, provider
response details and signing material do not reach HTTP error messages.

## Compatibility boundaries

- Web admin Session/CSRF and WeChat Bearer identities stay independent.
- v2 login uses only the `codeSession` identity. When unionid is absent, an
  existing verified openid is required; client-provided identity fields do not
  create or select a user.
- v1/v2 payment operations retain `{code,message?,data?}`; login/profile/phone
  retain `{success,message,data}`. v1 openid does not expose `session_key`.
- Notifications validate the exact raw request body, trusted serial, RSA
  signature, five minute signature window, authenticated AES-256-GCM payload,
  merchant/AppID and event category before acknowledgment. The source application
  has no payment-order fulfilment model. Like that source, the default handler
  acknowledges a valid notification without inventing an order-state write.
  An optional `onPaymentNotification` hook is available to an explicitly
  configured fulfilment service; hook failure prevents acknowledgment.
- The old v2 controller incorrectly required a user Bearer on WeChat callbacks.
  Callbacks now authenticate using the provider signature, while other v2
  payment operations continue to require `v2-user` Bearer credentials.
- The old `/v1/q-cloud/object-url` called an undefined `File::Create` method and
  failed. This broken action is repaired to return `{url,method,expires}` using
  COS signing. It does not create a fictional file record or accept a raw mode.
- The old v1 WeChat info returned an SDK object; that endpoint now returns public
  application/merchant identifiers only, without serializing SDK configuration
  or secrets. The missing v2 info action and the unpublished v2 code action stay
  HTTP 404 and are not exposed as new endpoints.
- STS grants are restricted to the configured bucket/region. The deprecated
  `principal` policy member and nonexistent COS actions from the old request are
  excluded. The configured bucket policy still supports the original upload,
  download and multipart operations.

## Official protocol references

- [WeChat code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)
- [WeChat phone number API](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-info/phone-number/getPhoneNumber.html)
- [WeChat stable access token](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-access-token/getStableAccessToken.html)
- [WeChat Pay request signing](https://pay.wechatpay.cn/doc/v3/merchant/4012365336)
- [WeChat Pay response and callback verification](https://pay.wechatpay.cn/doc/v3/merchant/4013053249)
- [WeChat Pay signature scenarios](https://pay.wechatpay.cn/doc/v3/merchant/4012365342)
- [WeChat Pay callback AES-GCM encryption](https://pay.wechatpay.cn/doc/v3/partner/4019605946)
- [Tencent STS GetFederationToken](https://intl.cloud.tencent.com/ind/document/product/1150/49452)
- [Tencent TC3 request signing](https://cloud.tencent.cn/document/product/213/30654)
- [Tencent COS signing](https://cloud.tencent.com/document/product/436/7778)
- [Official COS Node SDK signing implementation](https://github.com/tencentyun/cos-nodejs-sdk-v5/blob/master/sdk/util.js)

## Verification

`npm test -- tests/integrations.test.ts tests/integrations.routes.test.ts tests/integrations.payments.test.ts`

Tests use generated test RSA keys and injected provider responses, exercising
exact request signing, response verification, authentic notification decryption,
invalid signatures/serials/timestamps/ciphertext/merchant, login identity
selection, refresh domain, profile field allowlists, phone credentials, STS
policy scope, COS HEAD metadata and original payment/refund response shapes.
They do not contact real WeChat accounts, issue real temporary credentials,
charge payments, or establish production callback reachability.
