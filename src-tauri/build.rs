fn main() {
  // 本机模型引擎 (src/local_llm) 进哪些包: 开了 local-llm 特性, 且目标是 macOS / Windows / Android。
  // Linux 桌面与 iOS 不带的原因见 src/local_llm/mod.rs; Cargo.toml 里 llama-cpp-2 的依赖表与这里保持一致。
  println!("cargo:rustc-check-cfg=cfg(llm_engine)");
  let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
  if std::env::var_os("CARGO_FEATURE_LOCAL_LLM").is_some() && matches!(target_os.as_str(), "macos" | "windows" | "android") {
    println!("cargo:rustc-cfg=llm_engine");
  }
  tauri_build::build()
}
