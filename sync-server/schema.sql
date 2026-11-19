-- 轻阅账号 / 同步: 账号、验证码、会话、限流计数. 同步文档本体在 R2 (u/<userId>/devices/<deviceId>.json)
-- 建表 (幂等): npx wrangler d1 execute lightread-sync --remote --file schema.sql
-- 时间戳一律为毫秒

CREATE TABLE IF NOT EXISTS users (
  id         TEXT    PRIMARY KEY,           -- crypto.randomUUID()
  email      TEXT    NOT NULL UNIQUE,       -- trim + 小写
  created_at INTEGER NOT NULL
);

-- 每个邮箱同一时刻只有一个有效验证码, 重发即覆盖
CREATE TABLE IF NOT EXISTS codes (
  email      TEXT    PRIMARY KEY,
  code_hash  TEXT    NOT NULL,              -- sha256(email + ':' + code) hex
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,    -- 已尝试次数, 满 5 次作废
  sent_at    INTEGER NOT NULL               -- 60 秒内不重发
);

-- token 只存 SHA-256; 登出即删行, 不设过期
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL,
  device_name  TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

-- 按日计数的限流: key 形如 'code:email:<email>' 'code:ip:<ip>' 'put:<userId>' 'xfer:n:<userId>' 'xfer:b:<userId>' (UTC 日);
-- 'ping:<HMAC(日, IP) 前 32 位十六进制>' (北京日, 不存原始 IP); 取件码 'drop:c:' / 'drop:q:' / 'drop:m:' + 同样的 HMAC (UTC 日)
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT    NOT NULL,
  day   TEXT    NOT NULL,                   -- YYYY-MM-DD (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
CREATE INDEX IF NOT EXISTS counters_day ON counters(day);

-- ---- 匿名使用统计 (docs/usage-stats-plan.md) ----
-- 只有随机安装 ID (客户端生成的 UUID v4)、平台、版本、语言、当天是否打开过阅读器. 不存 IP / UA.
-- day 一律为北京时间 (Asia/Shanghai) 日期 YYYY-MM-DD

-- 每个安装每天一行; reader 取「或」(一旦为 1 当天保持 1). 保留 90 天, 之后聚合进 ping_daily
CREATE TABLE IF NOT EXISTS pings (
  day        TEXT    NOT NULL,
  install_id TEXT    NOT NULL,
  platform   TEXT    NOT NULL,              -- windows|macos|linux|android|ios|web|other
  version    TEXT    NOT NULL,              -- x.y.z
  lang       TEXT    NOT NULL,              -- zh|en
  reader     INTEGER NOT NULL DEFAULT 0,    -- 0|1
  PRIMARY KEY (day, install_id)
);
CREATE INDEX IF NOT EXISTS pings_install ON pings(install_id, day);

-- 每个安装一行, 长期保留 (装机量 / 新增 / 留存). platform / version 为最近一次上报
CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,
  first_day  TEXT NOT NULL,
  last_day   TEXT NOT NULL,
  platform   TEXT NOT NULL,
  version    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS installs_first_day ON installs(first_day);
CREATE INDEX IF NOT EXISTS installs_last_day ON installs(last_day);

-- 90 天前的 pings 按 (天, 平台, 版本) 聚合后的计数 (定时任务写入)
CREATE TABLE IF NOT EXISTS ping_daily (
  day          TEXT    NOT NULL,
  platform     TEXT    NOT NULL,
  version      TEXT    NOT NULL,
  actives      INTEGER NOT NULL,
  readers      INTEGER NOT NULL,
  new_installs INTEGER NOT NULL,
  PRIMARY KEY (day, platform, version)
);

-- 点睛阅读的按天汇总 (心跳里可选的 dj 字段; 客户端只补报已过完的日子). 只有数字, 不含书名、正文、具体的词.
-- min_*: 读中文书的分钟 (关 / 词与词 / 重点词 / 智能); lv_*: 用重点词时各密度档的分钟;
-- ai_ok / ai_all: 智能版 AI 重点词可用的块 / 请求了重点词的块; kw_missing / kw_all: AI 给的词在正文中找不到的 / 总数
CREATE TABLE IF NOT EXISTS dj_daily (
  day        TEXT    NOT NULL,
  install_id TEXT    NOT NULL,
  platform   TEXT    NOT NULL,
  version    TEXT    NOT NULL,
  min_off    INTEGER NOT NULL DEFAULT 0,
  min_words  INTEGER NOT NULL DEFAULT 0,
  min_key    INTEGER NOT NULL DEFAULT 0,
  min_smart  INTEGER NOT NULL DEFAULT 0,
  lv_low     INTEGER NOT NULL DEFAULT 0,
  lv_mid     INTEGER NOT NULL DEFAULT 0,
  lv_high    INTEGER NOT NULL DEFAULT 0,
  ai_ok      INTEGER NOT NULL DEFAULT 0,
  ai_all     INTEGER NOT NULL DEFAULT 0,
  kw_missing INTEGER NOT NULL DEFAULT 0,
  kw_all     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, install_id)
);

-- 90 天前的 dj_daily 按 (天, 版本) 聚合 (定时任务写入)
CREATE TABLE IF NOT EXISTS dj_rollup (
  day         TEXT    NOT NULL,
  version     TEXT    NOT NULL,
  installs    INTEGER NOT NULL,
  users_key   INTEGER NOT NULL,
  users_smart INTEGER NOT NULL,
  min_off     INTEGER NOT NULL,
  min_words   INTEGER NOT NULL,
  min_key     INTEGER NOT NULL,
  min_smart   INTEGER NOT NULL,
  lv_low      INTEGER NOT NULL,
  lv_mid      INTEGER NOT NULL,
  lv_high     INTEGER NOT NULL,
  ai_ok       INTEGER NOT NULL,
  ai_all      INTEGER NOT NULL,
  kw_missing  INTEGER NOT NULL,
  kw_all      INTEGER NOT NULL,
  PRIMARY KEY (day, version)
);

-- ---- 互传 (docs/device-transfer.md) ----
-- 文件本体在 R2: 账号互传 transfer/<accountId>/<id>, 取件码 drop/<id>. 过期行与 R2 对象由每日 Cron 删除

-- 账号内设备间的互传条目. to_device 为 NULL 表示发给本账号的全部其他设备.
-- 文件先建记录 (ready = 0, 24 小时内没传完即清理), PUT 完本体后 ready = 1, 再保留 7 天
CREATE TABLE IF NOT EXISTS transfers (
  id          TEXT    PRIMARY KEY,          -- crypto.randomUUID()
  account_id  TEXT    NOT NULL,
  from_device TEXT    NOT NULL,
  from_name   TEXT    NOT NULL DEFAULT '',
  to_device   TEXT,                         -- NULL = 全部
  kind        TEXT    NOT NULL,             -- text|link|file
  title       TEXT    NOT NULL DEFAULT '',
  text        TEXT,                         -- kind = text, ≤ 64 KB (UTF-8)
  url         TEXT,                         -- kind = link, http(s), ≤ 4096
  r2_key      TEXT,                         -- kind = file
  size        INTEGER,                      -- kind = file, 字节
  mime        TEXT,
  filename    TEXT,
  ready       INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_account_created ON transfers(account_id, created_at);
CREATE INDEX IF NOT EXISTS transfers_expires ON transfers(expires_at);

-- 互传设备登记: 设备轮询 GET /v1/transfers?device= 时写入 (同名且一小时内见过则不写); 90 天没见过即删除
CREATE TABLE IF NOT EXISTS devices (
  account_id   TEXT    NOT NULL,
  device_id    TEXT    NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, device_id)
);

-- 匿名临时取件码. code 只在未过期的取件里唯一 (建码时先删占着该码的过期行);
-- owner_hash = sha256(ownerToken) hex, 发送方凭 ownerToken 上传 / 撤回; account_id 仅已登录发送方有
CREATE TABLE IF NOT EXISTS drops (
  id            TEXT    PRIMARY KEY,        -- crypto.randomUUID()
  code          TEXT    NOT NULL UNIQUE,    -- 6 位数字
  account_id    TEXT,
  owner_hash    TEXT    NOT NULL,
  kind          TEXT    NOT NULL,           -- text|link|file
  title         TEXT    NOT NULL DEFAULT '',
  text          TEXT,
  url           TEXT,
  r2_key        TEXT,
  size          INTEGER,
  mime          TEXT,
  filename      TEXT,
  ready         INTEGER NOT NULL DEFAULT 1,
  downloads     INTEGER NOT NULL DEFAULT 0,
  max_downloads INTEGER NOT NULL DEFAULT 10,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL            -- 创建后 10 分钟或 1 小时
);
CREATE INDEX IF NOT EXISTS drops_expires ON drops(expires_at);

-- ---- 读者反馈 (与 migrations/0003_feedback.sql 相同) ----
CREATE TABLE IF NOT EXISTS feedback (
  id            TEXT    PRIMARY KEY,        -- crypto.randomUUID()
  created_at    INTEGER NOT NULL,
  kind          TEXT    NOT NULL,           -- bug|feature|other
  text          TEXT    NOT NULL,
  contact       TEXT    NOT NULL DEFAULT '',
  version       TEXT    NOT NULL DEFAULT '',
  platform      TEXT    NOT NULL DEFAULT '',
  account_id    TEXT,
  account_email TEXT,
  log_size      INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'new', -- new|seen|planned|done|wontfix
  note          TEXT    NOT NULL DEFAULT ''     -- 维护者备注 (结论 / 对应提交)
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created_at);
CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, created_at);
