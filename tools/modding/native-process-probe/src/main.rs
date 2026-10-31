use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;
use std::io::{self, Read, Write};

const MAX_REQUEST_BYTES: u64 = 1024;
const MAX_REPLY_BYTES: usize = 1024 * 1024;
const MAX_PROCESSES: usize = 65536;
const MAX_NAME_UNITS: usize = 260;

#[derive(Debug)]
struct Request {
    request_id: String,
}

impl<'de> Deserialize<'de> for Request {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct RequestVisitor;
        impl<'de> Visitor<'de> for RequestVisitor {
            type Value = Request;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a closed native process request")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Request, M::Error> {
                let mut version = None;
                let mut request_id = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "version" => {
                            if version.is_some() {
                                return Err(de::Error::duplicate_field("version"));
                            }
                            version = Some(map.next_value::<f64>()?);
                        }
                        "requestId" => {
                            if request_id.is_some() {
                                return Err(de::Error::duplicate_field("requestId"));
                            }
                            request_id = Some(map.next_value::<String>()?);
                        }
                        _ => return Err(de::Error::unknown_field(&key, &["version", "requestId"])),
                    }
                }
                if version != Some(1.0) {
                    return Err(de::Error::custom("unsupported version"));
                }
                let request_id = request_id.ok_or_else(|| de::Error::missing_field("requestId"))?;
                if request_id.len() != 32
                    || !request_id
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                {
                    return Err(de::Error::custom("invalid request ID"));
                }
                Ok(Request { request_id })
            }
        }
        deserializer.deserialize_map(RequestVisitor)
    }
}

fn parse_request(bytes: &[u8]) -> Result<Request, &'static str> {
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err("NATIVE_PROCESS_PROBE_REQUEST_LIMIT");
    }
    serde_json::from_slice(bytes).map_err(|_| "NATIVE_PROCESS_PROBE_INVALID_REQUEST")
}

fn process_name(units: &[u16]) -> Result<String, &'static str> {
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .ok_or("NATIVE_PROCESS_PROBE_INVALID_NAME")?;
    if end == 0 || end > MAX_NAME_UNITS {
        return Err("NATIVE_PROCESS_PROBE_INVALID_NAME");
    }
    let name =
        String::from_utf16(&units[..end]).map_err(|_| "NATIVE_PROCESS_PROBE_INVALID_NAME")?;
    if name
        .chars()
        .any(|c| c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c) || c == '/' || c == '\\')
    {
        return Err("NATIVE_PROCESS_PROBE_INVALID_NAME");
    }
    // Toolhelp already returns the executable basename, including its extension.
    Ok(name)
}

fn collect_names(
    mut next: impl FnMut() -> Result<Option<Vec<u16>>, &'static str>,
) -> Result<Vec<String>, &'static str> {
    let mut names = Vec::new();
    let mut encoded_bytes = 0usize;
    while let Some(row) = next()? {
        if names.len() >= MAX_PROCESSES {
            return Err("NATIVE_PROCESS_PROBE_PROCESS_LIMIT");
        }
        let name = process_name(&row)?;
        let encoded_name =
            serde_json::to_string(&name).map_err(|_| "NATIVE_PROCESS_PROBE_OUTPUT_FAILED")?;
        encoded_bytes = encoded_bytes
            .checked_add(encoded_name.len() + 1)
            .ok_or("NATIVE_PROCESS_PROBE_REPLY_LIMIT")?;
        // Reserve bounded space for the fixed envelope before collecting more
        // names. Do not accumulate an oversized census and truncate it later.
        if encoded_bytes > MAX_REPLY_BYTES - 512 {
            return Err("NATIVE_PROCESS_PROBE_REPLY_LIMIT");
        }
        names.push(name);
    }
    if names.is_empty() {
        return Err("NATIVE_PROCESS_PROBE_EMPTY_SNAPSHOT");
    }
    Ok(names)
}

#[cfg(windows)]
fn snapshot() -> Result<Vec<String>, &'static str> {
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: no inherited handle, process enumeration only. The owned handle
    // closes on every return; the structure is initialized to the API's size.
    unsafe {
        let raw = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if raw == INVALID_HANDLE_VALUE || raw.is_null() {
            return Err("NATIVE_PROCESS_PROBE_SNAPSHOT_FAILED");
        }
        let _owned = OwnedHandle::from_raw_handle(raw);
        let mut row: PROCESSENTRY32W = std::mem::zeroed();
        row.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut first = true;
        collect_names(|| {
            let found = if first {
                first = false;
                Process32FirstW(raw, &mut row)
            } else {
                Process32NextW(raw, &mut row)
            };
            if found == 0 {
                // Read before allocation, formatting or handle destruction.
                let code = GetLastError();
                return if code == ERROR_NO_MORE_FILES {
                    Ok(None)
                } else {
                    Err("NATIVE_PROCESS_PROBE_ENUMERATION_FAILED")
                };
            }
            Ok(Some(row.szExeFile.to_vec()))
        })
    }
}

#[cfg(not(windows))]
fn snapshot() -> Result<Vec<String>, &'static str> {
    Err("NATIVE_PROCESS_PROBE_WINDOWS_REQUIRED")
}

fn reply(request: Request, names: Vec<String>) -> Result<Vec<u8>, &'static str> {
    let value = serde_json::json!({
        "schema": "native-process-snapshot/1", "requestId": request.request_id,
        "backend": "toolhelp32w", "nameKind": "executable-basename", "complete": true,
        "count": names.len(), "names": names, "effectsAllowed": false,
    });
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "NATIVE_PROCESS_PROBE_OUTPUT_FAILED")?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REPLY_BYTES {
        return Err("NATIVE_PROCESS_PROBE_REPLY_LIMIT");
    }
    Ok(bytes)
}

fn run() -> Result<(), &'static str> {
    if std::env::args_os().len() != 1 {
        return Err("NATIVE_PROCESS_PROBE_ARGUMENTS_REFUSED");
    }
    let mut input = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|_| "NATIVE_PROCESS_PROBE_INPUT_FAILED")?;
    let request = parse_request(&input)?;
    let bytes = reply(request, snapshot()?)?;
    let mut output = io::stdout().lock();
    output
        .write_all(&bytes)
        .and_then(|_| output.flush())
        .map_err(|_| "NATIVE_PROCESS_PROBE_OUTPUT_FAILED")
}

fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("NATIVE_PROCESS_PROBE_PANIC")));
    if let Err(code) = run() {
        eprintln!("{code}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Vec<u8> {
        br#"{"version":1,"requestId":"0123456789abcdef0123456789abcdef"}"#.to_vec()
    }
    fn name(value: &str) -> Vec<u16> {
        value.encode_utf16().chain([0]).collect()
    }

    #[test]
    fn request_is_closed_and_duplicate_keys_are_rejected() {
        assert!(parse_request(&request()).is_ok());
        for value in [
            r#"{"version":1,"version":1,"requestId":"0123456789abcdef0123456789abcdef"}"#,
            r#"{"version":1,"requestId":"0123456789abcdef0123456789abcdef","path":"x"}"#,
            r#"{"version":1,"requestId":"UPPERCASE"}"#,
            "[]",
            "null",
            "{}",
        ] {
            assert!(parse_request(value.as_bytes()).is_err());
        }
        assert!(parse_request(&[255]).is_err());
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend(request());
        assert!(parse_request(&bom).is_err());
        assert!(parse_request(&vec![b' '; MAX_REQUEST_BYTES as usize + 1]).is_err());
        let mut trailing = request();
        trailing.extend(b" {}");
        assert!(parse_request(&trailing).is_err());
    }

    #[test]
    fn numeric_versions_and_exact_request_budget_match_the_wire_contract() {
        for value in ["1", "1.0", "1e0"] {
            let text = String::from_utf8(request())
                .unwrap()
                .replace("\"version\":1", &format!("\"version\":{value}"));
            assert!(parse_request(text.as_bytes()).is_ok());
        }
        for value in ["true", "\"1\"", "0", "2"] {
            let text = String::from_utf8(request())
                .unwrap()
                .replace("\"version\":1", &format!("\"version\":{value}"));
            assert!(parse_request(text.as_bytes()).is_err());
        }
        let mut boundary = request();
        boundary.resize(MAX_REQUEST_BYTES as usize, b' ');
        assert!(parse_request(&boundary).is_ok());
        boundary.push(b' ');
        assert!(parse_request(&boundary).is_err());
        let duplicate = br#"{"version":1,"requestId":"0123456789abcdef0123456789abcdef","request\u0049d":"0123456789abcdef0123456789abcdef"}"#;
        assert!(parse_request(duplicate).is_err());
    }

    #[test]
    fn names_preserve_extensions_duplicates_unicode_and_reject_loss() {
        for value in ["Cyberpunk2077.exe", "a.exe.exe", "own.тест.exe", "System"] {
            assert_eq!(process_name(&name(value)).unwrap(), value);
        }
        for row in [
            vec![0],
            vec![b'a' as u16],
            vec![0xd800, 0],
            name("a/b"),
            name("a\\b"),
            name("a\n"),
            name("a\u{85}"),
        ] {
            assert!(process_name(&row).is_err());
        }
    }

    #[test]
    fn partial_enumeration_and_empty_snapshot_never_succeed() {
        let mut rows = vec![Ok(Some(name("a.exe"))), Err("FAILURE")].into_iter();
        assert_eq!(
            collect_names(|| rows.next().unwrap_or(Ok(None))),
            Err("FAILURE")
        );
        assert!(collect_names(|| Ok(None)).is_err());
        let mut rows = vec![name("a.exe"), name("a.exe")].into_iter();
        assert_eq!(collect_names(|| Ok(rows.next())).unwrap().len(), 2);
    }

    #[test]
    fn output_limit_and_process_limit_refuse_without_truncation() {
        assert!(
            reply(
                parse_request(&request()).unwrap(),
                vec!["a".repeat(MAX_REPLY_BYTES)]
            )
            .is_err()
        );
        assert!(collect_names(|| Ok(Some(name("a.exe")))).is_err());
    }

    #[test]
    fn collector_counts_encoded_output_and_stops_before_accumulating_an_oversized_list() {
        let row = name(&"\"".repeat(259));
        let mut reads = 0usize;
        let result = collect_names(|| {
            reads += 1;
            Ok(Some(row.clone()))
        });
        assert_eq!(result.unwrap_err(), "NATIVE_PROCESS_PROBE_REPLY_LIMIT");
        assert!(reads < MAX_PROCESSES);
    }
}
