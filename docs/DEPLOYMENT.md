# wechat2 后端部署

Node 后端使用独立镜像 `hkccr.ccs.tencentyun.com/gdgeek/wechat2`，Portainer Stack、Compose 服务和容器统一命名为 `wechat2`。沿用现有 `game` 的数据库、Redis、只读密钥和 `proxy` 网络；只部署后端。

## CI 镜像

`.github/workflows/ci.yml` 在三个数据库版本的验证全部成功后，使用仓库现有的 `TCR_USERNAME` / `TCR_PASSWORD` Secrets 发布镜像。PR 和其他分支只运行验证。

| 推送分支 | 发布标签 |
| --- | --- |
| `main` | `main`、`latest`、`sha-<完整提交 SHA>` |
| `develop` | `develop`、`sha-<完整提交 SHA>` |
| `publish` | `publish`、`sha-<完整提交 SHA>` |

`publish` 不更新 `main`、`latest` 或其他分支标签；发布过程不修改旧的 `gdgeek/wechat` 镜像。部署可固定完整 SHA 标签，以便核对构建及回滚。镜像内的 `GIT_COMMIT` / `BUILD_TIME` 和 OCI revision/created labels 记录构建来源。

## b0 / b1 单 Stack

在每台服务器创建一个 `wechat2` Stack，使用相同 Compose 内容。Stack 的环境变量由部署平台填写，密钥不写入仓库。

| 环境变量 | b0 | b1 |
| --- | --- | --- |
| `WECHAT2_HOST` | `x2.b0.01xr.com` | `x2.b1.01xr.com` |
| `WECHAT2_TAG` | 已验证的 `sha-<完整提交 SHA>` 或 `main` | 与 b0 相同 |
| 数据库 / Redis | 对应现有 `game` 的连接配置 | 对应现有 `game` 的连接配置 |
| `GAME_KEYS_DIRECTORY` | 宿主机只读密钥目录 | 宿主机只读密钥目录 |

示例中的 `JWT_KEY_FILE`、`ADMIN_JWT_KEY_FILE`、`ADMIN_JWT_PUB_KEY_FILE` 是该密钥目录内现有文件的相对路径。`ADMIN_AUTH_ISSUER` 和鉴权 Redis 配置沿用 `game`，不要因入口域名变更而重新生成身份域或密钥。`ADMIN_SCAN_LOGIN_ORIGIN` 也沿用现有统一管理入口 `https://checkin.voxel.cn`，无需修改小程序的扫码可信域名。业务 Token 与管理 JWT 继续使用各自的凭据。

```yaml
services:
  wechat2:
    image: hkccr.ccs.tencentyun.com/gdgeek/wechat2:${WECHAT2_TAG:-main}
    container_name: wechat2
    restart: unless-stopped
    networks:
      - proxy
    environment:
      NODE_ENV: production
      TZ: Asia/Shanghai
      PORT: "8080"
      PUBLIC_ORIGIN: https://${WECHAT2_HOST:?set WECHAT2_HOST}
      TRUST_PROXY: "1"
      MYSQL_HOST: ${MYSQL_HOST:?set MYSQL_HOST}
      MYSQL_PORT: ${MYSQL_PORT:-3306}
      MYSQL_DATABASE: ${MYSQL_DATABASE:?set MYSQL_DATABASE}
      MYSQL_USER: ${MYSQL_USER:?set MYSQL_USER}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD:?set MYSQL_PASSWORD}
      REDIS_HOST: ${REDIS_HOST:?set REDIS_HOST}
      REDIS_PORT: ${REDIS_PORT:-6379}
      REDIS_DB: ${REDIS_DB:-0}
      REDIS_PASSWORD: ${REDIS_PASSWORD:-}
      JWT_KEY: /run/game-keys/${JWT_KEY_FILE:?set JWT_KEY_FILE}
      ADMIN_JWT_KEY: /run/game-keys/${ADMIN_JWT_KEY_FILE:?set ADMIN_JWT_KEY_FILE}
      ADMIN_JWT_PUB_KEY: /run/game-keys/${ADMIN_JWT_PUB_KEY_FILE:?set ADMIN_JWT_PUB_KEY_FILE}
      ADMIN_AUTH_ISSUER: ${ADMIN_AUTH_ISSUER:?keep the existing game issuer}
      ADMIN_AUTH_REDIS_HOST: ${ADMIN_AUTH_REDIS_HOST:-}
      ADMIN_AUTH_REDIS_PORT: ${ADMIN_AUTH_REDIS_PORT:-}
      ADMIN_AUTH_REDIS_DB: ${ADMIN_AUTH_REDIS_DB:-}
      ADMIN_AUTH_REDIS_PASSWORD: ${ADMIN_AUTH_REDIS_PASSWORD:-}
      ADMIN_SCAN_LOGIN_ORIGIN: ${ADMIN_SCAN_LOGIN_ORIGIN:?keep the existing game scan origin}
      ADMIN_USERNAME: ${ADMIN_USERNAME:?set ADMIN_USERNAME}
      ADMIN_PASSWORD_HASH: ${ADMIN_PASSWORD_HASH:?set ADMIN_PASSWORD_HASH}
      SCENE_SERVER_BASE_URL: ${SCENE_SERVER_BASE_URL:?keep the existing game scene endpoint}
    volumes:
      - ${GAME_KEYS_DIRECTORY:?set GAME_KEYS_DIRECTORY}:/run/game-keys:ro
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.wechat2.rule=Host(`${WECHAT2_HOST:?set WECHAT2_HOST}`)
      - traefik.http.routers.wechat2.entrypoints=websecure
      - traefik.http.routers.wechat2.tls=true
      - traefik.http.routers.wechat2.tls.certresolver=letsencrypt
      - traefik.http.routers.wechat2.service=wechat2
      - traefik.http.services.wechat2.loadbalancer.server.port=8080

networks:
  proxy:
    external: true
```

微信登录/支付、腾讯云 COS/STS 和 Swagger 的环境变量按 `.env.example` 及 `src/integrations/README.md` 补入该服务的 `environment`；商户私钥、平台公钥也通过只读目录挂载。未显式覆盖支付通知地址时，后端使用当前 `PUBLIC_ORIGIN` 加对应版本的 `/wechat-pay/notify` 路径。b0 与 b1 的 DNS、TLS 证书和公网通知入口分别验证。容器内进程使用 UID 1000，宿主机密钥必须允许该用户读取。

## 数据迁移与验收

生产镜像包含已编译的迁移及 SQL，不依赖 `tsx`、开发依赖或 PHP。启动服务不会自动迁移。保留数据库备份后，使用与 Stack 相同的连接配置在目标数据库执行一次普通迁移；已有 `game` 数据库不要加 `--bootstrap`。

```sh
# 在包含相同环境变量的 Compose 部署目录执行；Portainer 部署可用等效的一次性容器。
docker compose run --rm --no-deps wechat2 npm run migrate:prod
docker compose up -d wechat2
```

空数据库初始化才使用 `npm run migrate:prod -- --bootstrap`。迁移只需针对同一数据库运行一次；b0/b1 共用数据库时不并发执行。CI 会在每个隔离测试数据库中运行镜像内的普通迁移命令。

上线后检查容器健康、`https://x2.b0.01xr.com/health` 和 `https://x2.b1.01xr.com/health`，核对提交 SHA，并验收管理登录、业务 Token、设备协议以及支付回调。需要回滚时将 Stack 镜像恢复到此前的完整 SHA 标签并重新部署。

## Portainer 的旧容器页面报错

`Unable to retrieve container: No such container: <ID>` 表示当前 Docker 环境已不存在该容器 ID；容器重建会产生新 ID。回到 Stack 或 Containers 列表刷新后打开当前容器，再查看日志和健康状态。该提示本身无法判断应用是否启动成功，需要以列表中的当前容器为准。
