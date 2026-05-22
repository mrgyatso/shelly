mod artifact;
mod macos_panel;
mod windows;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // single-instance first so a forwarded `companion open …` exits fast.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // This callback fires on the plugin's socket-listener thread, but
            // creating a window (WebviewWindowBuilder::build / NSPanel reclass)
            // MUST happen on the main thread or AppKit aborts and kills the
            // primary process. Hop to the main thread first.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(path) = artifact::parse_open_args(&args, Some(&cwd)) {
                    windows::open_artifact_window(&handle, path);
                } else {
                    windows::raise_all(&handle);
                }
            });
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            artifact::read_artifact,
            artifact::artifact_in_scope
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
                windows::open_artifact_window(app.handle(), path);
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
                let toggle = Shortcut::new(Some(Modifiers::SUPER), Code::Digit0);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state == ShortcutState::Pressed
                                && shortcut.matches(Modifiers::SUPER, Code::Digit0)
                            {
                                windows::toggle_all(app);
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(toggle)?;
            }
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
            match event {
                // Stay alive as a background daemon: closing the last panel must
                // not quit, so a later `companion open` still forwards here.
                tauri::RunEvent::ExitRequested { api, .. } => api.prevent_exit(),
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
            }
        });
}
