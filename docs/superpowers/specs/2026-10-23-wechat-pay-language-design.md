# WeChat Pay request language

The production Node transport sends the Fetch default `Accept-Language: *` when
`Integrations.payment()` omits that header. WeChat Pay rejected this with an
authenticated HTTP 406 `PARAM_ERROR`. The same request succeeded with `zh-CN`.

The authorized change is to add `Accept-Language: zh-CN` to the headers created
by `Integrations.payment()`. This affects only WeChat Pay requests. Request
signing, response verification, credentials, business data and other provider
transports stay as they are. A global Fetch override would affect unrelated
providers; a configurable language would add unnecessary configuration.

The regression test uses the existing test RSA keys and signed-response helper,
a loopback HTTP server, and the real Node Fetch implementation. The server
rejects the default wildcard and accepts `zh-CN`. The test first demonstrates
the real default rejection, then expects `payment()` to receive and verify a
successful response. A transport adapter changes only the destination origin,
so no request reaches WeChat and no real credential is used.

Acceptance: the regression fails against the original implementation, passes
after the one-header change, and the payment tests, build and available full
suite pass. The isolated branch is reviewable without pushing or deploying.
