#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(
          "window.__BIZDASH_AUTH_SCHEME__ = 'bizdash'; window.__BIZDASH_NATIVE__ = 'tauri';",
        );
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Focused(true) = event {
        let _ = window.emit("bizdash-window-focused", serde_json::json!({}));
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

