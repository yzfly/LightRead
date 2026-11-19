# 轻阅账号 API（sync.jiangshu.ai）

可选账号，用于多端同步与互传。同步只存同步记录（`SyncDoc`，见 `docs/sync.md`），**不长期存书籍文件**；书文件仍走用户自己的 WebDAV，或在各设备导入同一本书时按内容指纹自动匹配。例外是「互传」（见下文与 `docs/device-transfer.md`）：用户主动发送的文件临时存在 R2，账号通道保留 7 天、取件码至多 1 小时，到期由 Cron 删除。

- 服务：Cloudflare Worker，源码 `sync-server/`，域名 `https://sync.jiangshu.ai`
- 存储：D1 `lightread-sync`（账号、验证码、会话、限流、互传条目 / 设备登记 / 取件码）+ R2 `lightread-sync`（各设备的 SyncDoc，键 `u/<userId>/devices/<deviceId>.json`，D1 单行 2MB 放不下大文档；互传文件 `transfer/<userId>/<id>`、取件码文件 `drop/<id>`）
- 登录：邮箱验证码（Resend，发件人 `轻阅 LightRead <noreply@jiangshu.ai>`），6 位数字，10 分钟有效，每个验证码最多试 5 次
- 鉴权：`Authorization: Bearer <token>`；token 为 32 字节随机数的 base64url，服务端只存 SHA-256；登出即吊销，不设过期
- CORS：`Access-Control-Allow-Origin: *`（纯 Bearer，无 Cookie），允许 `authorization, content-type, x-drop-token`，方法 `GET, POST, PUT, DELETE, OPTIONS`；文件下载另暴露 `content-length, content-disposition`
- 错误统一为 JSON `{ "error": "<code>", "retryAfter"?: 秒 }`

## 接口

| 方法 路径 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `POST /v1/auth/code` | `{ email }` | `204` | `400 invalid_email`；`429 rate_limited`（带 `retryAfter`）；`502 email_failed` |
| `POST /v1/auth/verify` | `{ email, code, deviceName? }` | `200 { token, account: { id, email, createdAt } }`（首次验证即注册） | `400 invalid_code`（错误 / 过期 / 已用）；`429 too_many_attempts` |
| `GET /v1/me` | — | `200 { account }` | `401 unauthorized` |
| `POST /v1/auth/logout` | — | `204`（吊销当前 token） | `401` |
| `DELETE /v1/me` | — | `204`（删除账号、全部会话、全部同步文档，以及该账号的互传条目、设备登记、已登录时发出的取件码和它们的 R2 文件） | `401` |
| `GET /v1/docs` | — | `200 { docs: SyncDoc[] }`（该账号所有设备的文档） | `401` |
| `PUT /v1/docs/:deviceId` | `SyncDoc`（JSON，`deviceId` 须与路径一致，`format === 1`） | `204` | `400 invalid_doc`；`413 too_large`（> 8MB）；`401` |
| `GET /health` | — | `200 { ok: true }` | — |
| `PROPFIND/GET/HEAD/PUT/DELETE/MKCOL /v1/webdav/:provider/*` | 原样转发（`Authorization: Basic …`） | 上游状态码与响应体 | `404 not_found`（未知服务商）；`401 unauthorized`（无 Basic 鉴权，不带 `WWW-Authenticate`）；`400 invalid_path`；`405` |

`deviceId` 限 `[A-Za-z0-9_-]{1,64}`。邮箱统一 trim + 小写。

### WebDAV 中转（仅网页版）

坚果云、Koofr 的 WebDAV 不支持浏览器跨域（CORS 预检直接 401），网页版经 `/v1/webdav/<provider>/<路径>` 转发：`jianguoyun → https://dav.jianguoyun.com/dav/`，`koofr → https://app.koofr.net/dav/Koofr/`。只转发到这两个固定地址（不是开放代理），不存储、不记录账号密码与内容；去掉上游的 `WWW-Authenticate`，避免浏览器弹出原生登录框。客户端在 `src/services/net.ts` 里按地址改写（`webdavRelayUrl`），桌面 / 安卓走原生请求直连。

## 限流（按 UTC 日计数）

- 发验证码：同一邮箱 60 秒内 1 次、每天 10 次；同一 IP 每天 30 次
- 验证：每个验证码 5 次，超出作废
- 同步：每个账号每天 `PUT /v1/docs` 2000 次（自动同步每 5 分钟一次，一台设备一天 288 次）
- 统计心跳：每个 IP 每个**北京日** 120 次（见「匿名使用统计」）
- 互传：每个账号每天 200 条、文件合计 500 MB；取件码每个 IP 每天创建 20 次、查询 60 次、输错 10 次（见「互传」）

## 数据库

```sql
users    (id TEXT PK, email TEXT UNIQUE, created_at INTEGER)
codes    (email TEXT PK, code_hash TEXT, expires_at INTEGER, attempts INTEGER, sent_at INTEGER)
sessions (token_hash TEXT PK, user_id TEXT, device_name TEXT, created_at INTEGER, last_seen_at INTEGER)
counters (key TEXT, day TEXT, count INTEGER, PK(key, day))
-- 匿名使用统计 (day 为北京时间日期)
pings      (day TEXT, install_id TEXT, platform TEXT, version TEXT, lang TEXT, reader INTEGER, PK(day, install_id))
installs   (install_id TEXT PK, first_day TEXT, last_day TEXT, platform TEXT, version TEXT)
ping_daily (day TEXT, platform TEXT, version TEXT, actives INTEGER, readers INTEGER, new_installs INTEGER, PK(day, platform, version))
-- 互传 (migrations/0001_transfers.sql, 同时并入 schema.sql)
transfers (id TEXT PK, account_id TEXT, from_device TEXT, from_name TEXT, to_device TEXT NULL, kind TEXT, title TEXT,
           text TEXT, url TEXT, r2_key TEXT, size INTEGER, mime TEXT, filename TEXT, ready INTEGER, created_at INTEGER, expires_at INTEGER)
           -- 索引 (account_id, created_at), (expires_at)
devices   (account_id TEXT, device_id TEXT, name TEXT, last_seen_at INTEGER, PK(account_id, device_id))
drops     (id TEXT PK, code TEXT UNIQUE, account_id TEXT NULL, owner_hash TEXT, kind TEXT, title TEXT, text TEXT, url TEXT,
           r2_key TEXT, size INTEGER, mime TEXT, filename TEXT, ready INTEGER, downloads INTEGER, max_downloads INTEGER,
           created_at INTEGER, expires_at INTEGER)   -- 索引 (expires_at)
```

## 互传

设备间发送文字 / 链接 / 文件，设计见 [`device-transfer.md`](device-transfer.md)，实现 `sync-server/src/transfer.ts`。两条服务端通道：账号内设备间（需登录），以及匿名的临时取件码。

### 账号通道（`Authorization: Bearer <token>`，未登录一律 `401`）

条目的线上格式 `TransferItem`（为 `null` 的可选字段省略）：

```ts
{ id, kind: 'text' | 'link' | 'file', fromDevice, fromName, toDevice: string | null,   // null = 发给本账号全部其他设备
  title, text?, url?, filename?, size?, mime?, createdAt /* ms, 服务端时间 */, expiresAt }
```

| 方法 路径 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `GET /v1/devices` | — | `200 { devices: [{ id, name, lastSeenAt }] }`（本账号 90 天内轮询过的设备，新到旧，含本机） | `401` |
| `GET /v1/transfers?device=<id>&name=<设备名>&since=<ms>` | `device` 必填；`name` 可选（不带则保留原名）；`since` 可选 | `200 { items: TransferItem[], now }`：本账号未过期、文件已传完的条目中 (`to_device` = 本机或 NULL，且 `from_device` ≠ 本机) ∪ (`from_device` = 本机)；带 `since` 只返回 `createdAt > since`；新到旧，最多 200 条。顺带登记设备（同名且一小时内见过则不写） | `400 invalid_device` |
| `POST /v1/transfers` | JSON `{ kind, fromDevice, fromName?, toDevice?, title?, text?, url?, filename?, size?, mime? }`（≤ 80 KB） | `201 { item }`。文字 / 链接立即可见（7 天）；文件先建记录（不可见，24 小时内要传完），`fromDevice` 顺带登记 | `400 invalid_transfer`；`413 too_large`；`429 rate_limited` |
| `PUT /v1/transfers/:id/blob` | 请求体为文件本身，`content-length` 必须等于声明的 `size` | `204`，条目变为可见，再保留 7 天 | `404 not_found`（不是本账号的 / 不是文件 / 已过期）；`409 already_uploaded`；`400 invalid_length`；`413 too_large`（> 50 MB） |
| `GET /v1/transfers/:id/blob` | — | 文件流：`content-type: application/octet-stream`、`content-length`、`content-disposition: attachment; filename="…"; filename*=UTF-8''…`、`x-content-type-options: nosniff`、`cache-control: no-store` | `404 not_found` |
| `DELETE /v1/transfers/:id` | — | `204`（账号内任何设备都能删，连同 R2 文件，对所有设备生效） | `404 not_found` |

字段校验（`400 invalid_transfer`，超限 `413 too_large`）：

- `kind` 为 `text | link | file`；`fromDevice` / `toDevice` 同 `deviceId` 规则（`toDevice` 可省略或为 `null`）；设备名 trim 后截到 100 字
- `title` trim 后 ≤ 300 字（超出 400）；为空时链接用网址、文件用文件名作标题，文字可以没有标题
- 文字：`text` 非空，UTF-8 ≤ 64 KB（超出 413）
- 链接：`url` 只允许 `http(s)`，≤ 4096 字（超出 400）
- 文件：`filename` 必填（去掉路径分隔符与控制字符，≤ 255 字）；`size` 为 1 至 50 MB 的整数（超出 413）；`mime` 可选，≤ 100 字
- 只保存与 `kind` 对应的字段，其余忽略

限流（每个账号每个 UTC 日，计数键 `xfer:n:<userId>` / `xfer:b:<userId>`）：200 条；文件按声明的 `size` 计 500 MB（先查额度，超限的那次不计入）。超出 `429 rate_limited` + `retryAfter`（到 UTC 零点的秒数）。

### 临时取件码（匿名）

| 方法 路径 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `POST /v1/drops` | JSON `{ kind, title?, text?, url?, filename?, size?, mime?, ttl? }`；`ttl` 为 `600` 或 `3600`（秒，默认 3600）；可带 Bearer（有效则文件上限 50 MB，无效 / 缺失按匿名，从不 401） | `201 { id, code, ownerToken, expiresAt, maxDownloads }` | `400 invalid_drop`；`413 too_large`；`429 rate_limited`；`503 busy`（8 次都撞码） |
| `PUT /v1/drops/:id/blob` | 头 `x-drop-token: <ownerToken>`；请求体为文件，`content-length` = 声明的 `size` | `204` | `404 not_found`；`403 forbidden`（token 不对）；`410 gone`（已过期）；`409 already_uploaded`；`400 invalid_length`；`413 too_large` |
| `GET /v1/drops/:code` | — | `200 { kind, title, text?, url?, filename?, size?, mime?, createdAt, expiresAt, downloadsLeft }`（`no-store`）。文字 / 链接每次查看算一次领取；文件只看信息不算 | `400 invalid_code`；`404 not_found`（查无 / 文件未传完）；`410 gone`（过期 / 已领完）；`429 rate_limited` |
| `GET /v1/drops/:code/blob` | — | 文件流（同账号通道的下载头），算一次领取 | 同上；非文件 `404` |
| `DELETE /v1/drops/:id` | 头 `x-drop-token` | `204`（发送方撤回，连同文件） | `404 not_found`；`403 forbidden` |
| `GET /d/:code` | — | 分享链接：Worker 配了 `WEB_APP_URL` 时 `302` 到 `<WEB_APP_URL 去掉 # 之后>#/transfer?code=<code>`；否则 `200 text/plain` 说明（打开轻阅 → 互传 → 取件码），从不返回 HTML | `404`（不是 6 位数字） |

- 取件码 6 位数字（均匀随机），只在未过期的取件里唯一：建码时先删占着该码的过期取件（连同文件），撞上未过期的换码，最多 8 次
- `ownerToken` 为 32 字节随机数 base64url，库里只存 SHA-256（`owner_hash`）；`account_id` 只有带有效 Bearer 的发送方才记
- 每个 IP 每个 UTC 日：创建 20 次（`drop:c`）、查询 60 次（`drop:q`，取件信息与下载都算）、输错 10 次（`drop:m`，格式错与查无都算；满 10 次后当天该 IP 的所有查询都 `429`）。计数键是 `<前缀>:<HMAC-SHA256(日期|IP) 前 32 位十六进制>`，与统计心跳同一套 HMAC，不存原始 IP
- 最多领取 10 次（`max_downloads`），用完或过期 `410 gone`；领取计数原子自增，并发也不会超

### 配置与保留

- `WEB_APP_URL`（可选，Worker 变量）：网页版地址，用于 `/d/<code>` 跳转。**仓库的 `wrangler.jsonc` 不设**，需要时用 `wrangler secret put WEB_APP_URL -c wrangler.jsonc` 或在控制台的变量里加
- 每天 UTC 03:17 的 Cron：删除 `expires_at` 已过的互传条目与取件（每轮 1000 行，先删 R2 对象再删行），以及 90 天没见过的设备登记
- 建表：`migrations/0001_transfers.sql`（与 `schema.sql` 末尾一段相同，幂等）

## 匿名使用统计

应用每天最多上报两次匿名心跳（打开应用一次；当天第一次打开书再一次），用于装机量、日活 / 月活、留存。方案与隐私边界见 [`usage-stats-plan.md`](usage-stats-plan.md)。实现：`sync-server/src/stats.ts`。

| 方法 路径 | 请求 | 成功 | 失败 |
|-----------|------|------|------|
| `POST /v1/ping` | `{ id, platform, version, lang, reader }`（见下） | `204` | `400 invalid_ping`；`429 rate_limited`（`retryAfter` 为到北京时间零点的秒数） |
| `GET /v1/admin/stats?days=30` | `Authorization: Bearer <ADMIN_TOKEN>`；`days` 1–365，默认 30 | `200` 统计 JSON（`cache-control: no-store`） | `401 unauthorized`（无 / 错令牌，或服务端未设 `ADMIN_TOKEN`）；`400 invalid_days` |
| `GET /admin` | — | 自包含的统计页（HTML，无外部脚本，CSP `default-src 'none'`） | — |

心跳请求体（≤1 KB，严格校验，多余字段忽略不存，CORS 对所有来源开放）：

- `id`：客户端生成的随机 UUID v4（大小写均可，存小写）
- `platform`：`windows | macos | linux | android | ios | web | other`
- `version`：`x.y.z`（纯数字 semver，无前缀 / 预发布后缀）
- `lang`：`zh | en`
- `reader`：布尔，当天是否打开过阅读器

服务端按**北京时间**（Asia/Shanghai）切天：`pings` 每个安装每天一行，`reader` 取「或」（一旦为真当天保持），平台 / 版本 / 语言取最新；`installs` 记首次 / 最近出现日。**不存 IP、UA 或其它任何字段**；Worker 关闭了调用日志（`observability.logs.invocation_logs = false`），Cloudflare 侧也不留请求头。

限流：每个 IP 每个北京日 120 次心跳（客户端每天至多 2 次，相当于约 60 个安装共用一个出口 IP）。计数键是 `ping:<HMAC-SHA256(ADMIN_TOKEN, 日期|IP) 前 32 位十六进制>`，不含原始 IP，两天后由定时任务删除。

保留：每天 UTC 03:17 的定时任务把 90 天前的 `pings` 按（天, 平台, 版本）聚合进 `ping_daily` 后删除；`installs` 长期保留（只有随机 ID，装机量与新增依赖它）。

统计 JSON（字段均以「安装」计，不是人）：

```jsonc
{
  "generatedAt": "…", "timezone": "Asia/Shanghai", "today": "2026-10-05", "days": 30,
  "note": "统计的是安装（随机安装 ID），不是人…",
  "totals":  { "installs": 0, "newToday": 0, "new7d": 0, "new30d": 0 },
  "active":  { "dau": 0, "dauYesterday": 0, "wau": 0, "mau": 0, "avgDau30": 0, "stickiness": 0.25 },
  "daily":   [{ "day": "2026-09-06", "actives": 0, "readers": 0, "newInstalls": 0 }],   // days 天, 旧到新
  "platforms": [{ "name": "android", "installs": 0 }],   // 按月活 (最近 30 天出现过), 最新平台
  "versions":  [{ "name": "1.8.0", "installs": 0 }],     // 近 7 天活跃, 最新版本
  "langs":     [{ "name": "zh", "installs": 0 }],        // 按月活
  "retention": {
    "d1": { "rate": 0.35, "cohortSize": 120 }, "d7": { … }, "d30": { … },   // 已到期群组按人数加权
    "cohorts": [{ "day": "2026-10-04", "size": 3, "d1n": 1, "d7n": null, "d30n": null, "d1": 0.3333, "d7": null, "d30": null }]
  }
}
```

- 日活 / 周活 / 月活：截至今天（北京时间）最近 1 / 7 / 30 天出现过的安装数；今天的日活随上报累积，`dauYesterday` 是完整的一天
- 黏性 `stickiness` = 近 30 天平均日活 / 月活；平均日活只算今天之前的完整日子，并从开始有数据的那天算起
- 留存：按 `installs.first_day` 分组（最近 40 天的群组，新到旧），`dN` 为第 N 天当天回来的比例；第 N 天还没过完的为 `null`
- 每日序列 90 天内来自 `pings`，更早的来自 `ping_daily`；新增来自 `installs`
- 上线前已有的用户会在第一次上报那天计为新增

管理员令牌是 Worker secret `ADMIN_TOKEN`，本机备份在 `~/.config/lightread/stats-admin-token`（600）。轮换：生成新值写入该文件，再 `tr -d '\n' < ~/.config/lightread/stats-admin-token | npx wrangler secret put ADMIN_TOKEN -c wrangler.jsonc`。查看：浏览器打开 <https://sync.jiangshu.ai/admin>（首次输入令牌，只存在该浏览器的 localStorage），或在仓库里 `npm run stats`（`-- --days 90`、`-- --json`）。

## 读者反馈

应用内「反馈问题或建议」（设置首页「关于」分组，以及关于页「遇到问题」）。匿名可用；带有效 `Authorization: Bearer <token>` 时记下账号（无效 token 按匿名处理）。实现：`sync-server/src/feedback.ts`，客户端 `src/services/feedback.ts` + `components/FeedbackDialog.vue`。

| 方法 路径 | 请求 | 成功 | 失败 |
|-----------|------|------|------|
| `POST /v1/feedback` | `{ kind, text, contact?, version, platform, log? }`（见下） | `201 { id }` | `400 invalid_kind / invalid_text / invalid_log / invalid_feedback`；`413 too_large`；`429 rate_limited`（每 IP 每北京日 10 条，`retryAfter` 到北京时间零点） |
| `GET /v1/admin/feedback?status=new&since=<ms>&limit=100` | `ADMIN_TOKEN`；`status` 为 `new / seen / planned / done / wontfix / all`（默认 all），`limit` ≤200，新的在前 | `200 { items, counts }` | `401`；`400 invalid_status / invalid_since` |
| `GET /v1/admin/feedback/<id>/log` | `ADMIN_TOKEN` | `200` zip | `401`；`404 not_found` |
| `POST /v1/admin/feedback/<id>` | `ADMIN_TOKEN`；`{ status?, note? }`（备注 ≤2000 字） | `200` 更新后的条目 | `401`；`400 invalid_status / invalid_note / invalid_body`；`404` |

- `kind`：`bug | feature | other`；`text` 去首尾空白后 1–4000 字；`contact` ≤200 字（默认填账号邮箱，可清空）；`version` / `platform` ≤32 字
- `log`：用户勾选「同时提交诊断日志」（默认勾选）时附上的诊断包 zip（与「导出诊断日志」同一份，写入与导出各脱敏一次），base64，解码后 ≤2.5 MB 且以 `PK` 开头；客户端超过 2.4 MB 时只带当前日志 `lightread.log`
- 存储：D1 表 `feedback`（`migrations/0003_feedback.sql`），日志存 R2 `feedback/<id>.zip`；**180 天后定时任务删日志，文字保留**；注销账号时反馈与账号脱钩（`account_id` / `account_email` 置空）
- 条目字段：`id, createdAt, kind, text, contact, version, platform, accountEmail, logSize, status, note`
- 查看：管理页 <https://sync.jiangshu.ai/admin> 最下面的「读者反馈」（改状态、写备注、下载日志），或 `node scripts/feedback-digest.mjs`（`--all`、`--since 2026-11-01`、`--logs <目录>`、`--json`、`--mark-seen`）。维护者每三天集中看一次新反馈，分成问题 / 建议 / 其他，**用户确认后才动手实现**

## 客户端

- `src/services/account.ts`：登录状态（localStorage `lightread-account`）与上述接口的封装
- `src/services/sync/accountRemote.ts`：实现 `SyncRemote`，`kind = 'account'`，`supportsFiles = false`，`id = account:<userId>`
- 同步时依次对「账号」和「WebDAV」各跑一次同步（两者都配置时），两边都是同一套 CRDT 文档，可同时使用。**基线全设备共用一份**（记录同步过的远端列表）：分远端存基线会把从 A 远端收到的改动当成本地新编辑推到 B 远端，导致阅读时长重复累计、较新的编辑被旧值覆盖；只有换到同类的另一个远端（另一个账号 / 另一个 WebDAV 地址）才按首次同步处理，见 `src/services/sync/baseline.ts`
- 登录成功后自动打开「自动同步」
- 设置随同步：文档里的可选字段 `settings`（见 `docs/sync.md`「设置同步」）。服务端不解析、原样存储；登录后先同步账号，账号带来的 WebDAV 配置在同一次同步里就能用上。开启「同步密码与密钥」时 WebDAV 密码、AI API Key 也在文档里，以明文存在 R2（只有本账号的 Bearer token 能读）
- 私人书库 / 自定义书源随同步：文档的 `sources` 字段（见 `docs/sync.md`「私人书库（自定义书源）」），**始终**包含 OPDS 账号密码（不受「同步密码与密钥」开关控制），同样以明文存在 R2、只有本账号能读。服务端只校验 `sources` 是对象，不解析内容，键的规范化与修改时间都在客户端，后端与 D1 无需改动
- API 地址默认 `https://sync.jiangshu.ai`，可用构建变量 `VITE_SYNC_API` 或 localStorage `lightread-sync-api` 覆盖（仅用于本地测试）
