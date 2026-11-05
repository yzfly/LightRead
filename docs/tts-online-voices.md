# 在线听书音色调研：更真实的中文语音（2026-10-05）

> 背景：现在的在线引擎是微软 Edge「大声朗读」免费接口（`src-tauri/src/edge_tts.rs` / `src/services/edgeTts.ts`）。默认音色 `zh-TW-HsiaoChenNeural`，很多用户用 `zh-CN-XiaoxiaoNeural`。产品负责人希望音色「更好、更像真人」，并问 Edge 有没有升级。
> 场景：中文长篇听书，以普通话为主，负责人偏爱台湾腔女声。合成粒度是句子到段落。要求大规模使用时便宜或有免费额度，能从 Cloudflare Worker 中转（`relay/`，`lightread-ai.jiangshu.ai`，服务端持有 key）调用，或由客户端用用户自己的 key 直接调用。
> 本地离线方案见 [`tts-research.md`](./tts-research.md)，本文只讨论在线方案。
> 说明：价格和功能来自官方文档或价格页，抓取于 2026-10-05，链接附在条目后。标 **〔未核实〕** 的是推断、二手资料或没在官方页面找到的内容。本次 WebSearch 配额已用完，资料全部靠直接抓取官方页面。没有做主观听感评测，听感要靠负责人试听第 5 节的样本。
> **计价口径**：统一换算成「元 / 万汉字」，1 美元按 7.1 元。注意几家对汉字的计数规则不同：
> - Azure、阿里百炼、MiniMax（国内站）：1 个汉字按 2 个计费字符。
> - Fish Audio、硅基流动：按 UTF-8 字节计费，1 个汉字是 3 字节。
> - 火山、讯飞、腾讯、百度：1 个汉字按 1 个字符。

---

## 1. 结论

1. **Edge 免费接口没有升级。** 我今天实测了 edge-tts 7.2.8 用的音色列表接口，一共 322 个音色，中文仍然是 2024 年那 14 个老 Neural 音色（台湾腔是 HsiaoChen、HsiaoYu、YunJhe）。
   - 列表里没有任何 HD、DragonHD 或中文 Multilingual 音色。
   - 我直接请求了 `zh-CN-XiaoxiaoMultilingualNeural`、`zh-CN-Xiaoxiao:DragonHDLatestNeural`、`zh-CN-Xiaoxiao:DragonHDFlashLatestNeural`、`zh-CN-XiaochenNeural`、`zh-CN-XiaoxiaoDialectsNeural`，全部返回 `NoAudioReceived`。
   - 2025-10 edge-tts 7.2.3 曾换到新接口，短暂多出一批音色（含 XiaochenNeural）。2025-12 新接口失效，作者回退到旧接口，并明确说那批音色"not possible to use anymore"（[edge-tts #445](https://github.com/rany2/edge-tts/issues/445)、[#461](https://github.com/rany2/edge-tts/issues/461)）。
   - 2026 年还有 503 和间歇性"No audio was received"的报告，怀疑是并发或批量请求被限流（[#452](https://github.com/rany2/edge-tts/issues/452)、[#473](https://github.com/rany2/edge-tts/issues/473)、[#482](https://github.com/rany2/edge-tts/issues/482)）。
   - **结论：想在 Edge 里换到更真实的音色，这条路走不通。** 微软的新音色（HD Flash、DragonHD、MAI-Voice-2.1）只在付费的 Azure Speech 上提供。
2. **列表里唯一「新」的东西是英文等语种的 Multilingual 音色**（如 `en-US-AvaMultilingualNeural`）。它们能读中文，我生成了样本，ASR 回写全对。但这是外国人设的跨语种音色，带口音的可能性很大〔待试听〕，不适合作为中文听书的默认音色。
3. **2025–2026 年中文听感明显超过 Edge 的，都是大模型 TTS，全部收费。** 按「真实感 / 价格」排序，中文长篇听书最值得接入的是：
   - **阿里云百炼 CosyVoice v3 / v3.5-flash、Qwen-Audio 3.x**：1.6–2.8 元/万字。有**台湾腔女声「龙安台」`longantai_v3`**，2 元/万字。浏览器可以直接用用户自己的 key 走 HTTP。
   - **火山引擎 豆包语音合成 2.0**：3 元/万字。有「番茄小说同款」旁白音色，支持上下文和指令，是**最像有声书主播**的候选〔基于厂商定位，未盲听〕。台湾腔「湾湾小何」只在 1.0 上有，5 元/万字。
   - **Fish Audio s2.1-pro-free**：**0 元**（合理使用），中文是强项。但免费的具体限制没有公开，不能当成有保障的生产方案。
   - **Azure HD Flash**（如 `zh-CN-Xiaoxiao:DragonHDFlashLatestNeural`）：约 3.1 元/万字。和 Edge 同一家，迁移成本最低。**没有 zh-TW HD 音色。**
4. **台湾腔女声的选择：**

   | 厂商 | 音色 | 价格（元/万字） |
   |---|---|---|
   | 阿里 | 龙安台 `longantai_v3`（「嗲甜台湾女」） | 2 |
   | 火山 1.0 | 湾湾小何 `zh_female_wanwanxiaohe_moon_bigtts` | 5 |
   | 百度 | 度小台 `per=4007`、台媒女声 `per=5977` | 3.5 |
   | Google | Gemini TTS 的 cmn-TW（Preview，用 prompt 控口音） | 2.4–3.6 |

   以下几家没有台湾腔女声：Azure（zh-TW 只有 3 个老 Neural）、Google Chirp 3 HD（不支持 cmn-TW）、MiniMax、腾讯、讯飞（讯飞只有台湾腔男声）。
5. **成本是硬约束。** 按每人每天听 30 分钟，约 8,000 字，每人每月 24 万字：
   - 最便宜的高品质方案（阿里 flash，1.6–2 元/万字）：100 位日活听众每月约 **3,800–4,800 元**，1,000 位约 **3.8–4.8 万元**。
   - 开源免费应用不可能无限量包下这笔钱。
6. **建议的落地方式**（详见第 6 节）：
   - **Edge 继续做免费默认**，同时加强重试、降级和缓存。
   - 新增「**高品质在线（自带 Key）**」引擎，首批接入阿里百炼和火山豆包，可选 Azure HD。
   - 中转站只提供**少量每日试听额度**，用全站预算封顶，并按 `hash(引擎+音色+文本)` 缓存到 R2 复用。
   - Fish 免费模型只作为「尽力而为」的服务端实验通道。

---

## 2. Edge / Azure（微软）

### 2.1 Edge 免费接口现状（实测）

- 接口：`speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list`，用 edge-tts 7.2.8 实测，结果存在 `scratchpad/edge-voices.json`。
- 中文共 14 个：
  - zh-CN 8 个：Xiaoxiao、Xiaoyi、Yunjian、Yunxi、Yunxia、Yunyang、liaoning-Xiaobei、shaanxi-Xiaoni。
  - zh-TW 3 个：HsiaoChen、HsiaoYu、YunJhe。
  - zh-HK 3 个。
  - 和 `src/services/edgeTts.ts` 里 2026-10-04 核对的结果完全一致。
- Multilingual 音色共 12 个，全部是 en、fr、de、it、ko、pt 人设，没有 zh 人设。
- 未列出的音色名（HD、Dragon、Multilingual、Xiaochen）请求后全部无音频。**免费端点拿不到新音色。**
- 风险不变：这是非官方协议，靠 Sec-MS-GEC 签名，随时可能失效。2026 年有 503 和间歇性无音频，并发 4 路就可能触发（见第 1 节链接）。

### 2.2 Azure AI Speech（付费、官方）

- **新音色（只在 Azure 上，不在 Edge 上）**（[HD voices](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/high-definition-voices)、[语言表](https://raw.githubusercontent.com/MicrosoftDocs/azure-ai-docs/main/articles/ai-services/speech-service/includes/language-support/tts.md)）：
  - **DragonHD（GA）**：`zh-CN-Xiaochen:DragonHDLatestNeural`（女）、`zh-CN-Yunfan:DragonHDLatestNeural`（男）。
  - **HD Flash**（只有 zh-CN 和 en-US；区域 eastus、westeurope、southeastasia、chinanorth3）：
    - 女声：Xiaoxiao、**Xiaoxiao2**（有 story、poetry-reading 等风格）、Xiaochen、Xiaoyi、Xiaoyu、Xiaohan、Xiaoke、Xiaoshuang、Xiaoyou。
    - 男声：Yunxi、Yunyi、Yunxiao、Yunhan、Yunxia、Yunye。
    - 写法是 `zh-CN-Xiaoxiao:DragonHDFlashLatestNeural`。
  - **Dragon HD Omni**（2025-12 起 Preview）：文档说给任意现有音色名加 `:DragonHDOmniLatestNeural` 后缀就能试用。`zh-TW-HsiaoChen:DragonHDOmniLatestNeural` 能不能用**〔未核实，值得用 F0 key 试一次〕**。
  - **MAI-Voice-2.1 / 2.1-Flash**（Preview，官方定位包括 audiobooks）：zh-CN 音色有 Bo、Lan、Mei、Wei（[mai-voices](https://raw.githubusercontent.com/MicrosoftDocs/azure-ai-docs/main/articles/ai-services/speech-service/mai-voices.md)）。价格和中文听感〔未核实〕。
  - **zh-TW 没有任何 HD 音色。**
- **价格**（[Azure 零售价格 API](https://prices.azure.com/api/retail/prices)，eastus）：
  - Neural $15/1M 字符；**Neural HD $22/1M**（2026-03-01 起）。
  - **汉字按 2 个字符计费**（[官方文档](https://raw.githubusercontent.com/MicrosoftDocs/azure-ai-docs/main/articles/ai-services/speech-service/text-to-speech.md)），所以 Neural 约 **2.1 元/万字**，HD 约 **3.1 元/万字**。
  - 包月承诺档最低降到 $6/1M。
- **免费 F0**：每月 50 万字符，约 25 万汉字，**只够一个人每天听 30 分钟听一个月**。限速 20 次/分钟。HD 是否计入 F0 免费额度〔未核实〕。适合 BYOK 用户个人使用，不适合做服务端。
- **接入**：REST `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`，请求头带 `Ocp-Apim-Subscription-Key` 和 `X-Microsoft-OutputFormat`，请求体是 SSML。**Worker 可以直接 `fetch`**。HD 首包小于 300ms。
  - 注意：HD 不支持 `<prosody>`，也就是**不能用 SSML 调语速**，播放端要用 `playbackRate` 变速。
- 和 Edge 的关系：Edge 的音色就是 Azure 的普通 Neural。只换成 Azure Neural，**音色不会变好**，只会更稳定，还能用 `mstts:express-as` 的风格（如 gentle、lyrical、poetry-reading）〔具体风格列表未逐个核实〕。真正提升听感要用 HD 或 MAI。
- 试听：[Azure Voice Gallery](https://speech.microsoft.com/portal/voicegallery)。

---

## 3. 国内云 TTS

| 厂商 / 模型 | 元/万汉字（按量） | 免费额度 | 台湾腔女声 | 流式 / 首包 | 浏览器直连（BYOK） | 真实感依据 |
|---|---|---|---|---|---|---|
| **阿里 cosyvoice-v3.5-flash / qwen3-tts-flash** | **1.6** | 每个模型 1 万字符（约 5 千汉字），90 天，北京区 | — | SSE / WS；Qwen3-TTS 模型首包约 100ms | ✔ HTTP（CORS 允许 authorization）；WS 需要 Worker | CosyVoice 3 test-zh CER 1.12；Qwen3-TTS WER 0.77 |
| **阿里 cosyvoice-v3-flash** | **2.0** | 同上 | **✔ 龙安台 `longantai_v3`** | 同上 | 同上 | 同上 |
| 阿里 qwen-audio-3.0-tts-plus / 3.1 | 2.8 / 3.1-flash 约 0.75〔按 token 估算，未核实〕 | 同上 | — | — | ✔ | AA 英文榜 Qwen-Audio-3.1-TTS-Plus 第 2（Elo 1292） |
| **火山 豆包语音合成 2.0**（`seed-tts-2.0`） | **3.0**（资源包 2.8 到 2.1） | 2 万字，6 个月（控制台点「试用」） | 无明确台湾腔；2.0 指令控制能否出台湾腔〔未核实〕 | HTTP chunked / SSE / WS，首包约 600ms | ⚠ CORS 不放行 `X-Api-Key`，走 Tauri 或 Worker | Seed-TTS v1 test-zh WER 1.12；2.0 没有公开评测 |
| 火山 豆包 1.0 | 5.0（大包 3.5） | 2 万字，6 个月 | **✔ 湾湾小何** | 同上 | 同上 | — |
| 火山 精品长文本（小模型，异步） | 1.0（情感版 2.0） | 1 万 | — | 异步 | — | 旧一代 |
| 百度 大模型 / 臻品 流式·长文本 | 3.5（预付 3.0） | 实名个人 5 万字 | **✔ 度小台 4007、台媒女声 5977** | 流式 | 需要 OAuth token〔token 接口 CORS 未核实〕 | 没有公开基准 |
| 讯飞 超拟人 | 只卖资源包：2.0（促销 1.54）到 1.2 | 1 万，3 个月 | ✘（只有台湾腔男声） | WS 双向流 | ✔（签名放在 URL 里） | 没有公开基准；有「旁白女声」 |
| MiniMax speech-2.8 turbo / hd | 4.0 / 7.0 | 价格页没写 | ✘（可以 9.9 元做音色设计〔效果未核实〕） | SSE / WS；异步长文本 API 有字幕 | ✔ | test-zh WER 0.83；AA 英文榜第 18 |
| 腾讯 超自然大模型 / 大模型 | 6.5 / 1.2 | 2 万 / 10 万，3 个月 | ✘ | — | ✘（TC3 签名，只能走 Worker） | — |

来源：
- 火山：[价格](https://www.volcengine.com/docs/6561/1359370)、[试用](https://www.volcengine.com/docs/6561/1359369)、[音色列表](https://www.volcengine.com/docs/6561/1257544)、[V3 API](https://www.volcengine.com/docs/6561/1598757)。
- MiniMax：[国内价格](https://platform.minimax.cn/docs/guides/pricing-paygo)、[系统音色](https://platform.minimax.cn/docs/faq/system-voice-id)。
- 阿里：[价格](https://help.aliyun.com/zh/model-studio/model-pricing)、[CosyVoice 音色表（可试听）](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)、[Qwen-Audio 音色](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)、[Qwen-TTS 音色](https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list)、[接口](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)。
- 讯飞：[产品页](https://www.xfyun.cn/services/smart-tts)、[音色文档](https://www.xfyun.cn/doc/spark/super%20smart-tts.html)。
- 腾讯：[计费](https://cloud.tencent.com/document/product/1073/34112)、[音色](https://cloud.tencent.com/document/product/1073/92668)。
- 百度：[计费](https://cloud.baidu.com/doc/SPEECH/s/Ql9misjot)、[免费额度](https://cloud.baidu.com/doc/SPEECH/s/Wl9mh4doe)、[音色](https://cloud.baidu.com/doc/SPEECH/s/Rluv3uq3d)。
- 「浏览器直连」列是本次调研对 CORS 预检的实测结果，不是官方声明。

要点：

- **阿里百炼性价比最高。** 只有它同时满足四点：有便宜的台湾腔女声、flash 档 2 元以内、HTTP 接口浏览器可以直连、AA 榜上 Qwen-Audio 排名很靠前（不过该榜只测英文）。
  - 适合听书的音色有：龙安台（台湾女）、叶清禾 `yeqinghe_v3.1`（亲切温柔）、谢舒柔 `xieshurou_v3.1`、龙媛 `longyuan_v3.1`（温暖治愈）。
  - CosyVoice 支持「你现在说话的角色是一个旁白」这类指令。
- **豆包 2.0 最「有声书化」。** 「番茄小说同款」的温柔淑女 2.0（`zh_female_wenroushunv_uranus_bigtts`）、儒雅青年 2.0 等音色，加上 `context_texts` 和 `section_id` 多轮上下文，对章节内语气连贯有帮助。
  - 默认 10 路并发，超出部分 100 元/路/月。
  - 文档说「服务开通后，音色需要在官网控制台下单购买」，是否适用于大模型音色要在控制台确认〔未核实〕。
- **按次计费的产品要避开**（百度短文本、火山小模型）。逐句合成时它们按调用次数收钱，单价会偏高。
- **实名认证**：六家都要求实名，个人实名就能用 API 和免费额度。讯飞和百度企业认证后免费额度更大。向终端用户提供服务是否必须企业认证，以及各家 ToS 是否允许「在自己的应用里给最终用户合成」，**全部〔未核实〕**，正式上线前要逐家读服务协议。BYOK 模式下 key 属于用户本人，这个问题小得多。

## 4. 国际厂商

| 方案 | 中文真实感 | 台湾腔女声 | 元/万汉字 | 免费额度 | Worker / 浏览器 |
|---|---|---|---|---|---|
| **Fish Audio s2.1-pro / s2.1-pro-free** | 高（中文是强项；AA 英文榜第 23） | 用音色库或克隆〔音色版权需逐个确认〕 | 3.2；**free 版 0** | free 模型「合理使用」，限制未公开；充值低于 $100 时并发 5 路 | ✔ REST / WS，首包约 300ms |
| Google Gemini 3.8 Flash / Flash-Lite TTS | 高（AA 第 4） | **cmn-TW Preview**，可以用 prompt 控制口音 | 3.6 / 2.4（2027 年起翻倍）〔按 4.5 字/秒估算〕 | Gemini API 有免费层（限速，数据会被用于改进产品） | ✔ REST；Worker 从不支持的地区出网可能被拒〔未核实〕 |
| Google Chirp 3 HD（cmn-CN） | 中高 | ✘（不支持 cmn-TW） | 2.1 | 每月 100 万字符 | 流式只有 gRPC，Worker 只能一次性请求 |
| ElevenLabs v4 / Flash | 高（v4 是 AA 英文榜第 1）；中文〔未核实〕 | 社区音色〔未核实〕 | 5.7 / 2.8 | 每月 1 万 credits，不可商用 | ✔ |
| Cartesia Sonic 3.6 | 中高（AA 第 3，支持 zh） | ✘ | 2.7–3.6 | 每月 2 万，不可商用 | ✔ |
| Inworld TTS-2 / Flash | 中高（AA 第 6，支持 zh） | ✘〔未核实〕 | 1.8 / 1.1 | 有试用 | ✔ |
| OpenAI gpt-4o-mini-tts | 中（官方说主要针对英语优化） | ✘ | 约 3.9〔估算〕 | 无 | ✔；中国大陆和香港有地区限制 |
| Hume Octave | 不支持中文 | — | — | — | — |
| PlayHT | 域名已经无法解析，视为停服 | — | — | — | — |

来源：
- Fish：[价格与限速](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits)（本人复核：s2.1-pro-free 标价 $0.00/M UTF-8 bytes，页面没写限制条款）。
- Google：[Gemini TTS](https://ai.google.dev/gemini-api/docs/speech-generation)、[Gemini 价格](https://ai.google.dev/gemini-api/docs/pricing)、[Cloud Gemini TTS 语言](https://docs.cloud.google.com/text-to-speech/docs/gemini-tts)、[Chirp 3 HD](https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd)、[Cloud TTS 价格](https://cloud.google.com/text-to-speech/pricing)。
- 其他：[ElevenLabs API 价格](https://elevenlabs.io/pricing/api)、[Cartesia 价格](https://cartesia.ai/pricing)、[Inworld 价格](https://inworld.ai/pricing)、[OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech)、[Artificial Analysis 排行榜](https://artificialanalysis.ai/text-to-speech/leaderboard)。
- AA 排行榜**只测英语**，目前找不到可信的中文专项榜。

## 5. 硅基流动（已有 key）与实测样本

### 5.1 硅基流动的 TTS

- `GET /v1/models?sub_type=text-to-speech` 只返回 **`FunAudioLLM/CosyVoice2-0.5B`** 和 **`fnlp/MOSS-TTSD-v0.5`**。fish-speech、IndexTTS-2 都不在列表里。
- 8 个预置音色：alex（沉稳）、benjamin（低沉）、charles（磁性）、david（欢快），anna（沉稳女）、bella（激情女）、claire（温柔女）、diana（欢快女）。**没有台湾腔。** 支持上传 30 秒以内的参考音频做自定义音色（[文档](https://docs.siliconflow.cn/cn/userguide/capabilities/text-to-speech)）。
- 价格：两个模型都是 ¥0.05 / 千 UTF-8 字节（[价格页](https://siliconflow.cn/pricing)），约 **1.5 元/万汉字**。
- 接口是 OpenAI 兼容的 `POST /v1/audio/speech`，参数有 model、input、voice、speed、gain、response_format、sample_rate、stream。
  - 支持 `请用温柔、舒缓…的语气朗读<|endofprompt|>正文` 这种指令前缀，实测前缀**不会被读出来**。
- 评价：CosyVoice2 是 2024-12 的模型，比百炼上的 CosyVoice v3、v3.5 和 Qwen-Audio 旧一代。价格和阿里 flash 差不多，但音色少，也没有台湾腔。**适合拿来做「大模型 TTS 和 Edge 差距多大」的试听对照，不推荐作为正式引擎。**

### 5.2 实测样本

样本目录：`/tmp/claude-1000/-home-ubuntu-workspace-LightRead/47bd3643-15fa-4797-96b1-38080a310901/scratchpad/tts-samples/`。

所有样本都用同一段自拟文本（`passage.txt`，176 字）：文学描写，加一句对白，加日期和时间「2024年3月15日，下午5点40分……20分钟」。

`samples.json` 记录了每个样本的服务商、模型、音色、字数、耗时、首包时间、字节数、时长、价格估算和 ASR 回写。测试机器在美国，访问国内的硅基流动有跨境延迟。

| 文件 | 服务商 / 音色 | 总耗时 / 首包 | 时长 | 大小 | 费用 |
|---|---|---|---|---|---|
| `edge-zh-TW-HsiaoChen.mp3` | Edge 曉臻（当前默认） | 5.7s / 0.65s | 39.1s | 229KB | 免费 |
| `edge-zh-TW-HsiaoYu.mp3` | Edge 曉雨 | 2.7s / 0.55s | 47.3s | 277KB | 免费 |
| `edge-zh-CN-Xiaoxiao.mp3` | Edge 晓晓 | 3.5s / 0.67s | 37.6s | 220KB | 免费 |
| `edge-zh-CN-Yunxi.mp3` | Edge 云希 | 2.0s / 0.54s | 35.8s | 210KB | 免费 |
| `edge-multilingual-Ava-speaking-zh.mp3` | Edge Ava Multilingual 读中文 | 12.2s / 1.4s | 38.5s | 226KB | 免费 |
| `edge-multilingual-Andrew-speaking-zh.mp3` | Edge Andrew Multilingual 读中文 | 10.9s / 1.5s | 46.9s | 275KB | 免费 |
| `siliconflow-cosyvoice2-claire.mp3` | 硅基 CosyVoice2 claire（温柔女） | 4.2s / 1.3s | 39.2s | 614KB | ¥0.025 |
| `siliconflow-cosyvoice2-anna.mp3` | CosyVoice2 anna | 4.6s / 1.6s | 41.5s | 650KB | ¥0.025 |
| `siliconflow-cosyvoice2-diana.mp3` | CosyVoice2 diana | 4.0s / 1.1s | 40.4s | 632KB | ¥0.025 |
| `siliconflow-cosyvoice2-claire-instruct-gentle.mp3` | CosyVoice2 claire 加「温柔舒缓」指令 | 4.7s / 1.3s | 48.9s | 765KB | ¥0.029 |
| `siliconflow-moss-ttsd-anna.mp3` | MOSS-TTSD v0.5 anna | 5.3s / 4.5s | 40.1s | 628KB | ¥0.025 |

本次硅基合成共 5 次，约 ¥0.13。ASR 校验用的是免费的 SenseVoiceSmall。

客观观察（不代替试听）：
- **读对率**：用 SenseVoice 把 11 个样本转写回文本，日期、时间、数字全部读对，没有明显漏读。转写出的「就/旧」「他/她」「书叶/书页」属于 ASR 的同音混淆。
- **语速**：大多在 4.2–4.9 字/秒。曉雨、Andrew 和加指令的 claire 较慢，约 3.6–3.8 字/秒。指令「舒缓」确实让 claire 慢了约 25%。
- **延迟**：Edge 首包约 0.55–0.67s。CosyVoice2 首包 1.1–1.6s，但这包含美国到国内的跨境时间。MOSS-TTSD 首包 4.5s，基本等于不流式，**不适合逐句听书**。
- **体积**：硅基默认输出 128kbps / 32kHz，约是 Edge（48kbps / 24kHz）的 2.8 倍。接入时应该指定 `opus` 或更低码率，减少流量和缓存体积。
- **试听建议**：负责人盲听时，重点对比 HsiaoChen 和 claire、diana 在「笑着说："你终于来了……"」这句的语气，以及长句的停顿。
- **拿不到 key 的方案，用官方试听页对比：**
  - 阿里 [CosyVoice 音色表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)（含龙安台）和 [Qwen-Audio 音色表](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)
  - 火山 [音色列表](https://www.volcengine.com/docs/6561/1257544) 和 [产品页](https://www.volcengine.com/product/tts)
  - [MiniMax 音频](https://www.minimaxi.com/audio)
  - [讯飞超拟人](https://www.xfyun.cn/services/smart-tts)
  - [百度在线合成](https://cloud.baidu.com/product/speech/tts_online)
  - [Azure Voice Gallery](https://speech.microsoft.com/portal/voicegallery)
  - [Google AI Studio 语音生成](https://aistudio.google.com/generate-speech)〔未打开〕
  - [Fish Audio](https://fish.audio/)

## 6. 给 LightRead 的建议

### 6.1 用量与成本估算

- 实测中文朗读约 4.5 字/秒，**30 分钟约 8,000 字**，每人每月 24 万字。
- 100 位日活听众每月约 2,400 万字，1,000 位每月约 2.4 亿字。
- 下表按量计价，没算缓存命中，也没算预取后被跳过的浪费（约 +10–15%）。

| 方案 | 元/万字 | 100 人 × 30 分钟/天（元/月） | 1,000 人（元/月） |
|---|---|---|---|
| Edge 免费 | 0 | 0 | 0（但并发一多就会被限流） |
| Fish s2.1-pro-free | 0 | 0〔合理使用的上限未知〕 | 不现实 |
| 硅基 CosyVoice2 | 1.5 | 3,600 | 36,000 |
| 阿里 cosyvoice-v3.5-flash / qwen3-tts-flash | 1.6 | 3,840 | 38,400 |
| **阿里 cosyvoice-v3-flash（龙安台）** | 2.0 | **4,800** | **48,000** |
| Azure Neural / HD | 2.1 / 3.1 | 5,100 / 7,500 | 51,000 / 75,000 |
| Gemini 3.8 Flash-Lite TTS | 2.4 | 5,760 | 57,600 |
| 阿里 qwen-audio-3.0-tts-plus | 2.8 | 6,720 | 67,200 |
| **火山 豆包 2.0** | 3.0（大包 2.1） | **7,200**（5,040） | **72,000**（50,400） |
| Fish s2.1-pro（付费） | 3.2 | 7,680 | 76,800 |
| 百度 大模型（度小台） | 3.5 | 8,400 | 84,000 |
| MiniMax 2.8 turbo / hd | 4.0 / 7.0 | 9,600 / 16,800 | 96,000 / 168,000 |
| 火山 豆包 1.0（湾湾小何） | 5.0（大包 3.5） | 12,000 | 120,000 |

**结论：由服务端承担费用、无限量提供高品质语音不可行。**
- 按 relay 现有的全站预算机制（`DAILY_BUDGET_CNY = 50`）算，每天就算拿出 30 元给 TTS，用阿里 flash 也只能合成约 15–19 万字，大约 20 人各听 30 分钟。
- 高品质语音只能二选一：**自带 Key（BYOK）**，或者在中转站上做**少量试听**。

### 6.2 落地路线

**P0：保持免费默认，增强稳定性（不花钱）**
- Edge 继续做默认，台湾腔默认仍用 HsiaoChen。
- 加强容错：
  - 出现 503 或 NoAudio 时指数退避重试。
  - 全局并发不超过 2。
  - 连续失败时自动降级到系统 TTS 或本地 Kokoro，并提示用户。
- 按 `hash(引擎+音色+语速+规范化文本)` 缓存已合成的音频。
- Multilingual 音色**不加入**中文音色列表；负责人试听后觉得可用，再作为「实验」项加入。

**P1：「高品质在线（自带 Key）」引擎**（推荐优先做）
- 抽出一个 `CloudTtsProvider` 接口：`synthesize(text, voice, opts) → Blob`，加上音色目录。复用现有 Edge 的分段、预取和播放调度（`listenPlan`）。
- 首批接入两家：
  1. **阿里百炼（DashScope key）**：
     - HTTP 非流式或 SSE，浏览器、Android、桌面都能直接调用。
     - 音色：**龙安台 `longantai_v3`（台湾女）**、叶清禾、龙媛、谢舒柔，再加一个男声。
     - 模型默认 `cosyvoice-v3-flash`，也可以选 `qwen-audio-3.x`。
  2. **火山 豆包 2.0（新版控制台的 API Key）**：
     - 桌面走 Rust，网页和 Android 走中转透传。
     - 原因：浏览器 CORS 不放行 `X-Api-Key`。透传时不落库、不记录 key。
     - 音色：温柔淑女 2.0、儒雅青年 2.0 等「番茄小说同款」，外加 1.0 的**湾湾小何**（台湾女）。
- 可选第三家：**Azure**（key + region）。
  - HD Flash 的 `Xiaoxiao2`、`Xiaochen`，再加 zh-TW 普通 Neural。
  - 卖点是「和 Edge 同一家、最稳定」。
  - F0 每月 25 万汉字，足够个人轻度使用。
- 设置页加「在线语音服务商」分段控件、key 输入框、音色试听按钮。key 只存在本地，可以随设置同步，但要加密或不同步〔待定〕。
- 合成参数：
  - 按 `tts-research.md` 第 8 节分块，LLM 类 TTS 每块 80–200 字。
  - 输出用 opus 或 mp3 低码率。
  - 语速优先用服务端参数，不支持时用 `playbackRate`。

**P2：中转站「高品质试听」（服务端 key，小额度）**
- 在 `lightread-ai.jiangshu.ai` 增加 `/tts` 接口，上游用阿里百炼。
- 额度：
  - 每台设备每天 **2,000 字**（约 7 分钟，够试听和短篇用）。
  - 每个 IP 每天 6,000 字。
  - 并入现有的 D1 用量表，以及 `DAILY_BUDGET_CNY` 全站预算封顶。超出返回 429，客户端自动退回 Edge。
- 缓存：把合成结果按 `hash` 存进 R2。公版书和热门书被多人听时可以直接复用，同时降低成本和延迟。
- 成本：1,000 台设备都用满额度时，约 6,000 万字/月 × 2 元/万字 = **约 1.2 万元/月**，所以一定要靠全站预算封顶。以 30 元/天的预算算，每月约 900 元。
- **Fish s2.1-pro-free** 可以作为第二上游做实验（成本 0），但要满足三个前提：
  - 先确认 Fish 服务条款是否允许免费模型服务第三方用户〔未核实〕。
  - 选一个有明确授权的中文旁白音色（reference_id）。
  - 被限流时自动回退。

**P3：观察项**
- Gemini 3.8 Flash TTS 的 cmn-TW：用免费层做一次台湾腔对比试听。
- 用 F0 key 测 `zh-TW-HsiaoChen:DragonHDOmniLatestNeural`。如果能用，它就是「Edge 默认音色的高清版」，迁移体验最好。
- 豆包 2.0 用指令生成台湾腔的效果。

### 6.3 建议提供的音色（P1 首批）

| 定位 | 服务商 / 音色 | 价格 |
|---|---|---|
| 台湾腔女声（主推） | 阿里 龙安台 `longantai_v3`（cosyvoice-v3-flash） | 2 元/万字 |
| 台湾腔女声（备选） | 火山 湾湾小何（豆包 1.0）；百度 度小台 | 5 / 3.5 元/万字 |
| 温柔女声旁白 | 火山 温柔淑女 2.0；阿里 叶清禾、龙媛 | 3 / 2.8 元/万字 |
| 男声旁白 | 火山 儒雅青年 2.0；阿里 男声旁白音色 | 3 / 2 元/万字 |
| 稳定兜底 | Azure HD Flash Xiaoxiao2（story 风格）、Edge 原有音色 | 3.1 / 0 |

### 6.4 待负责人决定或补充

1. 试听 5.2 节的样本，以及阿里、火山官方页上龙安台、湾湾小何、温柔淑女 2.0 的试听，确认「更像真人」的方向（台湾腔优先，还是旁白感优先）。
2. 是否愿意为中转试听设 TTS 专用预算（建议先每天 20–30 元）。
3. 正式开通阿里百炼和火山前，由开发者实名注册，并通读服务协议中「向第三方或终端用户提供服务」的条款。

## 7. 落地记录：API 语音与 SAPI 5（2026-11-04，issue #19）

**已接入：** MiniMax（国内站 / 国际站）与火山豆包，用户自带 Key，Rust 发请求（`src-tauri/src/cloud_tts.rs`），目录与映射见 `src/services/cloudTts.ts`。只在桌面和 App 提供：网页版没有原生层，豆包也不放行浏览器跨域的鉴权头。阿里百炼、Azure 仍是候选，加一家只需在这两个文件各加一支。

**接口依据（官方文档，2026-11-04 抓取）：**

- MiniMax：`POST https://api.minimax.cn/v1/t2a_v2`（国际站 `api.minimax.io`），`Authorization: Bearer`，`voice_setting.speed` 0.5–2，非流式返回 hex。
- 豆包：`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`，新版控制台 `X-Api-Key`，旧版 `X-Api-App-Id` + `X-Api-Access-Key`，都要 `X-Api-Resource-Id`；`speech_rate` -50–100（-50 为 0.5 倍速、100 为 2 倍速）；响应是相接的 JSON，以 code 20000000 结束。

**未核实：** 没有真实 Key，请求和响应只对照文档用回环服务测过；音色 ID 抄自官方列表，未逐个合成。复刻音色（`S_` 开头）的 Resource Id 按 `seed-icl-2.0` 处理，1.0 复刻音色会报音色错误。

**SAPI 5 是什么：** Windows 自带的语音编程接口，语音引擎注册到系统后，所有支持 SAPI 的程序都能用。它本身不提供更好的音色，音质取决于注册的引擎。issue 提到的项目应是 [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)（发帖人尚未给出地址，这是按描述的推断）：把 Windows 11 讲述人本地自然语音、Edge 在线语音、Azure 语音注册成 SAPI 5 语音。其 README 自称更像 hack，并说明微软未允许第三方使用这些音色、系统更新后可能失效。

**对轻阅的实际价值：** Edge 音色轻阅已内置，经适配器只是绕一圈；真正的增量是讲述人的**离线**自然语音，以及用户自己装的其他 SAPI 语音。所以只做通用的 SAPI 通道（`src-tauri/src/sapi_tts.rs`），不打包、不依赖该适配器，也不自动安装。
