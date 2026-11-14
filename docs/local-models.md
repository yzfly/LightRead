# 本机模型（离线翻译、本机对话、本机语音）

轻阅用 llama.cpp 在设备上跑小模型：划词翻译（混元 Hy-MT2）、阅读助手的本机对话（通义千问 Qwen3.5，按设备分三档）和听书的本机语音（Qwen3-TTS，只在电脑上）。模型不随安装包分发，由用户在应用里下载。
手机上的离线朗读不走 llama.cpp，用的是 Kokoro（sherpa-onnx），见文末「手机上的离线语音」。
参考了 `pocketpal-ai-zh`（设备分档、内存估算、闪退降级、下载来源顺序）和 `pocketwisdom-desktop`（Qwen3-TTS 的调用方式）。

## 现状（2026-11-12）

| 平台 | 引擎 | 计算 | 验证到哪一步 |
|---|---|---|---|
| macOS（Apple 芯片） | 有 | 显卡（Metal），失败退回处理器 | MacAir（M5，16 GB）上翻译与语音都用真实模型跑通，与离线语音库共存 |
| Windows | 有（只有翻译） | 处理器；`local-llm-vulkan` 特性可开显卡 | CI（windows-latest，4 核）上构建、出安装包，并用真实模型跑通翻译（约 30 token/s）；语音实测只有播放速度的 0.4 倍，所以不提供。**没有在装好的应用里试过** |
| macOS（Intel） | 有（只有翻译） | 处理器 | CI 上交叉编译并打包通过；**没有实机** |
| Android（arm64） | 有（翻译、对话） | 处理器（只用大核） | K30（骁龙 865、12 GB，Android 12）真机：应用内下载并校验模型，在《理想国》里选段翻译走本机，约 11–13 token/秒，应用占用约 1.9 GB，未闪退。2026-11-14：设置页选「本机模型」→ 下载 Qwen3.5 2B → 在《理想国》的 AI 助手里提问得到回答，约 9 token/秒 |
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

### 本机对话（Qwen3.5）

「设置 → AI 助手 → AI 服务」里的「本机模型」（`settings.aiProvider = 'local'`）：问书、划词解读、翻译都由本机的通义千问 Qwen3.5 回答，不联网。只在带引擎的版本里列出。

| 档位 | 模型 | 大小 | 提供给 |
|---|---|---|---|
| 轻量 | Qwen3.5 0.8B，Q4_K_M | 0.5 GB | 4 GB 以上的手机，8 GB 以上的电脑 |
| 标准 | Qwen3.5 2B，Q4_0 | 1.1 GB | 6 GB 以上的手机，8 GB 以上的电脑 |
| 增强 | Qwen3.5 4B，Q4_0 | 2.4 GB | 8 GB 以上的手机（慢），12 GB 以上的电脑 |

- 选型、量化和分档取自 `pocketpal-ai-zh` 的中文预设与设备规则：1B 以下用 Q4_K_M，2B 以上用 Q4_0。文件用 unsloth 的转换（不带 MTP 头、不带视觉部分），Hugging Face 固定到提交，ModelScope 是同一份文件。
- **按设备推荐一档**（`device::chat_tier`，状态里的 `recommended`）：手机 8 GB 以上推荐 2B，其余 0.8B；电脑有显卡加速且 16 GB 以上推荐 4B，8 GB 以上 2B。带不动的档位显示原因，不提供下载；用过之后按实测速度提示（低于 6 token/秒建议换小一档）。
- 实测：t9（8 核 x86，4 线程）0.8B 约 43 token/秒；K30 Pro（骁龙 865，4 个大核）2B 约 9 token/秒。`pocketpal-ai-zh` 用 llama.rn 在同一台手机上测到 2B 约 16 token/秒，差距应来自编译选项（ARM 的 dotprod / i8mm 内核），还没有查。
- 思考：模板末尾接一个空的思考块（`<think>\n\n</think>`），模型直接作答。采样用 Qwen3.5 不思考模式的推荐值（temperature 0.7、top_p 0.8、top_k 20）。
- 上下文：电脑 8192，手机 4096。消息在前端裁进上下文（`localChatCore.ts` 的 `fitChatMessages`：留系统提示与当前问题，历史从近往远留）。
- 点睛的 AI 选词和 BabelDOC 不走本机模型（一个要结构化输出，一个是外部命令行工具）。
- 0.8B 的回答较粗，会有事实差错（K30 上 2B 回答「苏格拉底」时也编了生平细节）；界面文案如实写了「偶有差错」。

### 本机语音

- 只在有显卡加速的构建上提供，目前是 Apple 芯片的 Mac，且内存 12 GB 以上、8 线程以上。仅用处理器跟不上朗读（M5 约持平，Windows 4 核 CI 机器只有 0.4 倍）；Windows 要等 Vulkan 构建。下载后还要看实测：「合成速度 ÷ 播放速度」低于 1.15 就不用它，朗读自动走在线语音（设置不变，界面说明原因）。
- 手机不提供。2026-11-14 在 K30 Pro（骁龙 865，4 线程）用同一套调用实测：合成速度只有播放速度的 0.14 倍（主干 2.7 帧/秒，持平要 12 帧/秒；8 秒的声音光声码器就要 19 秒），换更小的 0.6B 主干也补不回来。手机上的离线朗读改用 Kokoro，见文末。
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
| `src/services/localChatCore.ts` | 本机对话：用哪个模型、消息裁剪（纯函数） |
| `src/services/ai.ts` | `chatStream`：AI 服务选了「本机模型」时走 `localLlm.ts` 的 `localChat` |
| `src/components/LocalChatModels.vue` | 设置页的三档模型列表：推荐 / 下载 / 选用 / 删除 |
| `src/components/QwenVoiceRow.vue` | 听书面板「本机」那一行：选音色，或给出下载 / 不可用的说明 |

生成结果经 Tauri 通道送回，最后一条是统计。统计不走命令返回值：通道消息与命令返回之间没有先后保证，那样会漏掉末尾的文字。

## 为什么 Linux 桌面不带

预编译的 sherpa-onnx 静态库（离线语音）和 llama.cpp 各自带一份 `std::regex` 的模板实例，由不同版本的 GCC 编出，内存布局不同；静态链接时被合并成一份，加载模型时在分词器的正则里 `free(): invalid pointer`（2026-11-12 t9 实测，堆栈指向 `unicode_regex_split`）。同一份引擎代码单独链接时在 t9 上正常。

macOS 上两者共存已实测正常。Windows 没有验证，如果出现同类问题，做法与 Linux 相同：把其中一方隔离成独立的动态库或进程。

## 构建

- 需要 `cmake` 和 `libclang`（生成绑定）。`npm run android:build` 没设 `LIBCLANG_PATH` 时用 NDK 自带的那份。
- 引擎只在 macOS / Windows / Android 编进去：`src-tauri/build.rs` 给出 `llm_engine`，`Cargo.toml` 的依赖表与它一致。`--no-default-features` 得到不带引擎的包。
- Windows：预编译的 sherpa-onnx 是静态 CRT（/MT），llama.cpp 必须一致，否则链接报 LNK2038；仓库根的 `.cargo/config.toml` 设了 `LLAMA_STATIC_CRT=1`。
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

## 手机上的离线语音（Kokoro，2026-11-14）

Android App 的「离线」朗读与桌面是同一套：sherpa-onnx + Kokoro v1.1-zh（`src-tauri/src/local_tts.rs`），语音包（约 350 MB）由用户在听书面板下载。`pocketpal-ai-zh` 在手机上也是用 Kokoro（它走 onnxruntime-react-native）。

- 引擎：Rust 的 `sherpa-onnx-sys` 不给 Android 下载预编译库。`scripts/fetch-sherpa-android.mjs` 从上游 Release 取 `sherpa-onnx-v<版本>-android.tar.bz2`（版本须与 `Cargo.lock` 一致，压缩包与两个库都按 SHA-256 校验），经 `SHERPA_ONNX_LIB_DIR` 交给它动态链接；`npm run android:build` 把 `libsherpa-onnx-c-api.so` 与 `libonnxruntime.so` 放进 APK。APK 因此从 108.8 MB 涨到 138.9 MB。
- 不用 `npm run android:build`、直接对 Android 目标跑 `cargo` 时要自己设 `SHERPA_ONNX_LIB_DIR`（`node scripts/fetch-sherpa-android.mjs` 会打印目录），否则 `sherpa-onnx-sys` 的构建脚本报「Unsupported target」。
- iOS 仍是空壳（没有可直接链接的预编译库）。
- **速度（K30 Pro，骁龙 865）**：推理线程不加限制时会落到小核上，合成速度只有播放速度的 0.45 倍；限制在 4 个大核后约 0.83 倍（`pin_to_big_cores`）。这两个数是用同一套库在手机上单独测的；装好的应用里听《理想国》约三分钟，推理线程确实只在大核上，每 3 秒看一次界面，30 次里有 4 次在「正在准备语音」。合成仍慢于播放，所以这台 2020 年的旗舰上听书会有停顿，界面会提示「有点卡，换在线语音更流畅」。点「停止」后正在合成的那一句要算完才停，这台手机上最长见到约一分钟。int8 量化的语音包（147 MB）在这台手机上反而更慢（0.43 倍），没有采用。更新的芯片应当能跟上，但没有实机数据。
- 与 llama.cpp 共存：Android 上 sherpa-onnx 是动态库，没有出现 Linux 桌面那种 `std::regex` 冲突；K30 上先用离线语音再用本机对话，未闪退。
- 语音包来源：上游 Release 里的 `kokoro-multi-lang-v1_1.tar.bz2` 在 2026-10-05 之后被重新上传过，大小与摘要都变了，按记录的摘要校验必然不过。下载顺序已改为先镜像（GitCode 上我们自己放的那份，与摘要一致）、后 GitHub；GitHub 那份现在等于不可用。**GitCode 连不上的用户目前下不了语音包**，需要另找一处放原来的那份，或者验证新包后换摘要。

## 还没做

- Windows 上装好的应用里的翻译流程（原生层已在 CI 上用真实模型验证）；Windows 的显卡构建（Vulkan）；Android 上长时间翻译的发热，以及 K30 以外的手机（内存更小、联发科芯片）。
- 界面与原生层在同一个应用里的完整流程：2026-11-12 在 MacAir 的真实应用里经 IPC 验证了下载（含退出后续传与校验）、流式翻译、语音合成和带着模型退出；界面一侧（翻译面板、听书面板）用的仍是原生层替身，没有人在装好的应用里点着用过，也没有用本机语音读完一章。
- 本机语音的音质、自然度、长时间朗读的稳定性；正在合成时停止朗读的取消路径只有单元测试。
- 手机上的本机语音（等可用的 0.6B 转换）；Android 显卡（OpenCL 只在较新的高通芯片上稳定，联发科没有可用路径）。
- Linux 上的隔离方案。
- MacAir 上 `http_upload` 的一个测试失败（系统代理把连不上的地址变成 502），与这部分改动无关，t9 上通过。
