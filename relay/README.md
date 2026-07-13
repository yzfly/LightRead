# LightRead AI 试用通道中转

Cloudflare Worker：应用 → 本 Worker → 硅基流动。API Key 只存在 Worker 环境变量，客户端零密钥。

## 防线

- 仅放行免费模型白名单（刷爆也不花钱）
- 每 IP 每分钟 10 次限速
- `max_tokens ≤ 1024`、上下文 ≤ 32K 字符

## 部署（首次三条命令）

```bash
cd relay
npx wrangler login          # 浏览器授权 Cloudflare 账号
npx wrangler deploy         # 部署, 输出 workers.dev 地址
npx wrangler secret put SILICONFLOW_KEY   # 粘贴硅基流动 API Key (建议专用小号)
```

之后轮换 Key 只需重跑第三条命令；改代码后重跑 `npx wrangler deploy`。
