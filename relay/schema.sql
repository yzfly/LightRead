-- 匿名用量计数: 设备/IP 每日配额
CREATE TABLE IF NOT EXISTS usage (
  day   TEXT    NOT NULL,
  kind  TEXT    NOT NULL,  -- 'd' 设备 / 'i' IP
  id    TEXT    NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, id)
);
