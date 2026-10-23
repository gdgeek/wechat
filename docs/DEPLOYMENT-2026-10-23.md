# 2026-10-23 wechat2 部署与 b0 对照

## 后端对齐发布与 Swagger 配置补齐（13:58，当前状态）

已发布并部署后端提交 `9b212ce6a6d8fe993d2a85b8673b1468a5057248`。改动仅位于 `gdgeek/wechat` 后端仓库；原 Yii、Web 管理端、小程序、设备客户端及其入口未修改。兼容基线与保留的安全差异见 [HTTP 兼容记录](HTTP-COMPATIBILITY-2026-10-23.md)。

| 节点 | Stack / 容器名 | 当前业务容器 | 验证状态 |
| --- | --- | --- | --- |
| [x2.b0.01xr.com](https://x2.b0.01xr.com/health) | `wechat2` / `wechat2`，Stack 21 | `9988abcb59f8e0ef9ab0a8e5aef21c297b6afdfd3750bbcf2d82aaa8ffdf6c2f` | healthy；DB/Redis up |
| [x2.b1.01xr.com](https://x2.b1.01xr.com/health) | `wechat2` / `wechat2`，Stack 19 | `539fbd3f7cbf2e3900e804150f170d2f70daafd03a2dfae8fc2553394b6e6728` | healthy；DB/Redis up |

[最终 CI 39838170598](https://github.com/gdgeek/wechat/actions/runs/39838170598) 全部成功：MariaDB 10.4、MariaDB 11.4、MySQL 8.4 各 **736/736 项测试**、TypeScript 构建、**250/250 条路由**、生产 Docker 镜像构建和镜像内迁移验证通过，之后才发布镜像。首次对齐发布 [CI 39836690730](https://github.com/gdgeek/wechat/actions/runs/39836690730) 的 730 项测试也通过；随后在线上对照中发现 HTML 缓存头遗漏，新增六项回归并完成本轮修复与再次部署。

镜像标识：

- 镜像：`hkccr.ccs.tencentyun.com/gdgeek/wechat2:latest`，可固定回滚标签 `sha-9b212ce6a6d8fe993d2a85b8673b1468a5057248`。
- 发布索引摘要：`sha256:cbb8afe625932b5adddd1f0ad633c1539889b988492b5117501fe185752dac2a`。
- linux/amd64 清单：`sha256:670865ac990f81c054ec6270c4e3faf8746177ca4cc75d6aef3c84508345af6b`。
- 两台容器实际 image ID 均为 `sha256:23607096a6d4678fc34dc6b93cfabb3d5d722b42af6ee71614c0d2a0a569d015`，与上述清单的 config digest 一致。
- 公网 health 均返回完整提交 `9b212ce6a6d8fe993d2a85b8673b1468a5057248`、构建时间 `2026-10-23 03:14:57`，时间戳采用上海时区、秒精度。

03:16 通过 Portainer 现有 Stack 的 Re-pull image and redeploy 更新，未改变网络或挂载。Compose 同时重建并运行了现有一次性辅助任务：b0 密钥准备、备份保护、迁移以及 b1 密钥准备均退出 0；这些任务仍使用原固定版本，备份的 `test -s` 保护继续保留既有备份。此轮没有新增数据库结构变更。

### 最终公网对照与 Swagger 验收

13:58:09–13:58:13 对 b0、b1 各执行 25 组旧 Yii / 新 Node 配对检查，共 100 个匿名只读请求。每台 **25/25 组一致**，合计 **50/50 组一致**。匹配项包括状态码、JSON 响应、XML 文本、HTML 错误标题、健康检查字段/时间格式，以及 Allow、WWW-Authenticate、Cache-Control、Expires、Pragma 和 CORS 白名单响应头。构建 SHA、构建时间与实时耗时按不同服务处理，不要求数值相同。

前轮还对两个新入口的图片预览端点及编码路径各执行一次匿名鉴权检查，共四项通过；均在读取设备业务数据前返回预期 401。本轮旧 Yii 两端返回提交 `3b63907ed4bf41b074cd1a4064f68ec796bdd10d`，新端仍为已通过 CI 的 `9b212ce6a6d8fe993d2a85b8673b1468a5057248`，四个入口均健康。

**Swagger 部署凭据迁移已完成。** 用户明确授权复用现有 Swagger 凭据后，先验证旧 Yii 两端认证 schema 均为 200，再仅向 b0、b1 的 `wechat2` 服务环境加入 `SWAGGER_USERNAME` 和 `SWAGGER_PASSWORD`。编辑器回读确认除这两项外配置结构完全一致。13:56、13:57 分别更新两端 Stack，沿用现有已验证镜像，未重新构建业务代码；辅助任务容器 ID 保持不变，均正常退出 0。凭据仅保存于现有 Portainer Stack 配置，未写入仓库、验证结果或聊天。

13:58 的独立 Swagger 验证 **40/40 项通过**：四个入口分别检查页面及 schema 的匿名请求、错误凭据、已授权正确凭据，以及 CSS/JS 的 GET 和 HEAD。匿名及错误凭据均为 401，realm 与错误正文一致；正确凭据返回 200，HTML 包含本地资源和 schema 引用，JSON 可解析且包含有效 OpenAPI、info、paths；静态资源返回 200，类型和响应体符合预期。旧 Yii 和 Node 的文档标题、版本号和完整 schema 按各自实现生成，不要求整份文档字节相同。

前轮因缺少 Swagger 配置产生的两项失败已消除，配对检查由 48/50 提升为 50/50。这证明上述检查范围内通过，不能据此推断所有真实业务场景均已在线上实测。

真实收费、退款和物理设备操作没有在生产执行。验签、解密及支付状态写入由隔离自动化用例覆盖；安全脱敏、无效回调拒绝等保留差异详见兼容记录。

## 首次部署结果（02:28，历史记录）

仅部署 Node 后端；现有 Yii 服务、Web 管理端、小程序及设备入口继续保留。

| 节点 | HTTPS 入口 | Portainer Stack | 业务容器 |
| --- | --- | --- | --- |
| b0 | https://x2.b0.01xr.com | `wechat2`，ID 21 | `wechat2`，healthy |
| b1 | https://x2.b1.01xr.com | `wechat2`，ID 19 | `wechat2`，healthy |

业务镜像为 `hkccr.ccs.tencentyun.com/gdgeek/wechat2:latest`，当时构建提交为 `ad2aef03f962b0285a225cdc45f1eb674fa2f0cd`，发布摘要为 `sha256:133b9d563f7df8596fdda84da4260461d4c25440dcb0880d3163240524320cdf`。对应完整提交标签为 `sha-ad2aef03f962b0285a225cdc45f1eb674fa2f0cd`。

[CI 39829717046](https://github.com/gdgeek/wechat/actions/runs/39829717046) 的 MySQL 8.4、MariaDB 11.4、MariaDB 10.4 验证及镜像发布全部成功；MySQL 作业确认 17 个测试文件、200 项测试通过、249/249 路由覆盖，并实际运行生产镜像内的迁移命令。

业务容器加入原有 `proxy` 网络，Traefik 转发内部端口 8080；未开放新的宿主机业务端口。两个新域名均已通过公网 TLS 验证。业务容器开启 Watchtower 标签，跟随通过 CI 的 `latest`；密钥准备、备份、迁移容器关闭自动更新。

## 数据与密钥

沿用两端原有数据库、业务 Redis、独立管理认证 Redis、管理 issuer 和统一扫码 origin。旧 `MYSQL_DB` / `MYSQL_NAME` 分别映射为 Node 的 `MYSQL_DATABASE` / `MYSQL_USER`。

b0 先以 `mariadb-dump --single-transaction` 完成共享数据库备份，再运行普通生产迁移；备份、迁移均退出 0。b1 使用已迁移的共享数据库，未另行执行迁移。备份保存在 b0 的持久卷 `wechat2_wechat2-backups`，卷内文件为 `/game-before-wechat2-ad2aef03.sql`；不含在 Git 仓库中。

每台机器的初始化任务将 6 个既有 JWT/微信支付密钥文件复制到专用卷，文件属主 UID 1000、权限 0400，目录权限 0700；业务容器只读挂载该卷并以 UID 1000 运行。未重新生成密钥。初始化任务正常退出 0 是预期状态。

部署时修复了旧业务 JWT 将 PEM 文件原始字节作为 HS256 密钥的兼容问题，保留原字节与换行，未放宽算法限制。两台机器分别验证了业务 HS256、管理 ES256、商户证书与私钥匹配、平台公钥可读、微信配置完整、管理 Redis PING、Y1 游戏列表连通性，均通过；未输出密钥或登录 Token。

## 公网验收

两个新入口分别验证 `/health` 200/healthy、`/admin-api/session` 200/JWT、匿名管理设备接口 401、匿名文件列表 401、`/v1/common/test` 返回 `1123`、`/.env` 404。部署后原 `x.b0.01xr.com/health` 和 `x.b1.01xr.com/health` 仍为 200/healthy，共 14 项公网检查通过。

## 用户要求的 b0 对比

2026-10-23 02:32（Asia/Shanghai）实测 `x2.b0.01xr.com` 与 `x.b0.01xr.com`：

| 项目 | Node / x2.b0 | Yii / x.b0 |
| --- | --- | --- |
| health HTTP / 状态 | 200 / healthy | 200 / healthy |
| 数据库 / Redis | up / up | up / up |
| Cache-Control | no-store | no-store |
| health 时间 | UTC ISO，`Z`，含毫秒 | 上海时区，`+08:00` |
| 构建提交 | `ad2aef0` | `957f424` |
| 匿名 session、common/test | 响应一致 | 响应一致 |
| 匿名设备、文件列表 | 401 JSON | 401 JSON，另含 PHP `type` 字段 |
| 未知路径 404 | JSON | Yii HTML 错误页 |

时间格式的八小时时区差表示相同时间点；提交和构建时间分别代表两个仓库的镜像，不应要求 SHA 相同。单次响应耗时不作为性能结论。

首次代码对照还发现一项当时待对齐、现已修复的行为：Yii 健康检查为 Redis PING 设置 3 秒连接及读取超时并校验响应；Node 默认业务 Redis 仅设置连接超时，已连接但 PING 不返回时缺少命令读取超时，health 也未单独校验 PONG。首次只读对比未改变该实现；下述问题已在本轮对齐发布中修复并经过隔离故障测试，未在生产制造依赖故障。

健康检查仅覆盖业务数据库和 Redis，不能据此证明所有业务流程已完成生产验收。真实微信支付、退款及设备端流程仍需单独联调。
