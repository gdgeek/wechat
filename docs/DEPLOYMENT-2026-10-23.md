# 2026-10-23 wechat2 部署与 b0 对照

## 部署结果

仅部署 Node 后端；现有 Yii 服务、Web 管理端、小程序及设备入口继续保留。

| 节点 | HTTPS 入口 | Portainer Stack | 业务容器 |
| --- | --- | --- | --- |
| b0 | https://x2.b0.01xr.com | `wechat2`，ID 21 | `wechat2`，healthy |
| b1 | https://x2.b1.01xr.com | `wechat2`，ID 19 | `wechat2`，healthy |

业务镜像为 `hkccr.ccs.tencentyun.com/gdgeek/wechat2:latest`，当前构建提交为 `ad2aef03f962b0285a225cdc45f1eb674fa2f0cd`，发布摘要为 `sha256:133b9d563f7df8596fdda84da4260461d4c25440dcb0880d3163240524320cdf`。对应完整提交标签为 `sha-ad2aef03f962b0285a225cdc45f1eb674fa2f0cd`。

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

代码对照还发现一项待对齐行为：Yii 健康检查为 Redis PING 设置 3 秒连接及读取超时并校验响应；Node 默认业务 Redis 仅设置连接超时，已连接但 PING 不返回时缺少命令读取超时，health 也未单独校验 PONG。此次只读对比未改变该实现，也未在生产制造依赖故障。

健康检查仅覆盖业务数据库和 Redis，不能据此证明所有业务流程已完成生产验收。真实微信支付、退款及设备端流程仍需单独联调。
