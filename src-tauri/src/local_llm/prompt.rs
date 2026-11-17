//! 拼提示词 (纯函数): 哪些模型不能交给 llama.cpp 内置的对话模板。
//!
//! 我们绑定的 llama.cpp 用「内置模板」(`llama_chat_apply_template`, 按模板里的特征认模型) 而不是 Jinja。
//! 它认出的 hunyuan-dense 格式与混元翻译 Hy-MT2 文件里的 Jinja 模板不一致: 角色标记放在了内容后面
//! (`内容<｜hy_User｜>`), 结尾也没有 `<｜hy_Assistant｜>`。Q4_K_M 对此不敏感, 照样译完就停;
//! 1.25bit 版却会漏译, 译完也不停, 一直生成到上限 (2026-11-17 K30 实测, 换成 Jinja 模板即正常)。
//! 所以混元模板由这里按 Jinja 原文拼出, 其余模型仍交给内置模板。

const HY_BOS: &str = "<｜hy_begin▁of▁sentence｜>";
const HY_USER: &str = "<｜hy_User｜>";
const HY_ASSISTANT: &str = "<｜hy_Assistant｜>";
/// 系统提示之后
const HY_AFTER_SYSTEM: &str = "<｜hy_place▁holder▁no▁3｜>";
/// 助手回复之后
const HY_AFTER_ASSISTANT: &str = "<｜hy_place▁holder▁no▁2｜>";

/// 模型自带的模板是混元格式时, 按其 Jinja 模板拼出提示词 (含生成提示); 不是则返回 None, 交给内置模板。
/// `messages` 是 (角色, 内容), 角色只认 system / user / assistant, system 只认第一条。
pub(crate) fn hunyuan_prompt(template: &str, messages: &[(String, String)]) -> Option<String> {
    if !(template.contains(HY_USER) && template.contains(HY_ASSISTANT)) {
        return None;
    }
    let mut out = String::from(HY_BOS);
    let mut rest = messages;
    if let Some(((role, content), tail)) = messages.split_first() {
        if role == "system" {
            out.push_str(content);
            out.push_str(HY_AFTER_SYSTEM);
            rest = tail;
        }
    }
    for (role, content) in rest {
        match role.as_str() {
            "user" => {
                out.push_str(HY_USER);
                out.push_str(content);
            }
            "assistant" => {
                out.push_str(HY_ASSISTANT);
                out.push_str(content);
                out.push_str(HY_AFTER_ASSISTANT);
            }
            _ => {}
        }
    }
    out.push_str(HY_ASSISTANT);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hy-MT2-1.8B-GGUF (Q4_K_M) 与 1.25Bit-GGUF 的 tokenizer.chat_template 原文 (两者逐字节相同)
    const HY_TEMPLATE: &str = "{% if messages[0]['role'] == 'system' %}{% set loop_messages = messages[1:] %}{% set system_message = messages[0]['content'] %}<｜hy_begin▁of▁sentence｜>{{ system_message }}<｜hy_place▁holder▁no▁3｜>{% else %}{% set loop_messages = messages %}<｜hy_begin▁of▁sentence｜>{% endif %}{% for message in loop_messages %}{% if message['role'] == 'user' %}<｜hy_User｜>{{ message['content'] }}{% elif message['role'] == 'assistant' %}<｜hy_Assistant｜>{{ message['content'] }}<｜hy_place▁holder▁no▁2｜>{% endif %}{% endfor %}{% if add_generation_prompt %}<｜hy_Assistant｜>{% else %}<｜hy_place▁holder▁no▁8｜>{% endif %}";

    fn msg(role: &str, content: &str) -> (String, String) {
        (role.into(), content.into())
    }

    #[test]
    fn single_translation_request_matches_the_jinja_template() {
        // 与 llama-completion --jinja 在 K30 上打印的格式一致
        assert_eq!(
            hunyuan_prompt(HY_TEMPLATE, &[msg("user", "将以下文本翻译为英语：\n\n你好")]).unwrap(),
            "<｜hy_begin▁of▁sentence｜><｜hy_User｜>将以下文本翻译为英语：\n\n你好<｜hy_Assistant｜>"
        );
    }

    #[test]
    fn system_and_history_follow_the_template() {
        let out = hunyuan_prompt(
            HY_TEMPLATE,
            &[msg("system", "S"), msg("user", "Hello"), msg("assistant", "Hi there"), msg("user", "How are you?")],
        )
        .unwrap();
        assert_eq!(
            out,
            "<｜hy_begin▁of▁sentence｜>S<｜hy_place▁holder▁no▁3｜><｜hy_User｜>Hello<｜hy_Assistant｜>Hi there<｜hy_place▁holder▁no▁2｜><｜hy_User｜>How are you?<｜hy_Assistant｜>"
        );
        // 只有第一条 system 算系统提示, 后面的忽略
        let late = hunyuan_prompt(HY_TEMPLATE, &[msg("user", "a"), msg("system", "x")]).unwrap();
        assert_eq!(late, "<｜hy_begin▁of▁sentence｜><｜hy_User｜>a<｜hy_Assistant｜>");
    }

    #[test]
    fn other_templates_are_left_to_llama_cpp() {
        let chatml = "{% for message in messages %}<|im_start|>{{ message['role'] }}\n{{ message['content'] }}<|im_end|>\n{% endfor %}";
        assert_eq!(hunyuan_prompt(chatml, &[msg("user", "hi")]), None);
        assert_eq!(hunyuan_prompt("", &[msg("user", "hi")]), None);
    }
}
