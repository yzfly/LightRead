# LightRead AI 试用通道中转

Cloudflare Worker：应用 → 本 Worker → 智谱 (GLM Flash 免费系)。API Key 只存在 Worker 环境变量，客户端零密钥。

## 防线

- 仅放行免费模型白名单（刷爆也不花钱）
- 每 IP 每分钟 10 次限速
- `max_tokens ≤ 1024`、上下文 ≤ 32K 字符

## 划词翻译 `/v1/translate`

- 只给登录轻阅账号用：`Authorization: Bearer <账号会话 token>`，经服务绑定 `ACCOUNT`（`lightread-sync`）调 `GET /v1/me` 校验，结果在 isolate 内缓存 10 分钟。
- 每账号每天 `ACCOUNT_TRANSLATE_DAILY`（默认 100）次，D1 `usage` 表 kind `tr`、id 为账号 id；同样计入全站每日预算。
- 请求体只认 `{ text, target, book? }`（`src/services/translateCore.ts` 校验并在服务端拼提示词），不能当通用代理；响应透传上游 SSE，头 `x-translate-remaining` 为今日剩余次数。
- 配了自己 Key 的用户不经过这里，直接请求自己的服务。

## 部署（首次三条命令）

```bash
cd relay
npx wrangler login          # 浏览器授权 Cloudflare 账号
npx wrangler deploy         # 部署, 输出 workers.dev 地址
npx wrangler secret put UPSTREAM_KEY      # 粘贴智谱 API Key (建议专用小号)
```

之后轮换 Key 只需重跑第三条命令；改代码后重跑 `npx wrangler deploy`。
