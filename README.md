# wechat — game 的 Node.js 后端

使用 Node.js 24、TypeScript、NestJS 重写 `gdgeek/game` 的 Yii2 后端。只包含后端；现有 Vue 管理后台、微信小程序和设备程序继续使用原接口。

兼容范围包括 `/v1` 游戏、玩家、商户、奖品、积分、签到与文件流程，`/v2` 微信身份、设备配置、版本上报、状态协调、文件与云存储，`/admin-api` 密码/扫码登录、管理 JWT 刷新和撤销、设备权限及配置，以及健康检查和受 Basic Auth 保护的 Swagger 文档。

## 启动

```sh
npm ci
cp .env.example .env
# 填写数据库、Redis、JWT、微信和腾讯云配置
npm run build
npm start
```

数据库、Redis 沿用现有 MySQL 协议数据库和 Yii Redis ActiveRecord 键格式。`JWT_KEY` 兼容原密钥文件，亦可使用 `JWT_SECRET`；要接收原 Token，必须配置相同签名密钥。原微信、腾讯云环境变量名称也可继续使用，详见 [集成说明](src/integrations/README.md)。

Web 管理端使用当前 Yii 的独立 `game-admin` ES256 Bearer JWT，登录和扫码消费返回 `{user,token,authMode:"jwt"}`，通过 `/admin-api/refresh` 轮换刷新令牌，退出撤销整次登录。访问令牌最长三小时，刷新不会延长原八小时期限。扫码浏览器凭据使用现有 `X-Admin-Scan-Owner` 请求头；管理端不要求 Cookie 或 CSRF。

沿用相同 `ADMIN_JWT_KEY` / `ADMIN_JWT_PUB_KEY`、`ADMIN_AUTH_ISSUER` 以及 `ADMIN_AUTH_REDIS_*` 后，Yii 与 Node 可共享管理令牌、刷新状态、密码限流和扫码 owner 锁。认证 Redis 独立于业务 Redis 配置，连接失败返回 503。小程序继续使用原 HS256 Bearer Token，v1/v2 与管理身份域严格隔离；设备状态继续使用原 time/hash 协议。前端、小程序及设备端不需要修改。

## 数据库

先对数据库做备份，并在副本验收。已有 Yii 数据库执行：

```sh
npm run migrate
```

空数据库执行：

```sh
npm run migrate -- --bootstrap
```

`--bootstrap` 只接受空库，不包含 DROP TABLE。普通迁移创建兼容状态/扫码限流表和缺失扫码表，检查设备版本字段及 v1 商户关联列，并将 `record.device_id` 改为允许空值和 `ON DELETE SET NULL`；保留业务行。旧 Node Session 表保留，认证不再使用。迁移不会随应用启动自动运行。

冻结源的 v2 历史迁移删除了 `device.shop_id`，但 v1 游戏仍依赖它。`database/002-v1-compatibility.sql` 恢复可空关联列和外键。已经丢失的设备与商户映射需要从可信备份核对恢复，代码不能推断历史归属。初始化 SQL 来自 64 个源迁移的最终状态；生成器只用于离线核对，服务运行不依赖 PHP。

当前管理员设备删除入口为 `DELETE /admin-api/devices/:id`，仅密码管理员可用。存在未结束的游戏时返回 409；删除配置和关联时保留已结束游戏记录及原时间字段。必须先完成记录保留迁移，旧未升级的表结构会拒绝删除。已有外键通过单条 ALTER 原子更新；重复迁移不修改业务数据。

## 验证

```sh
npm run build
npm test
npm run parity
# 同时核对真正的当前 Yii 源码，检测基线之后的修改或新增后端 PHP 文件
npm run parity -- --source-root /path/to/game
```

普通测试不连接生产资源。SQL/HTTP 集成测试要求显式开启并限定本机测试数据库：

```sh
docker compose -f compose.test.yaml up -d
export MYSQL_HOST=127.0.0.1 MYSQL_PORT=33367 MYSQL_USER=root
export MYSQL_PASSWORD=wechat-local-test MYSQL_DATABASE=wechat_test
export REDIS_HOST=127.0.0.1 REDIS_PORT=36379 REDIS_DB=0
npm run migrate -- --bootstrap
RUN_INTEGRATION=1 V1_MYSQL_TEST_URL='mysql://root:wechat-local-test@127.0.0.1:33367/wechat_schema_test' npm test
```

`wechat_schema_test` 是专用的可重建测试库，v1 集成测试会重建它；`wechat_test` 的 HTTP fixtures 也会清理测试行。管理认证使用同一个隔离 Redis 的 DB 15，并清理 `game:admin:auth:*` 测试键。迁移测试创建唯一命名的新库、只清理自己成功创建的库，不复用同名既有数据。不要把这些变量指向业务资源。测试完成后 `docker compose -f compose.test.yaml down`。

源路由与实现对照、已损坏旧入口和具体兼容处理见 [API_PARITY.md](docs/API_PARITY.md)。路由覆盖与自动测试不能替代真实微信账号、支付商户回调、COS 权限和设备联调；这些外部验收尚未在本仓库执行。

有当前 Yii 源码和 PHP/Composer 环境时，可复现真实双向管理令牌互通检查（仅接受显式指定的 localhost 非 6379 测试端口、DB 15，临时密钥和随机 issuer）：

```sh
RUN_YII_ADMIN_INTEROP=1 YII_SOURCE_ROOT=/path/to/game \
ADMIN_AUTH_REDIS_HOST=127.0.0.1 ADMIN_AUTH_REDIS_PORT=36379 ADMIN_AUTH_REDIS_DB=15 \
node --import tsx scripts/verify-yii-admin-interop.cjs
```

## 部署

```sh
docker build -t wechat-backend .
docker compose up -d
```

`compose.yaml` 只启动后端，连接 `.env` 中指定的数据库和 Redis，不部署前端。证书、JWT 密钥通过只读挂载或平台 Secret 注入，容器以 `node` 用户运行，须保证该用户能读取密钥。`TRUST_PROXY` 仅在已有可信反向代理后启用，保证请求 origin 和 IP 限流使用正确地址。原管理端代理继续转发 Bearer 和 owner proof，保留目前清除 Cookie/CSRF 的设置。

如果沿用 `SCENE_SERVER_BASE_URL=http://y1-p:8080` 或其他现有 Docker 服务名，使用 `BACKEND_NETWORK=proxy docker compose -f compose.yaml -f compose.proxy.yaml up -d` 接入对应的既有网络；该网络必须预先存在，名称可按部署修改。密钥挂载、域名入口与外部回调可达性在切换前验收。支付通知默认保留 Yii 由请求 origin 生成的 `/v1/wechat-pay/notify`，也支持显式通知 URL。

`/health` 同时检查数据库和 Redis，支持 HEAD。Swagger 的 `/swagger`、`/swagger/json-schema` 使用 `SWAGGER_USERNAME` / `SWAGGER_PASSWORD`，未配置不公开文档。微信支付通知采用原生平台验签与 AES-GCM 解密，通知入口不使用小程序 Bearer，也不虚构源系统没有的订单入账逻辑。

源码基线与内容哈希保存在 [source-manifest.json](docs/source-manifest.json)。未包含原环境文件、密钥、业务数据或客户端源码。
