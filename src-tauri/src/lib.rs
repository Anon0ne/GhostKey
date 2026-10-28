mod forward;
mod hostkeys;
mod import;
mod links;
mod logging;
mod secrets;
mod sessions;
mod settings;
mod sftp;
mod snippets;
mod ssh;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

use sessions::{SavedSession, SessionStore};
use sftp::{Listing, TransferEvent, Transfers};
use snippets::{Snippet, SnippetStore};
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
fn list_snippets(store: State<'_, SnippetStore>) -> CmdResult<Vec<Snippet>> {
    store.list().map_err(err)
}

#[tauri::command]
fn save_snippet(store: State<'_, SnippetStore>, snippet: Snippet) -> CmdResult<()> {
    store.save(snippet).map_err(err)
}

#[tauri::command]
fn delete_snippet(store: State<'_, SnippetStore>, id: Uuid) -> CmdResult<()> {
    store.delete(id).map_err(err)
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

/// Where settings.json lives, plus the settings themselves.
struct SettingsState {
    path: PathBuf,
    default_log_dir: PathBuf,
    current: Mutex<settings::Settings>,
}

impl SettingsState {
    fn log_dir(&self) -> PathBuf {
        self.current
            .lock()
            .unwrap()
            .log_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.default_log_dir.clone())
    }
}

/// Runs an SFTP operation on a connection. A broken channel is forgotten, so the
/// next call opens a fresh one.
async fn with_sftp<T, F, Fut>(ssh: &Ssh, id: u32, op: F) -> CmdResult<T>
where
    F: FnOnce(Arc<russh_sftp::client::SftpSession>) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let session = ssh.sftp(id).await.map_err(err)?;
    match op(session).await {
        Ok(v) => Ok(v),
        Err(e) => {
            if matches!(
                e.downcast_ref(),
                Some(russh_sftp::client::error::Error::IO(_))
            ) || matches!(
                e.downcast_ref(),
                Some(russh_sftp::client::error::Error::Timeout)
            ) {
                ssh.drop_sftp(id).await;
            }
            Err(format!("{e:#}"))
        }
    }
}

#[tauri::command]
async fn sftp_list(ssh: State<'_, Arc<Ssh>>, id: u32, path: String) -> CmdResult<Listing> {
    with_sftp(&ssh, id, |s| async move { sftp::list(&s, &path).await }).await
}

#[tauri::command]
async fn sftp_mkdir(ssh: State<'_, Arc<Ssh>>, id: u32, path: String) -> CmdResult<()> {
    with_sftp(&ssh, id, |s| async move { Ok(s.create_dir(path).await?) }).await
}

#[tauri::command]
async fn sftp_rename(ssh: State<'_, Arc<Ssh>>, id: u32, from: String, to: String) -> CmdResult<()> {
    with_sftp(&ssh, id, |s| async move {
        if s.try_exists(to.clone()).await? {
            anyhow::bail!("{to} already exists");
        }
        Ok(s.rename(from, to).await?)
    })
    .await
}

/// Deletes a file, or a folder that is already empty.
#[tauri::command]
async fn sftp_remove(ssh: State<'_, Arc<Ssh>>, id: u32, path: String, dir: bool) -> CmdResult<()> {
    with_sftp(&ssh, id, |s| async move {
        if dir {
            s.remove_dir(path).await?;
        } else {
            s.remove_file(path).await?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn sftp_exists(ssh: State<'_, Arc<Ssh>>, id: u32, path: String) -> CmdResult<bool> {
    with_sftp(&ssh, id, |s| async move { Ok(s.try_exists(path).await?) }).await
}

/// "file", "dir", or "missing", for overwrite checks and dropped paths.
#[tauri::command]
fn local_kind(path: PathBuf) -> &'static str {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => "dir",
        Ok(_) => "file",
        Err(_) => "missing",
    }
}

#[tauri::command]
fn default_download_dir() -> Option<PathBuf> {
    dirs::download_dir().or_else(dirs::home_dir)
}

/// Starts a transfer and returns its id at once; progress and the result arrive on `events`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn sftp_transfer(
    ssh: State<'_, Arc<Ssh>>,
    transfers: State<'_, Arc<Transfers>>,
    id: u32,
    upload: bool,
    local: PathBuf,
    remote: String,
    overwrite: bool,
    events: Channel<TransferEvent>,
) -> CmdResult<u32> {
    let session = ssh.sftp(id).await.map_err(err)?;
    let (tid, cancel) = transfers.start();
    let transfers = Arc::clone(&transfers);
    tauri::async_runtime::spawn(async move {
        let progress = |done, total| {
            let _ = events.send(TransferEvent::Progress { done, total });
        };
        let result = if upload {
            sftp::upload(&session, &local, &remote, overwrite, &cancel, &progress).await
        } else {
            sftp::download(&session, &remote, &local, overwrite, &cancel, &progress).await
        };
        transfers.finish(tid);
        let _ = events.send(sftp::outcome(result));
    });
    Ok(tid)
}

#[tauri::command]
fn start_forward(ssh: State<'_, Arc<Ssh>>, id: u32, forward: forward::Forward) {
    ssh.start_forward(id, forward);
}

#[tauri::command]
fn stop_forward(ssh: State<'_, Arc<Ssh>>, id: u32, forward: Uuid) {
    ssh.stop_forward(id, forward);
}

#[tauri::command]
fn sftp_cancel(transfers: State<'_, Arc<Transfers>>, transfer: u32) {
    transfers.cancel(transfer);
}

#[tauri::command]
fn start_log(ssh: State<'_, Arc<Ssh>>, id: u32) {
    ssh.start_log(id);
}

#[tauri::command]
fn stop_log(ssh: State<'_, Arc<Ssh>>, id: u32) {
    ssh.stop_log(id);
}

#[tauri::command]
fn get_log_dir(settings: State<'_, SettingsState>) -> String {
    settings.log_dir().display().to_string()
}

/// Sets the log folder; None goes back to the default. Returns the folder now in use.
#[tauri::command]
fn set_log_dir(
    settings: State<'_, SettingsState>,
    ssh: State<'_, Arc<Ssh>>,
    dir: Option<String>,
) -> CmdResult<String> {
    let dir = dir.filter(|d| !d.trim().is_empty());
    {
        let mut current = settings.current.lock().unwrap();
        current.log_dir = dir;
        settings::save(&settings.path, &current).map_err(err)?;
    }
    let effective = settings.log_dir();
    ssh.set_log_dir(effective.clone());
    Ok(effective.display().to_string())
}

#[tauri::command]
fn open_log_dir(app: AppHandle, settings: State<'_, SettingsState>) -> CmdResult<()> {
    let dir = settings.log_dir();
    std::fs::create_dir_all(&dir).map_err(err)?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(err)
}

/// Finds sessions in ~/.ssh/config and PuTTY. Reads only; runs nothing.
#[tauri::command]
async fn scan_imports() -> import::Scan {
    import::scan_default(&import::Env::current())
}

/// Finds sessions in an OpenSSH config file the user chose.
#[tauri::command]
async fn scan_ssh_config(path: String) -> import::Scan {
    import::scan_file(std::path::Path::new(&path), &import::Env::current())
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
            let data = app.path().app_data_dir().unwrap_or_else(|_| dir.clone());
            let state = SettingsState {
                path: dir.join("settings.json"),
                default_log_dir: settings::default_log_dir(&data),
                current: Mutex::new(settings::load(&dir.join("settings.json"))),
            };
            app.manage(SessionStore::new(dir.join("sessions.json")));
            app.manage(SnippetStore::new(dir.join("snippets.json")));
            app.manage(Arc::new(Transfers::default()));
            app.manage(Arc::new(Ssh::new(dir.join("known_hosts"), state.log_dir())));
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_forward,
            stop_forward,
            sftp_list,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            sftp_exists,
            sftp_transfer,
            sftp_cancel,
            local_kind,
            default_download_dir,
            list_sessions,
            save_session,
            delete_session,
            list_snippets,
            save_snippet,
            delete_snippet,
            forget_secrets,
            connect,
            send_input,
            resize,
            disconnect,
            answer_prompt,
            open_link,
            start_log,
            stop_log,
            get_log_dir,
            set_log_dir,
            open_log_dir,
            scan_imports,
            scan_ssh_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GhostKey");
}
