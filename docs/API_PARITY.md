# HTTP 路由对照

本清单从冻结的 Yii2 源码独立生成，再与 `createRouter(createServices())` 的实际注册表比较。它用于防止迁移漏掉原有入口，不把新实现的路由反过来当作旧接口依据。

完整逐项清单在 [route-parity.json](route-parity.json)。每项包含 HTTP 方法、路径模板、合法样例、参数约束、Yii route、控制器文件、action 来源及行号、配置行号、行为域和相关测试文件。

## 来源与生成方法

- 冻结源：`/private/tmp/wechat-current-game-baseline`；其文件哈希与本仓库 [source-manifest.json](source-manifest.json) 对照。原后端、前端、小程序和部署文件均不在本次生成过程中修改。
- 配置来源：冻结的 `files/api/config/web.php` 中 `urlManager.rules`。只提取这个字面数组，不加载数据库、微信或部署配置。
- 用原项目只读安装的 Yii2 `yii\rest\UrlRule` 展开每个 REST 规则。清单记录 Yii 版本，以及 `UrlRule.php`、`OptionsAction.php` 的 SHA-256；新仓库检查和运行均不依赖 PHP 或旧项目 vendor。
- 内联 `actionXxx` 通过 Reflection 核对；外部 action 来自不执行构造函数的控制器 `actions()` 映射。没有运行任何业务 action、鉴权过滤器、数据库查询或外部请求。
- 按配置顺序保留先匹配规则，展开 `GET / HEAD / POST / PUT / PATCH / DELETE / OPTIONS`。默认 REST 规则也纳入，包括 `view/create/update/delete/index/options`，不能只检查 `extraPatterns`。
- 配置之外的 action 方法单独记录在 `unroutedControllerActions`。`enableStrictParsing=true`，因此存在方法不等于存在 HTTP 入口。
- 每个生成样例都用原 Yii 编译后的规则离线验证，结果保存在 `sampleMatchesSource`。所有现有样例均可匹配其配置规则。

`sourceStatus=resolvable` 仅表示路由能解析到一个 action。它不保证数据库存在、鉴权通过、第三方配置有效，或 action 不含旧代码错误；已知旧错误另列。

## 清单范围

| 项目 | method/path 对数 |
| --- | ---: |
| 原配置展开后的全部声明 | 488 |
| 能解析到 action | 252 |
| 其中业务、诊断及默认 REST action | 186 |
| 其中 OptionsAction 与方法兜底 | 66 |
| 控制器存在但 action 不存在，原为 404 | 220 |
| 控制器不存在，原为 404 | 16 |

缺控制器的 16 项来自配置中的 `v1/manager`，冻结源没有对应 `ManagerController.php`。缺 action 不能补成通用 CRUD，例如 `/v1/system/ready` 和大多数普通 `yii\rest\Controller` 自动展开的 CRUD 声明；这些原本会返回 404。

`/v2/files/:id` 的 DELETE 特别保留 404：原 UrlRule 先匹配 `delete`，随后 `FileController.actions()` 将它删除；请求不会继续尝试 OptionsAction。新服务注册一个明确抛出 404 的 handler，记录在 `registered404Preservations`，不计为新业务接口。

## 行为域与测试映射

下面的数量来自源清单，不包括原 404 项。

| 源行为域 | 对数 | 相关测试 |
| --- | ---: | --- |
| 后台 JWT、刷新/撤销、扫码票据及设备删除 | 14 | `admin.test.ts`、`integration/http.test.ts` |
| 健康检查 | 2 | `integration/http.test.ts` |
| Swagger Basic Auth | 2 | `integration/http.test.ts` |
| v1 玩家认证 | 4 | `v1-contracts.test.ts` |
| v1 REST 资源 | 59 | `v1-contracts.test.ts` |
| v1 游戏及账务 | 24 | `v1-contracts.test.ts` |
| v1 打卡及本地状态协调 | 13 | `v1-contracts.test.ts` |
| v2 设备、配置、文件、状态协调 | 38 | `v2.test.ts` |
| 微信身份、资料、手机号 | 6 | `integrations.routes.test.ts`、`integrations.test.ts` |
| 微信支付、查单、退款、通知 | 17 | `integrations.payments.test.ts`、`integrations.test.ts` |
| 腾讯 STS / COS 配置与凭证 | 6 | `integrations.test.ts` |
| QCloud 签名入口 | 1 | `integrations.test.ts` |
| OptionsAction 及方法兜底 | 66 | `integration/http.test.ts` |

所有清单项还映射到 `parity.test.ts`。映射表示该路由所属行为域及注册检查有测试，不表示每项接口的每个字段和线上依赖都已完成端到端对照。

## OptionsAction 与 HEAD

Yii 的 OptionsAction 对 OPTIONS 返回 200，其他兜底方法返回 405，响应体为 null，并设置 `Allow` 和 `Access-Control-Allow-Methods`。集合默认允许 `GET, POST, HEAD, OPTIONS`，单项默认允许 `GET, PUT, PATCH, DELETE, HEAD, OPTIONS`。

因此 66 项不能全部当作正常业务 action，也不能从清单删除。22 项是 OPTIONS，另外 44 项是在 REST 集合或单项路径上的方法兜底。检查器从同一路径实际注册的 OPTIONS handler 推导 `runtime-options` 覆盖；HTTP 层负责按原行为返回 405。原来缺 action 的 DELETE 文件入口仍为 404。

新注册表没有全局 HEAD→GET 回退。默认 REST 资源及 `/health` 明确注册 HEAD；只声明 GET 的自定义入口保持 HEAD 为 404。

`unconfiguredVerbCases` 另外固定五条代表性 HEAD 负例：`/admin-api/session`、`/v1/common/test`、`/v1/game/ready`、`/v2/server/info`、`/v2/files/list`。它们通过完整的原 Yii 有序规则离线检查，既没有 HEAD 规则，也不匹配任何 OptionsAction。检查器和测试同时要求新注册表没有 HEAD handler，也没有 OPTIONS 兜底；恢复全局 HEAD 回退会使检查失败。

`notFoundProbes` 另固定 `GET /v2/wechat/info` 和 `GET /v2/wechat/code`：前者配置指向不存在的 action，后者有方法但未发布 URL。两者继续返回原 404，也不能落入 OptionsAction；它们不会被算作新增能力。

当前检查还没有穷举所有未声明方法、全部路径参数非法值和源错误文本；这些行为不能仅由注册覆盖率证明。

## 明确记录的兼容修复

这些项目保留源信息，不通过修改源状态来隐藏差异：

| 入口 | 冻结源行为 | 新行为 |
| --- | --- | --- |
| `GET /v1/q-cloud/object-url` | 调用不存在的 v1 `File::Create`，执行失败 | 真实 COS 签名，返回 `{url,method,expires}` |
| `GET /v1/we-chat/info` | 返回 SDK application 对象，没有稳定的数据响应 | 仅公开 `app_id` / `mch_id` |
| v2 支付及退款通知 | Controller 的用户 Bearer 过滤器阻挡正常微信回调 | 由微信支付签名、加密资源、商户身份校验认证 |
| `GET /v1/helper/print`、`GET /v1/local/test` 的共享诊断记录 | 记录及回显请求结构时可能包含凭据 | 保持 payload 结构并使用共享 Redis；`Authorization` / `Cookie` / `Set-Cookie` 等敏感头以及具名顶层凭据字段脱敏 |

已恢复的行为不列为差异：Swagger 的 Basic Auth；已有 applet 经公共 server 路径更新时原有的签名认证边界；文件删除 action 的原 404；REST 方法兜底。

## 执行检查

```sh
npm run parity
npm run parity -- --source-root /path/to/game
npm test -- tests/parity.test.ts
```

受限环境若不允许 tsx CLI 建立本地 IPC，可使用同一个 TypeScript 脚本的加载器入口：

```sh
node --require tsx/cjs scripts/check-parity.ts
```

`--source-root`（或 `YII_SOURCE_ROOT`）另行比较当前 Yii checkout 的实际文件哈希，并检测 components/controllers/migrations/modules 中新出现的 PHP 文件；未提供时明确显示未执行源码新鲜度检查。`scripts/capture-source-routes.php <Yii checkout>` 可用安装了 vendor 的源仓库只读生成原生 Yii 路由证据，输出不是可直接覆盖的行为测试映射。

`--json` 输出逐项结果。脚本只读固定 JSON 清单与当前 TypeScript 注册表，不加载 PHP、不发 HTTP、不连接数据库或 Redis、不调用业务 handler。Services 建立后会关闭尚未使用的数据连接池。测试另外确认文件 DELETE 的显式 handler 确实抛出 404。

以下情况退出非零：源哈希不一致、清单证据或测试映射缺失、可解析源路由遗漏、未解释地将源 404 改为接口、存在未解释的额外注册，或五条未声明 HEAD 及两条未发布微信入口负例出现 handler / OptionsAction 兜底。缺失项必须修复或明确报告，不能删除清单项目凑齐。

当前结构检查结果为 252 / 252：186 项业务及 REST action、66 项 OptionsAction / 方法兜底均有对应处理；全部 236 条源 404 声明保留。五条未声明 HEAD 及两条未发布微信入口负例保持 404。不存在遗漏或未解释的额外注册。

这不替代真实 MySQL / Redis、微信真机、商户支付配置、COS、Y1 和生产入口验收，也不证明每条响应内容已经与旧运行环境完全相同。

## 当前契约对齐

管理认证已跟随当前 game 改为独立 ES256 Bearer JWT，共用 Yii 的 Redis key/记录与刷新 CAS，支持既有 PHP 令牌的单 audience 编码。密码变更、微信用户删除、设备 control 撤销实时生效；扫码 owner proof 与共享锁沿用现有客户端。

当前基线还包含源工作区尚未提交的设备 version 上报逻辑：每次 UUID 上报校验并同步 version，省略为 0，范围 0..2147483647，更新不改变设备 updated_at。v1 数值校验和 version 排序、v2 嵌套 fields 通配符、旧支付 PEM/路径配置及手机号错误包装有专门回归用例。
