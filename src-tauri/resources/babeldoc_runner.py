# LightRead BabelDOC runner: 用 BabelDOC Python API 执行翻译,
# 以 JSON 行输出结构化进度 (CLI 的 rich 进度在管道下静音, 无法解析)。
# 用法: python babeldoc_runner.py <config.json>
import asyncio
import json
import sys


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def main():
    with open(sys.argv[1], encoding="utf-8") as f:
        cfg = json.load(f)

    import babeldoc.format.pdf.high_level as high_level
    from babeldoc.docvision.doclayout import DocLayoutModel
    from babeldoc.format.pdf.translation_config import TranslationConfig
    from babeldoc.format.pdf.translation_config import WatermarkOutputMode
    from babeldoc.translator.translator import OpenAITranslator

    emit({"event": "stage", "stage": "init", "percent": None})
    high_level.init()
    translator = OpenAITranslator(
        lang_in=cfg.get("lang_in", "en"),
        lang_out=cfg.get("lang_out", "zh"),
        model=cfg["model"],
        base_url=cfg["base_url"],
        api_key=cfg["api_key"],
        ignore_cache=bool(cfg.get("ignore_cache", False)),
    )
    config = TranslationConfig(
        input_file=cfg["input"],
        translator=translator,
        lang_in=cfg.get("lang_in", "en"),
        lang_out=cfg.get("lang_out", "zh"),
        doc_layout_model=DocLayoutModel.load_onnx(),
        output_dir=cfg["output"],
        pages=cfg.get("pages") or None,
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
        qps=int(cfg.get("qps", 4)),
        report_interval=0.5,
    )

    async def run():
        async for ev in high_level.async_translate(config):
            kind = ev.get("type")
            if kind in ("progress_start", "progress_update", "progress_end"):
                emit({
                    "event": "stage",
                    "stage": ev.get("stage") or "",
                    "percent": ev.get("overall_progress"),
                    "current": ev.get("stage_current"),
                    "total": ev.get("stage_total"),
                })
            elif kind == "finish":
                result = ev["translate_result"]
                outputs = []
                for attr in ("mono_pdf_path", "dual_pdf_path"):
                    p = getattr(result, attr, None)
                    if p:
                        outputs.append(str(p))
                emit({"event": "done", "outputs": outputs})
                return
            elif kind == "error":
                emit({"event": "error", "message": str(ev.get("error", "unknown"))})
                sys.exit(2)

    asyncio.run(run())


if __name__ == "__main__":
    main()
