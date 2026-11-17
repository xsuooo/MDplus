//! Text decoding for documents read from disk: UTF-8, BOM-marked UTF-16, GBK fallback.

/// 解码文件字节为文本:
/// 1. 剥离 UTF-8 BOM;
/// 2. 有效 UTF-8 直接使用;
/// 3. 带 BOM 的 UTF-16 LE/BE 按对应编码解码;
/// 4. 其余(常见 GBK/GB2312 编码的中文文件)按 GBK 解码,保留中文内容。
///
/// 写回时统一为 UTF-8(见 safe_files::write_document),GBK 文件保存后转码为 UTF-8,内容不再丢失。
pub(crate) fn decode_text(bytes: &[u8]) -> Result<String, String> {
    if let Some(data) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(data)
            .map(str::to_owned)
            .map_err(|_| "UTF-8 BOM 文件包含无效字节，已拒绝有损解码".into());
    }
    if let Some(data) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return decode_utf16(data, true);
    }
    if let Some(data) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return decode_utf16(data, false);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.to_owned());
    }
    let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors {
        return Err("文件包含无法按 UTF-8 或 GBK 解码的字节，已保留原文件".into());
    }
    Ok(decoded.into_owned())
}

/// BOM 确定编码后不回退；残缺字节和非法代理项必须显式失败。
fn decode_utf16(data: &[u8], little_endian: bool) -> Result<String, String> {
    let (chunks, remainder) = data.as_chunks::<2>();
    if !remainder.is_empty() {
        return Err("UTF-16 文件末尾存在残缺字节，已保留原文件".into());
    }
    let units: Vec<u16> = chunks
        .iter()
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes(*chunk)
            } else {
                u16::from_be_bytes(*chunk)
            }
        })
        .collect();
    String::from_utf16(&units).map_err(|_| "UTF-16 文件包含非法代理项，已保留原文件".into())
}

pub(crate) fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|byte| *byte == 0)
}
