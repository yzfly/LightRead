-- 迁移 0003: 读者反馈 (应用内「反馈问题或建议」). 与 schema.sql「读者反馈」一段相同, 幂等, 可重跑.
-- 生产: npx wrangler d1 execute lightread-sync -c wrangler.jsonc --remote --file migrations/0003_feedback.sql
--   (workers token 没有 D1 权限: 改走 Cloudflare MCP 的 D1 query API 执行本文件语句)
--   先建表再部署 Worker, 否则提交反馈报 500.

-- 文字与联系方式由用户自己填写; 诊断日志 (已脱敏) 存 R2 feedback/<id>.zip, log_size 为 0 表示没有或已过期删除
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
