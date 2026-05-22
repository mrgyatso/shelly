use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Extract the first artifact path from a forwarded argv vector.
///
/// Handles three invocation shapes:
/// - `companion open <path>`
/// - a bare `*.html` / `*.htm` arg (Finder / `open <file>`)
/// - a `companion://open?path=<urlencoded>` deep link
///
/// Relative paths resolve against `cwd` (the invoking shell's directory, which
/// the single-instance plugin forwards), falling back to the process cwd.
pub fn parse_open_args(args: &[String], cwd: Option<&str>) -> Option<String> {
    let mut iter = args.iter().skip(1); // skip argv[0] (the binary itself)
    while let Some(arg) = iter.next() {
        if arg == "open" {
            if let Some(p) = iter.next() {
                return normalize(p, cwd);
            }
        } else if let Some(rest) = arg.strip_prefix("companion://") {
            if let Some(idx) = rest.find("path=") {
                let decoded = percent_decode(&rest[idx + "path=".len()..]);
                return normalize(&decoded, cwd);
            }
        } else if arg.ends_with(".html") || arg.ends_with(".htm") {
            return normalize(arg, cwd);
        }
    }
    None
}

fn normalize(p: &str, cwd: Option<&str>) -> Option<String> {
    let path = Path::new(p);
    let abs: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else if let Some(base) = cwd {
        Path::new(base).join(path)
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    // canonicalize also verifies the file exists, which is what we want before
    // trying to render it.
    abs.canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Out-of-(asset)-scope fallback: read raw HTML so the shell can use `iframe.srcdoc`.
#[tauri::command]
pub fn read_artifact(path: String) -> Result<String, String> {
    match std::fs::read_to_string(&path) {
        Ok(html) => {
            eprintln!(
                "[overlay] read_artifact OK: {} ({} bytes)",
                path,
                html.len()
            );
            Ok(html)
        }
        Err(e) => {
            eprintln!("[overlay] read_artifact ERR: {} ({})", path, e);
            Err(e.to_string())
        }
    }
}

/// Whether `path` is inside the configured asset-protocol scope. When true the
/// frontend renders via `asset:` (convertFileSrc), so the artifact's inline
/// scripts run; when false it must use the `read_artifact`/`srcdoc` fallback.
#[tauri::command]
pub fn artifact_in_scope(app: AppHandle, path: String) -> bool {
    app.asset_protocol_scope().is_allowed(&path)
}

#[cfg(test)]
mod tests {
    use super::parse_open_args;

    #[test]
    fn parses_open_subcommand_with_abs_path() {
        let args = vec!["bin".into(), "open".into(), "/tmp".into()];
        // /tmp exists and canonicalizes; assert it resolves to something.
        assert!(parse_open_args(&args, None).is_some());
    }

    #[test]
    fn ignores_unrelated_args() {
        let args = vec!["bin".into(), "--version".into()];
        assert_eq!(parse_open_args(&args, None), None);
    }
}
