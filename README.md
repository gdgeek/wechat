# wechat — game 的 Node.js 后端

使用 Node.js 24、TypeScript、NestJS 重写 `gdgeek/game` 的 Yii2 后端。只包含后端；现有 Vue 管理后台、微信小程序和设备程序继续使用原接口。

兼容范围包括 `/v1` 游戏、玩家、商户、奖品、积分、签到与文件流程，`/v2` 微信身份、设备配置、状态协调、文件与云存储，`/admin-api` 密码/扫码登录、Session、CSRF、设备权限及配置，以及健康检查和受 Basic Auth 保护的 Swagger 文档。

## 启动

```sh
npm ci
cp .env.example .env
# 填写数据库、Redis、JWT、微信和腾讯云配置
npm run build
npm start
```

数据库、Redis 沿用现有 MySQL 协议数据库和 Yii Redis ActiveRecord 键格式。`JWT_KEY` 兼容原密钥文件，亦可使用 `JWT_SECRET`；要接收原 Token，必须配置相同签名密钥。原微信、腾讯云环境变量名称也可继续使用，详见 [集成说明](src/integrations/README.md)。

Web 仍使用 Cookie Session + CSRF；小程序继续使用 Bearer Token，v1/v2 身份域严格隔离；设备状态仍使用原 time/hash 协议。Node 浏览器 Session 存在数据库新表中，多个实例共享；切换运行时后浏览器需要重新登录，不读取 PHP Session 文件。

## 数据库

先对数据库做备份，并在副本验收。已有 Yii 数据库执行：

```sh
npm run migrate
```

空数据库执行：

```sh
npm run migrate -- --bootstrap
```

`--bootstrap` 只接受空库，不包含 DROP TABLE。普通迁移创建 Node Session/限流表和缺失扫码表，并检查设备版本字段及 v1 商户关联列；保留业务行。迁移不会随应用启动自动运行。

冻结源的 v2 历史迁移删除了 `device.shop_id`，但 v1 游戏仍依赖它。`database/002-v1-compatibility.sql` 恢复可空关联列和外键。已经丢失的设备与商户映射需要从可信备份核对恢复，代码不能推断历史归属。初始化 SQL 来自 63 个源迁移的最终状态；生成器只用于离线核对，服务运行不依赖 PHP。

## 验证

```sh
npm run build
npm test
npm run parity
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

`wechat_schema_test` 是专用的可重建测试库，v1 集成测试会重建它；`wechat_test` 的 HTTP fixtures 也会清理测试行。不要把这些变量指向业务库。测试完成后 `docker compose -f compose.test.yaml down`。

源路由与实现对照、已损坏旧入口和具体兼容处理见 [API_PARITY.md](docs/API_PARITY.md)。路由覆盖与自动测试不能替代真实微信账号、支付商户回调、COS 权限和设备联调；这些外部验收尚未在本仓库执行。

## 部署

```sh
docker build -t wechat-backend .
docker compose up -d
```

`compose.yaml` 只启动后端，连接 `.env` 中指定的数据库和 Redis，不部署前端。证书、JWT 密钥通过只读挂载或平台 Secret 注入，容器以 `node` 用户运行，须保证该用户能读取密钥。`TRUST_PROXY` 仅在已有可信反向代理后启用，保证安全 Cookie 和 IP 限流使用正确地址。原管理端代理继续转发既有 `/admin-api` 路径。

`/health` 同时检查数据库和 Redis，支持 HEAD。Swagger 的 `/swagger`、`/swagger/json-schema` 使用 `SWAGGER_USERNAME` / `SWAGGER_PASSWORD`，未配置不公开文档。微信支付通知采用原生平台验签与 AES-GCM 解密，通知入口不使用小程序 Bearer，也不虚构源系统没有的订单入账逻辑。

源码基线与内容哈希保存在 [source-manifest.json](docs/source-manifest.json)。未包含原环境文件、密钥、业务数据或客户端源码。
