//! Aether desktop shell — P6.
//!
//! Thin on purpose: the app is the same TypeScript bundle the PWA ships (the whole point of
//! the stack choice back in ADR-times). What the shell adds is capability, not code:
//!   - tauri-plugin-http: Rust-side fetch, immune to webview CORS — the contract's
//!     `A-native` tier (GFZ official Kp today; aviationweather METARs next) becomes real.
//!   - `report`: appends a line to aether-native-check.jsonl next to the exe's cwd, so the
//!     app can prove its native data paths headlessly (the G0.6 lesson: a detached GUI
//!     process's stdout is a dead end; files are the truth channel).

#[tauri::command]
fn report(payload: String) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("aether-native-check.jsonl")
    {
        let _ = writeln!(f, "{payload}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![report])
        .run(tauri::generate_context!())
        .expect("error while running aether");
}
