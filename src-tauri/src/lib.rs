mod hostkeys;
mod links;
mod secrets;
mod sessions;
mod ssh;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use sessions::{SavedSession, SessionStore};
use ssh::{ConnEvent, ConnectRequest, PromptAnswer, Sinks, Ssh};

/// Commands return errors to the UI as plain strings.
type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn list_sessions(store: State<'_, SessionStore>) -> CmdResult<Vec<SavedSession>> {
    store.list().map_err(err)
}

#[tauri::command]
fn save_session(store: State<'_, SessionStore>, session: SavedSession) -> CmdResult<()> {
    store.save(session).map_err(err)
}

#[tauri::command]
fn delete_session(store: State<'_, SessionStore>, id: Uuid) -> CmdResult<()> {
    store.delete(id).map_err(err)?;
    secrets::delete_all(id);
    Ok(())
}

#[tauri::command]
fn forget_secrets(id: Uuid) {
    secrets::delete_all(id);
}

#[tauri::command]
fn connect(
    app: AppHandle,
    ssh: State<'_, Arc<Ssh>>,
    request: ConnectRequest,
    events: Channel<ConnEvent>,
    output: Channel<InvokeResponseBody>,
) -> u32 {
    let sinks = Sinks {
        events: Arc::new(move |e| {
            let _ = events.send(e);
        }),
        output: Arc::new(move |data| {
            let _ = output.send(InvokeResponseBody::Raw(data));
        }),
        open_url: Arc::new(move |url| {
            if !links::is_safe_to_open(url) {
                anyhow::bail!("Only https links can be opened");
            }
            app.opener().open_url(url, None::<&str>)?;
            Ok(())
        }),
    };
    ssh.connect(request, sinks)
}

#[tauri::command]
fn send_input(ssh: State<'_, Arc<Ssh>>, id: u32, data: String) {
    ssh.input(id, data.into_bytes());
}

#[tauri::command]
fn resize(ssh: State<'_, Arc<Ssh>>, id: u32, cols: u32, rows: u32) {
    ssh.resize(id, cols, rows);
}

#[tauri::command]
fn disconnect(ssh: State<'_, Arc<Ssh>>, id: u32) {
    ssh.close(id);
}

#[tauri::command]
fn answer_prompt(ssh: State<'_, Arc<Ssh>>, id: u32, answer: PromptAnswer) {
    ssh.answer(id, answer);
}

/// Opens a link from a server banner in the default browser. Only https links
/// are allowed; the UI asks before opening anything that isn't Tailscale.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> CmdResult<()> {
    if !links::is_safe_to_open(&url) {
        return Err("Only https links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

fn config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from(".ghostkey"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let dir = config_dir(app.handle());
            app.manage(SessionStore::new(dir.join("sessions.json")));
            app.manage(Arc::new(Ssh::new(dir.join("known_hosts"))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            save_session,
            delete_session,
            forget_secrets,
            connect,
            send_input,
            resize,
            disconnect,
            answer_prompt,
            open_link,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GhostKey");
}
