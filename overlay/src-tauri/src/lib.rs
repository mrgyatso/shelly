mod artifact;
mod layout;
mod macos_panel;
mod windows;

use std::panic::{catch_unwind, AssertUnwindSafe};

use tauri::Manager;

/// Run `f`, containing any panic so it cannot unwind across the Objective-C /
/// CoreFoundation run-loop boundary — which aborts the whole daemon and drops
/// every panel (the repeated SIGABRT crashes). The panic's location + message
/// are already recorded by the hook installed in `run()`; here we just swallow
/// it so one bad artifact can never take the process down.
fn guard(f: impl FnOnce()) {
    let _ = catch_unwind(AssertUnwindSafe(f));
}

/// Append a panic record to a logfile, so the root cause survives even though the
/// hook that launches the daemon throws away its stderr.
fn log_panic(location: &str, msg: &str) {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{ts}] panic at {location}: {msg}\n");
    eprintln!("[overlay] {}", line.trim_end());
    if let Some(home) = std::env::var_os("HOME") {
        let path = std::path::Path::new(&home).join("Library/Logs/companion-overlay.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture every panic's file:line + message before it unwinds; combined with
    // `guard()` at the run-loop boundaries this turns the fatal cross-FFI SIGABRT
    // into a logged, non-fatal event.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".to_string());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic>".to_string());
        log_panic(&location, &msg);
    }));

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(layout::LayoutState::default())
        // single-instance first so a forwarded `companion open …` exits fast.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // This callback fires on the plugin's socket-listener thread, but
            // creating a window (WebviewWindowBuilder::build / NSPanel reclass)
            // MUST happen on the main thread or AppKit aborts and kills the
            // primary process. Hop to the main thread first.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                guard(|| {
                    if let Some(path) = artifact::parse_open_args(&args, Some(&cwd)) {
                        windows::open_artifact_window(&handle, path);
                    } else {
                        windows::raise_all(&handle);
                    }
                });
            });
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            artifact::read_artifact,
            artifact::artifact_in_scope,
            layout::notify_fit
        ])
        .setup(|app| {
            // Prohibited activation policy = pure background daemon: no Dock
            // icon, no Cmd-Tab, and crucially the app can never become active.
            // This is what actually stops the panels stealing terminal focus on
            // click / auto-pop (a non-activating NSPanel is necessary but NOT
            // sufficient while the app stays a Regular, focus-grabbing app), and
            // it lets the process persist with zero windows between opens.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Prohibited);

            // First-launch: this very process may carry `open <path>`.
            // (single-instance only fires for *subsequent* invocations.)
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().into_owned());
            if let Some(path) = artifact::parse_open_args(&args, cwd.as_deref()) {
                let handle = app.handle().clone();
                guard(move || windows::open_artifact_window(&handle, path));
            }
            // Runtime deep-link registration (needed in dev / on Linux).
            #[cfg(any(target_os = "linux", debug_assertions))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // Global show/hide toggle (⌘0). Registered from Rust, so it needs no
            // capability permission — capabilities only gate frontend IPC. This is
            // the guaranteed escape hatch once the window goes frameless (Q2) and
            // transparent (Q3): even if the chrome mis-paints, ⌘0 always recovers it.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };
                // ⌘0 = show/hide all panels. ⌘9 = toggle Free ↔ Terminal (dock the
                // column to the focused terminal window and follow it).
                let toggle = Shortcut::new(Some(Modifiers::SUPER), Code::Digit0);
                let follow = Shortcut::new(Some(Modifiers::SUPER), Code::Digit9);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            if shortcut.matches(Modifiers::SUPER, Code::Digit0) {
                                windows::toggle_all(app);
                            } else if shortcut.matches(Modifiers::SUPER, Code::Digit9) {
                                crate::layout::toggle_mode(app);
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(toggle)?;
                app.global_shortcut().register(follow)?;
            }

            // Keep the column docked to the terminal while in Terminal mode.
            #[cfg(target_os = "macos")]
            crate::layout::start_follow_poll(app.handle().clone());

            Ok(())
        });

    // Debug-only MCP bridge for headless verification. Pinned to a unique
    // localhost port (9339) so it never collides with TUICommander's 9223 range;
    // inspect this app via driver_session(port:9339) → read_logs / webview_execute_js.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .base_port(9339)
                .build(),
        );
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = &app_handle;
            // Guard the whole dispatch: this runs inside a CFRunLoop observer, so a
            // panic that unwound out of here would abort the daemon (see `guard`).
            guard(move || match event {
                // Stay alive as a background daemon: closing the last panel must
                // not quit, so a later `companion open` still forwards here.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    eprintln!("[overlay] ExitRequested (prevented; daemon stays alive)");
                    api.prevent_exit();
                }
                // A panel is about to close (✕ → JS `close()`): restore its
                // original window class BEFORE tao tears it down, so the reclassed
                // NSPanel isn't disposed via the wrong AppKit path (which raises a
                // foreign NSException and aborts the daemon). Do NOT prevent the
                // close — let the teardown proceed on the restored class.
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } => {
                    if let Some(win) = app_handle.get_webview_window(&label) {
                        crate::macos_panel::restore_original_class(&win);
                    }
                }
                // A panel moved. If it's a genuine user drag (the panel is visible
                // and we aren't mid-move ourselves), pin it so future re-flows leave
                // it where the user put it.
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Moved(_),
                    ..
                } => {
                    if let Some(win) = app_handle.get_webview_window(&label) {
                        if win.is_visible().unwrap_or(false)
                            && !crate::layout::is_moving(app_handle, &label)
                        {
                            crate::layout::pin(app_handle, &label);
                        }
                    }
                }
                // A panel closed (✕): re-flow the remaining ones so no gap is left.
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } => {
                    eprintln!(
                        "[overlay] window '{label}' destroyed; {} remain",
                        app_handle.webview_windows().len()
                    );
                    // Re-flow the survivors on the next main-thread tick (deferred to
                    // avoid re-entrant window ops during the destroy dispatch).
                    let handle = app_handle.clone();
                    let _ = app_handle.run_on_main_thread(move || {
                        crate::layout::arrange(&handle, true);
                    });
                }
                // macOS Finder / `open file.html` / `companion://` URL handler.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    for u in &urls {
                        let path = if u.scheme() == "file" {
                            u.to_file_path()
                                .ok()
                                .map(|p| p.to_string_lossy().into_owned())
                        } else {
                            artifact::parse_open_args(&["x".to_string(), u.to_string()], None)
                        };
                        if let Some(p) = path {
                            windows::open_artifact_window(app_handle, p);
                        }
                    }
                }
                _ => {}
            });
        });
}
