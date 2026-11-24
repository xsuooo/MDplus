// Hands a validated http(s) address to the system default browser.
// Nothing else reaches the shell: no file paths, no other schemes, no arguments.

/// Longest address Windows shell URL handlers reliably accept.
const MAX_URL_CHARS: usize = 2048;

fn validate(url: &str) -> Result<(), String> {
    if url.len() > MAX_URL_CHARS {
        return Err("link address is too long".into());
    }
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or("only http and https links can be opened")?;
    // The address goes to the shell as one argument, never through a command interpreter;
    // a serialized URL has no raw whitespace, control characters or quotes.
    if url
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '"')
    {
        return Err("link address contains unsupported characters".into());
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.starts_with(':') || host.ends_with('@') {
        return Err("link address has no host".into());
    }
    Ok(())
}

#[cfg(windows)]
fn launch(url: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() };
    let operation = wide("open");
    let target = wide(url);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecuteW reports success with a value greater than 32.
    if result as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "the system could not open the link (code {})",
            result as isize
        ))
    }
}

#[cfg(not(windows))]
fn launch(_url: &str) -> Result<(), String> {
    Err("opening links is only supported on Windows".into())
}

#[tauri::command]
pub fn open_external_link(url: String) -> Result<(), String> {
    validate(&url)?;
    launch(&url)
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn accepts_serialized_http_and_https_addresses() {
        for url in [
            "https://example.com/",
            "http://example.com/a%20b?q=1&r=%E4%B8%AD#frag",
            "HTTPS://Example.com:8443/path",
            "https://user@example.com/",
            "https://[::1]:8080/",
            "https://example.com/w/api.php?titles=A|B&q=x^y",
        ] {
            assert!(validate(url).is_ok(), "rejected {url}");
        }
    }

    #[test]
    fn rejects_everything_that_is_not_a_plain_web_address() {
        for url in [
            "",
            "example.com",
            "file:///C:/Windows/System32/calc.exe",
            "C:\\Windows\\System32\\calc.exe",
            "ms-settings:privacy",
            "javascript:alert(1)",
            "mailto:someone@example.com",
            "https://",
            "https:///path",
            "https://:80/",
            "https://example.com/a b",
            "https://example.com/\" & calc",
            "https://example.com/\u{0}",
            " https://example.com/",
        ] {
            assert!(validate(url).is_err(), "accepted {url:?}");
        }
        assert!(validate(&format!("https://example.com/{}", "a".repeat(2048))).is_err());
    }
}
