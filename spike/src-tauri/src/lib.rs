//! G0.6 — Tauri shell around the existing particle spike.
//!
//! The point of this crate is NOT the desktop app. It is one question: does the WebGL2
//! particle engine that hits 60 fps at 2M particles in Chrome behave the same inside the
//! webview Tauri actually ships with? On Windows that webview is WebView2 (Chromium), so the
//! expected answer is "yes" — but the proposal treats desktop as pure packaging, and an
//! assumption that cheap to test should not be carried through five build phases untested.
//!
//! The only custom command is `report`, which exists so benchmark results escape the native
//! window to a file where they can actually be read. A native window is otherwise a dead end
//! for automated measurement.
//!
//! ## Why the window in `tauri.conf.json` is pinned to 987x910 and non-resizable
//!
//! `tauri.conf.json` is strict JSON and rejects unknown keys, so this note lives here.
//!
//! 987x910 is the exact canvas size every Chrome measurement in `../README.md` was taken at.
//! A Tauri window has no browser chrome, so at dpr 1 window size == canvas size. The first
//! run of this gate opened maximised at 1920x1009 and appeared to show WebView2 running at
//! roughly half Chrome's frame rate — which was entirely 2.16x the pixel count on a
//! fill-rate-bound renderer, not a webview difference. Pinned so the comparison cannot drift,
//! and the harness now stamps canvas size on every row so it could not go unnoticed again.

/// Where benchmark rows land. Next to the crate, so it is trivially findable.
const RESULTS_FILE: &str = "bench-results.jsonl";

/// Append a benchmark payload to a file, and echo it to stdout.
///
/// The file is the load-bearing half. `println!` alone was tried first and lost every line:
/// `tauri dev` launches the app as a detached GUI process, so its stdout does not reliably
/// reach whatever shell started the build. A GUI process is a dead end for stdout capture —
/// write to disk and read the disk.
#[tauri::command]
fn report(payload: String) {
    println!("__BENCH__ {payload}");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(RESULTS_FILE)
    {
        let _ = writeln!(f, "{payload}");
    }
}

/// Truncate the results file so a fresh run cannot be read as a continuation of an old one.
#[tauri::command]
fn report_reset() {
    let _ = std::fs::write(RESULTS_FILE, b"");
}

/// Report which webview is actually rendering — the whole reason this gate exists.
#[tauri::command]
fn webview_info() -> serde_json::Value {
    serde_json::json!({
        "tauri": tauri::VERSION,
        "webview": tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![report, report_reset, webview_info])
        .run(tauri::generate_context!())
        .expect("error while running aether spike");
}
