# 本机模型（离线翻译、本机语音）

轻阅用 llama.cpp 在设备上跑小模型：划词翻译（混元 Hy-MT2）和听书的本机语音（Qwen3-TTS）。模型不随安装包分发，由用户在应用里下载。
参考了 `pocketpal-ai-zh`（设备分档、内存估算、闪退降级、下载来源顺序）和 `pocketwisdom-desktop`（Qwen3-TTS 的调用方式）。

## 现状（2026-11-12）

| 平台 | 引擎 | 计算 | 验证到哪一步 |
|---|---|---|---|
| macOS（Apple 芯片） | 有 | 显卡（Metal），失败退回处理器 | MacAir（M5，16 GB）上翻译与语音都用真实模型跑通，与离线语音库共存 |
| Windows | 有 | 处理器；`local-llm-vulkan` 特性可开显卡 | **没有构建过**，等 CI |
| Android（arm64） | 有（只有翻译） | 处理器（只用大核） | t9 上出过测试签名的 APK（106.9 MB，比不带引擎时约多 13 MB）；**没有在手机上跑过** |
| Linux 桌面 | 无 | — | 与离线语音库冲突，见下文 |
| iOS、网页版 | 无 | — | — |

没有引擎的平台界面上不出现入口，翻译和朗读照旧走在线通道。

## 模型

| 用途 | 模型 | 大小 | 许可 | 实测 |
|---|---|---|---|---|
| 翻译 | 腾讯混元 Hy-MT2 1.8B，Q4_K_M | 1.13 GB | Apache-2.0 | M5 显卡约 95 token/s、内存 1.5 GB；仅处理器约 61 token/s、2.4 GB；t9（8 核 x86，4 线程）约 28 token/s |
| 语音 | 通义 Qwen3-TTS 12Hz 1.7B Base：主干 Q4_K_M + 声码器 Q8_0 | 1.04 + 0.45 GB | Apache-2.0 | M5 显卡：合成速度约为播放速度的 2 倍，首次加载不到 1 秒，内存峰值 3.2 GB（与翻译模型同时在内存里 3.3 GB） |

- 支持界面里的全部 9 种目标语言。简繁互转仍用 OpenCC（`zhConvert.ts`），不经模型。
- 选它的原因：专做翻译的小模型里质量最好的一档，GGUF 官方提供。更小的 2-bit / 1.25-bit 版本在标准 llama.cpp 里加载不了，目前没有能用的 1 GB 以下选项。
- 下载来源：中文界面先 ModelScope，再 hf-mirror，最后 Hugging Face；其他语言反过来。Hugging Face 固定到提交 `a0c709d`，所有来源按同一个 SHA-256 校验，支持断点续传。
- 提示词按模型卡片的两种写法（`translateCore.ts` 的 `localTranslatePrompt`），采样参数 temperature 0.2、top_p 0.6、top_k 20、repeat_penalty 1.05。
- 一个自然段一次请求，超过 600 字的段落在句末再拆（`splitForLocalTranslate`）：小模型逐段翻更稳，也保证装得进 4096 的上下文。

### 本机语音

- 只在电脑上提供：内存 12 GB 以上、8 线程以上。仅用处理器时合成大约只与播放速度持平，所以下载后还要看实测：「合成速度 ÷ 播放速度」低于 1.15 就不用它，朗读自动走在线语音（设置不变，界面说明原因）。
- 手机暂不提供。更小的 0.6B 是候选，但目前没有 llama.cpp 官方转换的 GGUF，第三方转换没有验证过。
- 音色：Base 模型按一段参考录音的音色朗读。应用自带两段（女声、男声，各约 6 秒，`src-tauri/voices/`），由离线语音 Kokoro 的两个推荐音色合成（Kokoro 模型 Apache-2.0），重新生成的方法见 `local_tts` 的 `makes_reference_voices` 测试。
- 语速：模型没有语速参数，合成后在原生层做变速不变调（WSOLA，`local_llm/stretch.rs`）。
- 朗读语言按文字种类判断（`localVoiceCore.ts` 的 `speechLang`）：中、日、韩、俄能分辨，拉丁字母一律按英语读。
- 一块约十几秒（`CHUNK_PROFILES.qwen`），上下文 2048；比命令行工具 `llama-tts` 的默认配置省一半内存。
- 正确性只做过机器检查：用 whisper 转写合成结果，与原文读音一致（中文、英文各一句）。**音质和自然度没有人听过。**

## 设备判断

目标是：带得动才提供，带不动的设备看不到下载入口；能用显卡就用，否则用处理器。

1. **下载前**（`local_llm/device.rs`，纯函数）
   - 手机：内存不足 6 GB 或少于 8 核，不提供。
   - 桌面：内存不足 8 GB、少于 4 线程、或处理器不支持 AVX2，不提供。
   - 模型占用（文件大小 × 1.125 + 上下文）超过「min(60% 内存, 内存 − 1.2 GB)」，不提供。
   - 磁盘剩余不足「模型 + 512 MB」，不提供。
   - 原因以中英文短句返回，界面原样显示。
2. **线程数**：有大小核时只用大核（Android 读各核最高频率，Apple 芯片读性能核数），否则用一半逻辑核；上限 8，至少留一个核给界面。
3. **显卡**：构建带显卡后端且加载成功就用；加载失败当场退回处理器。
4. **实测速度**：每次生成后记录 token/s（`<id>.speed`）。低于 6 token/s 算慢：有在线通道时自动让给在线；没有（未登录也没填 Key）仍用本机。
5. **闪退保护**：llama.cpp 内存不足时会直接结束进程，Rust 捕获不了。加载和推理期间留标记文件：
   - 显卡上闪退过一次 → 下次自动只用处理器；
   - 处理器上也闪退 → 停用，设置页给出「再试一次」；
   - 正常退出时正在推理不算闪退。
6. **内存释放**：模型空闲 5 分钟（手机 2 分钟）后自动卸载；内存不足 12 GB 的设备上翻译模型和语音模型不同时留在内存里。
7. **退出**：应用退出时先停下推理并释放模型。llama.cpp 的 Metal 后端在进程退出时若还有模型没释放会直接 abort（MacAir 实测），不处理的话表现为「退出时闪退」。

## 代码位置

| 位置 | 内容 |
|---|---|
| `src-tauri/src/local_llm/mod.rs` | 模型登记表、下载、状态、闪退标记、命令 `local_llm_*` |
| `src-tauri/src/local_llm/device.rs` | 设备评估与线程数（纯函数，带测试） |
| `src-tauri/src/local_llm/engine.rs` | 文本生成：模型常驻一份，每次请求新建上下文，逐段吐字，可取消 |
| `src-tauri/src/local_llm/tts.rs` | 语音生成：llama.cpp 的实验性接口 `mtmd_helper_gen_audio_*`（直接用 `llama-cpp-sys-2`） |
| `src-tauri/src/local_llm/stretch.rs` | 变速不变调与 WAV 读写（纯函数，带测试） |
| `src-tauri/src/model_download.rs` | 大文件下载（代理 → 直连、续传、SHA-256），离线语音包也用它 |
| `src/services/localLlm.ts` | 前端状态与流式生成 |
| `src/services/translateCore.ts` | 提示词、分段、「用不用本机」的规则（纯函数） |
| `src/services/translate.ts` | 翻译路由：本机 → 自己的 Key → 账号额度；本机出错回退在线 |
| `src/services/localVoiceCore.ts` | 朗读语言判定、「用不用本机语音」的规则（纯函数） |
| `src/services/tts.ts` | 朗读引擎 `qwen`：可用时本机合成，否则自动用在线语音 |
| `src/components/LocalModelPack.vue` | 下载 / 开关 / 删除，设置页「AI 助手」、翻译面板、听书面板共用 |
| `src/components/QwenVoiceRow.vue` | 听书面板「本机」那一行：选音色，或给出下载 / 不可用的说明 |

生成结果经 Tauri 通道送回，最后一条是统计。统计不走命令返回值：通道消息与命令返回之间没有先后保证，那样会漏掉末尾的文字。

## 为什么 Linux 桌面不带

预编译的 sherpa-onnx 静态库（离线语音）和 llama.cpp 各自带一份 `std::regex` 的模板实例，由不同版本的 GCC 编出，内存布局不同；静态链接时被合并成一份，加载模型时在分词器的正则里 `free(): invalid pointer`（2026-11-12 t9 实测，堆栈指向 `unicode_regex_split`）。同一份引擎代码单独链接时在 t9 上正常。

macOS 上两者共存已实测正常。Windows 没有验证，如果出现同类问题，做法与 Linux 相同：把其中一方隔离成独立的动态库或进程。

## 构建

- 需要 `cmake` 和 `libclang`（生成绑定）。`npm run android:build` 没设 `LIBCLANG_PATH` 时用 NDK 自带的那份。
- 引擎只在 macOS / Windows / Android 编进去：`src-tauri/build.rs` 给出 `llm_engine`，`Cargo.toml` 的依赖表与它一致。`--no-default-features` 得到不带引擎的包。
- 绑定库 `llama-cpp-2` 固定在 `=0.1.161`：C 接口随 llama.cpp 变，升级后要重跑真实模型测试。
- Android 静态链接 C++ 运行库，APK 不需要 `libc++_shared.so`。llama.cpp 是否按优化模式编译取决于 Cargo 的 `DEBUG`；`android:build` 固定 `CARGO_PROFILE_DEV_DEBUG=0`，所以是优化版。
- t9 上：`cmake` 在 `~/.local/bin`；crates.io 直连不通，用 `--config 'source.crates-io.replace-with="rsproxy"' --config 'source.rsproxy.registry="sparse+https://rsproxy.cn/index/"'`。

## 测试

```bash
npm run test:translate                       # 提示词 / 分段 / 路由规则
npm run test:read-aloud                      # 含本机语音: 朗读语言 / 可用规则 / 播放器走本机或回退在线
cargo test --manifest-path src-tauri/Cargo.toml --lib -- local_llm model_download   # 设备评估 / 登记表 / 闪退降级 / 续传 / 变速
E2E_BASE=http://localhost:<端口> npm run e2e:translate   # 最后一步: 未登录 → 下载入口 → 进度 → 本机翻译 (原生层用替身)
# 真实模型 (macOS / Windows / Android 目标; Linux 不带引擎):
LOCAL_LLM_TEST_MODEL=<Hy-MT2-1.8B-Q4_K_M.gguf> cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored translates_with_a_real_model --nocapture
LOCAL_TTS_TEST_DIR=<含 model.gguf / mmproj.gguf / speaker.wav 的目录> cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored speaks_with_a_real_model --nocapture
```

## 还没做

- Windows 构建与实测（翻译、语音都没有）；Android 真机（K30）上翻译的速度、内存和发热。
- 在装好的应用里走一遍：真实下载（三个来源都用 curl 验证过续传，应用内的下载流程只测了替身）、听书面板里用本机语音读完一章。目前验证到的是原生层的真实模型测试加上界面的替身测试，两头没有在同一个运行的应用里接起来过。
- 本机语音的音质、自然度、长时间朗读的稳定性；正在合成时停止朗读的取消路径只有单元测试。
- 手机上的本机语音（等可用的 0.6B 转换）；Android 显卡（OpenCL 只在较新的高通芯片上稳定，联发科没有可用路径）。
- Linux 上的隔离方案。
- MacAir 上 `http_upload` 的一个测试失败（系统代理把连不上的地址变成 502），与这部分改动无关，t9 上通过。
