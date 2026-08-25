// Copse on Tauri + Servo — prototype shell.
//
// This process owns the OS windows (rendered by Servo via tauri-runtime-servo)
// and nothing else. All application logic runs in the Node sidecar — the
// existing Electron main process bundled with an `electron` shim
// (dist/sidecar/index.js, see scripts/build-tauri.mts). The sidecar asks for
// windows over a stdio line protocol; the renderer talks to the sidecar
// directly over a loopback WebSocket. See docs/plans/tauri-servo-migration.md.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::utils::config::Color;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

type ServoRuntime = tauri_runtime_servo::Servo<tauri::EventLoopMessage>;

/// Prefix marking protocol lines on the sidecar's stdout; everything else is
/// passed through as sidecar logging.
const PREFIX: &str = "@copse-tauri ";

#[derive(Deserialize)]
#[serde(tag = "op")]
enum SidecarMessage {
    #[serde(rename = "create-window", rename_all = "camelCase")]
    CreateWindow {
        win_id: u64,
        url: String,
        width: Option<f64>,
        height: Option<f64>,
        min_width: Option<f64>,
        min_height: Option<f64>,
        title: Option<String>,
        show: Option<bool>,
        background_color: Option<String>,
    },
    #[serde(rename = "window", rename_all = "camelCase")]
    Window { win_id: u64, action: String },
}

type SharedStdin = Arc<Mutex<std::process::ChildStdin>>;

/// `#rrggbb` / `#rgb` as the sidecar sends it, to a Tauri colour. Returns None
/// for anything unparseable so a malformed value simply leaves the default.
fn parse_hex_color(value: &str) -> Option<Color> {
    let hex = value.strip_prefix('#')?;
    let (r, g, b) = match hex.len() {
        3 => {
            let digit = |i: usize| u8::from_str_radix(&hex[i..i + 1].repeat(2), 16).ok();
            (digit(0)?, digit(1)?, digit(2)?)
        }
        6 => {
            let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
            (byte(0)?, byte(2)?, byte(4)?)
        }
        _ => return None,
    };
    Some(Color(r, g, b, 255))
}

fn window_label(win_id: u64) -> String {
    format!("copse-{win_id}")
}

fn send_window_event(stdin: &SharedStdin, win_id: u64, event: &str) {
    if let Ok(mut guard) = stdin.lock() {
        let line =
            format!("{{\"op\":\"window-event\",\"winId\":{win_id},\"event\":\"{event}\"}}\n");
        let _ = guard.write_all(line.as_bytes());
        let _ = guard.flush();
    }
}

fn create_window(
    handle: &AppHandle<ServoRuntime>,
    stdin: &SharedStdin,
    win_id: u64,
    url: String,
    width: Option<f64>,
    height: Option<f64>,
    min_width: Option<f64>,
    min_height: Option<f64>,
    title: Option<String>,
    show: Option<bool>,
    background_color: Option<String>,
) {
    let mut builder =
        WebviewWindowBuilder::new(handle, window_label(win_id), WebviewUrl::App(url.into()))
            .title(title.unwrap_or_else(|| "Copse".to_string()))
            .inner_size(width.unwrap_or(1200.0), height.unwrap_or(800.0))
            // The sidecar mirrors Electron's hidden-then-show pattern, but an
            // unmapped GTK window has no X11 handle yet and Servo needs one to
            // create its surface — so the window is born visible.
            .visible(true);
    let _ = show;
    // Paint the native window in the app's boot theme before the webview has
    // rendered anything.
    //
    // theme-boot.js is NOT sufficient on its own, though a previous comment
    // here claimed it was. It covers the gap between first paint and app.js,
    // but not the gap before the webview's first paint at all — and in that
    // window the native surface shows its own default, which is white. Electron
    // never flashes because `backgroundColor` is set on the BrowserWindow; the
    // sidecar has always sent that value in `create-window` and this shell used
    // to drop it on the floor, since the field was not even in the struct for
    // serde to see.
    if let Some(color) = background_color.as_deref().and_then(parse_hex_color) {
        builder = builder.background_color(color);
    }
    if let (Some(w), Some(h)) = (min_width, min_height) {
        builder = builder.min_inner_size(w, h);
    }
    match builder.build() {
        Ok(window) => {
            let stdin = stdin.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { .. } => {
                    send_window_event(&stdin, win_id, "close-requested");
                }
                WindowEvent::Destroyed => {
                    send_window_event(&stdin, win_id, "closed");
                }
                WindowEvent::Focused(focused) => {
                    send_window_event(&stdin, win_id, if *focused { "focus" } else { "blur" });
                }
                _ => {}
            });
        }
        Err(error) => eprintln!("[shell] failed to create window {win_id}: {error}"),
    }
}

fn handle_sidecar_message(
    handle: &AppHandle<ServoRuntime>,
    stdin: &SharedStdin,
    message: SidecarMessage,
) {
    match message {
        SidecarMessage::CreateWindow {
            win_id,
            url,
            width,
            height,
            min_width,
            min_height,
            title,
            show,
            background_color,
        } => {
            let handle = handle.clone();
            let stdin = stdin.clone();
            // Window creation must happen on the main thread on macOS/Windows.
            let _ = handle.clone().run_on_main_thread(move || {
                create_window(
                    &handle,
                    &stdin,
                    win_id,
                    url,
                    width,
                    height,
                    min_width,
                    min_height,
                    title,
                    show,
                    background_color,
                );
            });
        }
        SidecarMessage::Window { win_id, action } => {
            let handle = handle.clone();
            let _ = handle.clone().run_on_main_thread(move || {
                let Some(window) = handle.get_webview_window(&window_label(win_id)) else {
                    return;
                };
                let result = match action.as_str() {
                    "show" => window.show(),
                    "hide" => window.hide(),
                    "focus" => window.set_focus(),
                    "close" => window.destroy(),
                    "maximize" => window.maximize(),
                    "minimize" => window.minimize(),
                    other => {
                        eprintln!("[shell] unknown window action '{other}'");
                        Ok(())
                    }
                };
                if let Err(error) = result {
                    eprintln!("[shell] window action '{action}' failed: {error}");
                }
            });
        }
    }
}

/// Locate `dist/sidecar/index.js`.
///
/// `COPSE_SIDECAR_ENTRY` wins when set. Otherwise: the historical default is
/// `../dist/sidecar/index.js`, which is *cwd*-relative and so only resolves
/// when the shell is started from inside `tauri-shell/` — which `cargo run`
/// does and a perf harness invoking the release binary by path does not. The
/// failure is a bare Node MODULE_NOT_FOUND naming a path nobody wrote, so try
/// the exe-relative location too and, when neither exists, say what was tried.
fn sidecar_entry() -> std::io::Result<PathBuf> {
    if let Ok(explicit) = std::env::var("COPSE_SIDECAR_ENTRY") {
        return Ok(PathBuf::from(explicit));
    }
    let mut candidates = vec![PathBuf::from("../dist/sidecar/index.js")];
    // target/release/copse-tauri-shell → up three to the repo root.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()) {
            candidates.push(root.join("../dist/sidecar/index.js"));
        }
    }
    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!(
            "no dist/sidecar/index.js (tried {}) — run `pnpm build && pnpm build:tauri`, \
             or point COPSE_SIDECAR_ENTRY at it",
            candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    ))
}

fn spawn_sidecar(handle: AppHandle<ServoRuntime>, alive: Arc<AtomicBool>) -> std::io::Result<()> {
    let node = std::env::var("COPSE_SIDECAR_NODE").unwrap_or_else(|_| "node".to_string());
    let entry = sidecar_entry()?;
    let mut child = Command::new(node)
        .arg(entry)
        .env("COPSE_TAURI_SHELL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;

    let stdin: SharedStdin = Arc::new(Mutex::new(
        child.stdin.take().expect("sidecar stdin is piped"),
    ));
    let stdout = child.stdout.take().expect("sidecar stdout is piped");

    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Some(payload) = line.strip_prefix(PREFIX) else {
                println!("[sidecar] {line}");
                continue;
            };
            match serde_json::from_str::<SidecarMessage>(payload) {
                Ok(message) => handle_sidecar_message(&handle, &stdin, message),
                Err(error) => eprintln!("[shell] bad sidecar message: {error}: {payload}"),
            }
        }
        // Sidecar stdout closed: the app process is gone; take the shell down.
        eprintln!("[shell] sidecar exited; shutting down");
        alive.store(false, Ordering::SeqCst);
        let _ = child.wait();
        handle.exit(0);
    });

    Ok(())
}

fn main() {
    let sidecar_alive = Arc::new(AtomicBool::new(true));
    let alive_for_setup = sidecar_alive.clone();

    let app = tauri::Builder::<ServoRuntime>::new()
        // Servo cannot read custom protocol request bodies; route Tauri's own
        // internal invokes through the postMessage bridge (the app's IPC does
        // not use Tauri invokes at all — it rides the sidecar WebSocket).
        .invoke_system(tauri_runtime_servo::INVOKE_SYSTEM_SCRIPT)
        .setup(move |app| {
            spawn_sidecar(app.handle().clone(), alive_for_setup)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            // No windows exist until the sidecar asks for one, and windows may
            // all close while the sidecar keeps working; only a dead sidecar
            // ends the shell.
            if sidecar_alive.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
    });
}
