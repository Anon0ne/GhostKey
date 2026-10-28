//! SSH connections. Each connection runs in its own task, which owns the
//! russh handle and the shell channel. The UI talks to it through commands
//! (input, resize, close) and hears back through two Tauri channels: one for
//! raw terminal output and one for everything else (status, banners, prompts).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{self, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::forward::{self, Forward, RemoteTargets, TunnelStatus, Tunnels};
use crate::hostkeys::{self, HostKeyStatus};
use crate::links::{self, BannerLink};
use crate::logging::LineLog;
use crate::secrets::{self, SecretKind};
use crate::sessions::AuthMethod;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    /// Set when connecting from a saved session, so stored secrets can be used.
    pub session_id: Option<Uuid>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
    #[serde(default)]
    pub auto_open_tailscale: bool,
    /// Start a session log as soon as the shell opens.
    #[serde(default)]
    pub log: bool,
    /// Names the log file, usually the saved session's name.
    #[serde(default)]
    pub label: String,
    /// Tunnels to start once the shell is open (those set to start automatically).
    #[serde(default)]
    pub forwards: Vec<Forward>,
    /// Reach the server through this host first (one hop, like ProxyJump).
    #[serde(default)]
    pub jump: Option<JumpRequest>,
    pub cols: u32,
    pub rows: u32,
}

/// The bastion to connect through. It is logged in to like any session,
/// with its own host-key check and prompts.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpRequest {
    pub session_id: Option<Uuid>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ConnEvent {
    Status {
        message: String,
    },
    Banner {
        text: String,
        links: Vec<BannerLink>,
        auto_opened: Option<String>,
    },
    Prompt {
        id: u32,
        prompt: Prompt,
    },
    Connected,
    /// Logging started (`path` set), stopped (`path` empty), or failed (`error`).
    Logging {
        path: Option<String>,
        error: Option<String>,
    },
    /// The connection's tunnels, sent in full whenever one changes.
    Tunnels {
        tunnels: Vec<TunnelStatus>,
    },
    Closed {
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Prompt {
    HostKey {
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    Password {
        user: String,
        host: String,
        retry: bool,
        can_save: bool,
    },
    Passphrase {
        key_path: String,
        retry: bool,
        can_save: bool,
    },
    KeyboardInteractive {
        name: String,
        instructions: String,
        fields: Vec<PromptField>,
        can_save: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptField {
    pub label: String,
    pub echo: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAnswer {
    /// False when the user pressed Cancel.
    pub accept: bool,
    #[serde(default)]
    pub values: Vec<String>,
    /// Save the entered secret to the OS keychain.
    #[serde(default)]
    pub save: bool,
}

pub type OpenUrl = dyn Fn(&str) -> anyhow::Result<()> + Send + Sync;

/// Where a connection sends what it produces. The Tauri layer wires these to
/// IPC channels and the system browser; tests wire them to plain closures.
#[derive(Clone)]
pub struct Sinks {
    pub events: Arc<dyn Fn(ConnEvent) + Send + Sync>,
    pub output: Arc<dyn Fn(Vec<u8>) + Send + Sync>,
    pub open_url: Arc<OpenUrl>,
}

impl Sinks {
    fn event(&self, e: ConnEvent) {
        (self.events)(e)
    }
}

enum ConnCmd {
    Input(Vec<u8>),
    Resize(u32, u32),
    StartLog,
    StopLog,
    /// Opens an SFTP channel next to the shell.
    OpenSftp(oneshot::Sender<anyhow::Result<SftpSession>>),
    StartForward(Forward),
    StopForward(Uuid),
    Close,
}

struct ConnEntry {
    cmds: mpsc::UnboundedSender<ConnCmd>,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// Shared by all connections; managed as Tauri state.
pub struct Ssh {
    next_id: AtomicU32,
    conns: Mutex<HashMap<u32, ConnEntry>>,
    /// One SFTP session per connection, opened on first use.
    sftp: tokio::sync::Mutex<HashMap<u32, Arc<SftpSession>>>,
    prompts: Arc<Mutex<HashMap<u32, oneshot::Sender<PromptAnswer>>>>,
    known_hosts: PathBuf,
    log_dir: Arc<Mutex<PathBuf>>,
}

impl Ssh {
    pub fn new(known_hosts: PathBuf, log_dir: PathBuf) -> Self {
        Self {
            next_id: AtomicU32::new(1),
            conns: Mutex::new(HashMap::new()),
            sftp: tokio::sync::Mutex::new(HashMap::new()),
            prompts: Arc::new(Mutex::new(HashMap::new())),
            known_hosts,
            log_dir: Arc::new(Mutex::new(log_dir)),
        }
    }

    /// New logs go here; logs already running keep their file.
    pub fn set_log_dir(&self, dir: PathBuf) {
        *self.log_dir.lock().unwrap() = dir;
    }

    pub fn start_log(&self, id: u32) {
        self.send(id, ConnCmd::StartLog);
    }

    pub fn stop_log(&self, id: u32) {
        self.send(id, ConnCmd::StopLog);
    }

    pub fn connect(self: &Arc<Self>, req: ConnectRequest, sinks: Sinks) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let ctx = ConnCtx {
            req,
            sinks: sinks.clone(),
            prompts: Prompter {
                next_id: Arc::new(AtomicU32::new(1)),
                conn_id: id,
                pending: self.prompts.clone(),
                sinks: sinks.clone(),
            },
            known_hosts: self.known_hosts.clone(),
            log_dir: self.log_dir.clone(),
        };
        let this = Arc::clone(self);
        // Hold the lock until the entry is in, so a fast failure can't try to
        // remove it before it exists.
        let mut conns = self.conns.lock().unwrap();
        let task = tauri::async_runtime::spawn(async move {
            let error = run(ctx, rx).await.err().map(|e| format!("{e:#}"));
            sinks.event(ConnEvent::Closed { error });
            this.conns.lock().unwrap().remove(&id);
            this.sftp.lock().await.remove(&id);
            this.prompts
                .lock()
                .unwrap()
                .retain(|k, _| prompt_conn(*k) != id);
        });
        conns.insert(id, ConnEntry { cmds: tx, task });
        id
    }

    pub fn start_forward(&self, id: u32, forward: Forward) {
        self.send(id, ConnCmd::StartForward(forward));
    }

    pub fn stop_forward(&self, id: u32, forward: Uuid) {
        self.send(id, ConnCmd::StopForward(forward));
    }

    pub fn input(&self, id: u32, data: Vec<u8>) {
        self.send(id, ConnCmd::Input(data));
    }

    pub fn resize(&self, id: u32, cols: u32, rows: u32) {
        self.send(id, ConnCmd::Resize(cols, rows));
    }

    /// Closes a live session, or abandons one that is still logging in.
    pub fn close(&self, id: u32) {
        let entry = self.conns.lock().unwrap().remove(&id);
        if let Some(entry) = entry {
            let _ = entry.cmds.send(ConnCmd::Close);
            // A live shell closes itself on the command above. A connection
            // still logging in never reads it, so stop the task after a moment.
            let task = entry.task;
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                task.abort();
            });
        }
        self.prompts
            .lock()
            .unwrap()
            .retain(|k, _| prompt_conn(*k) != id);
    }

    /// The connection's SFTP session, opened on first use. Fails when the
    /// connection is gone or the server has no SFTP; the shell is unaffected.
    pub async fn sftp(&self, id: u32) -> anyhow::Result<Arc<SftpSession>> {
        // Held across the open, so two calls can't open two sessions.
        let mut sessions = self.sftp.lock().await;
        if let Some(s) = sessions.get(&id) {
            return Ok(s.clone());
        }
        let (tx, rx) = oneshot::channel();
        self.send(id, ConnCmd::OpenSftp(tx));
        let session = Arc::new(
            rx.await
                .map_err(|_| anyhow::anyhow!("The session is not connected"))??,
        );
        sessions.insert(id, session.clone());
        Ok(session)
    }

    /// Forgets a broken SFTP session, so the next call opens a new one.
    pub async fn drop_sftp(&self, id: u32) {
        self.sftp.lock().await.remove(&id);
    }

    pub fn answer(&self, prompt_id: u32, answer: PromptAnswer) {
        if let Some(tx) = self.prompts.lock().unwrap().remove(&prompt_id) {
            let _ = tx.send(answer);
        }
    }

    fn send(&self, id: u32, cmd: ConnCmd) {
        if let Some(entry) = self.conns.lock().unwrap().get(&id) {
            let _ = entry.cmds.send(cmd);
        }
    }
}

/// Prompt ids carry their connection id in the high 16 bits, so a closed
/// connection's prompts can be dropped.
fn prompt_conn(prompt_id: u32) -> u32 {
    prompt_id >> 16
}

#[derive(Clone)]
struct Prompter {
    next_id: Arc<AtomicU32>,
    conn_id: u32,
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<PromptAnswer>>>>,
    sinks: Sinks,
}

impl Prompter {
    /// Shows a prompt in the UI and waits for the answer. Cancel (or a closed
    /// connection) comes back as `accept: false`.
    async fn ask(&self, prompt: Prompt) -> PromptAnswer {
        let id = (self.conn_id << 16) | (self.next_id.fetch_add(1, Ordering::Relaxed) & 0xFFFF);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.sinks.event(ConnEvent::Prompt { id, prompt });
        rx.await.unwrap_or_default()
    }
}

struct ConnCtx {
    req: ConnectRequest,
    sinks: Sinks,
    prompts: Prompter,
    known_hosts: PathBuf,
    log_dir: Arc<Mutex<PathBuf>>,
}

impl ConnCtx {
    fn status(&self, message: impl Into<String>) {
        self.sinks.event(ConnEvent::Status {
            message: message.into(),
        });
    }

    fn start_log(&self, log: &mut LineLog) {
        let dir = self.log_dir.lock().unwrap().clone();
        let label = if self.req.label.trim().is_empty() {
            format!("{}@{}", self.req.username, self.req.host)
        } else {
            self.req.label.clone()
        };
        match log.start(&dir, &label, &self.req.host, self.req.port) {
            Ok(path) => self.sinks.event(ConnEvent::Logging {
                path: Some(path.display().to_string()),
                error: None,
            }),
            Err(e) => self.log_error(format!("Couldn't start the log in {}: {e}", dir.display())),
        }
    }

    /// The same connection's context, aimed at a jump host.
    fn hop(&self, jump: &JumpRequest) -> ConnCtx {
        ConnCtx {
            req: ConnectRequest {
                session_id: jump.session_id,
                host: jump.host.clone(),
                port: jump.port,
                username: jump.username.clone(),
                auth: jump.auth,
                key_path: jump.key_path.clone(),
                auto_open_tailscale: self.req.auto_open_tailscale,
                log: false,
                label: String::new(),
                forwards: Vec::new(),
                jump: None,
                cols: self.req.cols,
                rows: self.req.rows,
            },
            sinks: self.sinks.clone(),
            prompts: self.prompts.clone(),
            known_hosts: self.known_hosts.clone(),
            log_dir: self.log_dir.clone(),
        }
    }

    fn log_error(&self, error: String) {
        self.sinks.event(ConnEvent::Logging {
            path: None,
            error: Some(error),
        });
    }
}

/// Closes a log, reporting a failure to write its last lines.
fn stop_log(ctx: &ConnCtx, log: &mut LineLog) {
    if log.path().is_none() {
        return;
    }
    match log.stop() {
        Ok(()) => ctx.sinks.event(ConnEvent::Logging {
            path: None,
            error: None,
        }),
        Err(e) => ctx.log_error(format!("Couldn't finish the log: {e}")),
    }
}

struct Handler {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    auto_open_tailscale: bool,
    sinks: Sinks,
    prompts: Prompter,
    /// Why the host key was rejected, for the error message.
    rejection: Arc<Mutex<Option<String>>>,
    /// Where connections from the server's remote forwards go.
    remote: RemoteTargets,
}

impl client::Handler for Handler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = match server_key {
            russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } => key,
            _ => {
                *self.rejection.lock().unwrap() =
                    Some("Host certificates aren't supported yet".into());
                return Ok(false);
            }
        };
        let fingerprint = hostkeys::fingerprint(key);
        match hostkeys::check(&self.host, self.port, key, &self.known_hosts)? {
            HostKeyStatus::Trusted => Ok(true),
            HostKeyStatus::Changed { line } => {
                *self.rejection.lock().unwrap() = Some(format!(
                    "WARNING: the host key for {} has CHANGED. This could mean someone is \
                     intercepting the connection. The server now presents {} {}. If you \
                     expected this, remove line {} from {} and connect again.",
                    self.host,
                    hostkeys::algorithm(key),
                    fingerprint,
                    line,
                    self.known_hosts.display()
                ));
                Ok(false)
            }
            HostKeyStatus::Unknown => {
                let answer = self
                    .prompts
                    .ask(Prompt::HostKey {
                        host: self.host.clone(),
                        port: self.port,
                        algorithm: hostkeys::algorithm(key),
                        fingerprint,
                    })
                    .await;
                if answer.accept {
                    hostkeys::learn(&self.host, self.port, key, &self.known_hosts)?;
                    Ok(true)
                } else {
                    *self.rejection.lock().unwrap() = Some("Host key not trusted".into());
                    Ok(false)
                }
            }
        }
    }

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let found = links::find_links(banner);
        let mut auto_opened = None;
        if self.auto_open_tailscale {
            if let Some(link) = found.iter().find(|l| l.tailscale) {
                match (self.sinks.open_url)(&link.url) {
                    Ok(()) => auto_opened = Some(link.url.clone()),
                    Err(e) => log::warn!("could not open browser: {e}"),
                }
            }
        }
        self.sinks.event(ConnEvent::Banner {
            text: banner.to_string(),
            links: found,
            auto_opened,
        });
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // Only ports this connection asked the server to forward are accepted.
        let target = self.remote.lock().unwrap().get(&connected_port).cloned();
        match target {
            Some(target) => {
                reply.accept().await;
                tokio::spawn(forward::serve_remote(target, channel.into_stream()));
            }
            None => {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await
            }
        }
        Ok(())
    }
}

fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        // No inactivity timeout: Tailscale check mode can hold the login for
        // as long as the user takes to approve in the browser.
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    })
}

async fn tcp_connect(host: &str, port: u16) -> anyhow::Result<tokio::net::TcpStream> {
    let stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Timed out connecting to {host}:{port}"))??;
    stream.set_nodelay(true).ok();
    Ok(stream)
}

/// Runs the SSH handshake over `stream`, checks the host key, and logs in.
async fn login<S>(
    ctx: &ConnCtx,
    stream: S,
    remote: RemoteTargets,
) -> anyhow::Result<client::Handle<Handler>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let req = &ctx.req;
    let rejection = Arc::new(Mutex::new(None));
    let handler = Handler {
        host: req.host.clone(),
        port: req.port,
        known_hosts: ctx.known_hosts.clone(),
        auto_open_tailscale: req.auto_open_tailscale,
        sinks: ctx.sinks.clone(),
        prompts: ctx.prompts.clone(),
        rejection: rejection.clone(),
        remote,
    };
    let mut handle = match client::connect_stream(ssh_config(), stream, handler).await {
        Ok(h) => h,
        Err(e) => {
            if let Some(reason) = rejection.lock().unwrap().take() {
                anyhow::bail!(reason);
            }
            return Err(e);
        }
    };
    if !authenticate(&mut handle, ctx).await? {
        anyhow::bail!("Login to {} failed: no more login methods to try", req.host);
    }
    Ok(handle)
}

async fn run(ctx: ConnCtx, mut cmds: mpsc::UnboundedReceiver<ConnCmd>) -> anyhow::Result<()> {
    let req = ctx.req.clone();
    let remote: RemoteTargets = Arc::default();

    // With a jump host, log in there first and reach the server through it.
    // Each hop checks its own host key and asks for its own login.
    let mut jump_handle = None;
    let handle = if let Some(jump) = req.jump.clone() {
        let hop = ctx.hop(&jump);
        ctx.status(format!(
            "Connecting to jump host {}:{}…",
            jump.host, jump.port
        ));
        let stream = tcp_connect(&jump.host, jump.port).await?;
        ctx.status(format!("Logging in to jump host {}…", jump.host));
        let jh = login(&hop, stream, Arc::default())
            .await
            .map_err(|e| anyhow::anyhow!("Jump host {}: {e:#}", jump.host))?;
        ctx.status(format!(
            "Reaching {}:{} through {}…",
            req.host, req.port, jump.host
        ));
        let channel = jh
            .channel_open_direct_tcpip(req.host.clone(), req.port.into(), "127.0.0.1", 0)
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "The jump host {} couldn't reach {}:{}: {e}",
                    jump.host,
                    req.host,
                    req.port
                )
            })?;
        jump_handle = Some(jh);
        ctx.status("Logging in…");
        login(&ctx, channel.into_stream(), remote.clone()).await?
    } else {
        ctx.status(format!("Connecting to {}:{}…", req.host, req.port));
        let stream = tcp_connect(&req.host, req.port).await?;
        ctx.status("Logging in…");
        login(&ctx, stream, remote.clone()).await?
    };

    let handle = Arc::new(handle);
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", req.cols, req.rows, 0, 0, &[])
        .await?;
    channel.request_shell(true).await?;
    let (mut reader, writer) = channel.split();
    ctx.sinks.event(ConnEvent::Connected);
    let mut log = LineLog::default();
    log.set_width(req.cols as usize);
    if req.log {
        ctx.start_log(&mut log);
    }
    let sinks = ctx.sinks.clone();
    let mut tunnels = Tunnels::new(
        handle.clone(),
        remote,
        Arc::new(move |tunnels| sinks.event(ConnEvent::Tunnels { tunnels })),
    );
    for f in req.forwards.iter().filter(|f| f.auto_start) {
        tunnels.start(f.clone());
    }

    loop {
        tokio::select! {
            msg = reader.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if let Err(e) = log.feed(&data) {
                        ctx.log_error(format!("Logging stopped: {e}"));
                    }
                    (ctx.sinks.output)(data.to_vec());
                }
                Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
            cmd = cmds.recv() => match cmd {
                Some(ConnCmd::Input(data)) => writer.data_bytes(data).await?,
                Some(ConnCmd::Resize(cols, rows)) => {
                    log.set_width(cols as usize);
                    writer.window_change(cols, rows, 0, 0).await?
                }
                Some(ConnCmd::StartLog) => ctx.start_log(&mut log),
                Some(ConnCmd::StopLog) => stop_log(&ctx, &mut log),
                Some(ConnCmd::StartForward(f)) => tunnels.start(f),
                Some(ConnCmd::StopForward(id)) => tunnels.stop(id),
                Some(ConnCmd::OpenSftp(reply)) => {
                    // Opened in its own task, so the terminal keeps flowing meanwhile.
                    let handle = handle.clone();
                    tokio::spawn(async move {
                        let _ = reply.send(open_sftp(&handle).await);
                    });
                }
                Some(ConnCmd::Close) | None => {
                    let _ = writer.close().await;
                    break;
                }
            },
        }
    }
    stop_log(&ctx, &mut log);
    tunnels.stop_all();
    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
    if let Some(jh) = jump_handle {
        let _ = jh.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}

async fn open_sftp(handle: &client::Handle<Handler>) -> anyhow::Result<SftpSession> {
    const NO_SFTP: &str =
        "This server doesn't offer SFTP, so files can't be browsed here. The terminal still works.";
    let mut channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    // Wait for the server's answer, so a refusal shows at once instead of as a timeout.
    loop {
        match tokio::time::timeout(CONNECT_TIMEOUT, channel.wait()).await {
            Ok(Some(ChannelMsg::Success)) => break,
            Ok(Some(ChannelMsg::Failure)) | Ok(Some(ChannelMsg::Close)) | Ok(None) => {
                anyhow::bail!(NO_SFTP)
            }
            Ok(Some(_)) => continue,
            Err(_) => anyhow::bail!("The server didn't answer the SFTP request"),
        }
    }
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| anyhow::anyhow!("SFTP didn't start: {e}"))
}

/// Tries "none" first (Tailscale SSH logs in this way, after any check-mode
/// approval), then the session's key, then keyboard-interactive and password.
async fn authenticate(handle: &mut client::Handle<Handler>, ctx: &ConnCtx) -> anyhow::Result<bool> {
    let user = ctx.req.username.clone();
    let mut methods = match handle.authenticate_none(&user).await? {
        client::AuthResult::Success => return Ok(true),
        client::AuthResult::Failure {
            remaining_methods, ..
        } => remaining_methods,
    };

    if ctx.req.auth == AuthMethod::Key && methods.contains(&MethodKind::PublicKey) {
        if let Some(path) = ctx.req.key_path.clone().filter(|p| !p.trim().is_empty()) {
            match try_key(handle, ctx, &user, &path).await? {
                KeyOutcome::Success => return Ok(true),
                KeyOutcome::Failed(remaining) => {
                    ctx.status("Key was not accepted; trying password");
                    methods = remaining;
                }
                KeyOutcome::Cancelled => anyhow::bail!("Login cancelled"),
            }
        }
    }

    if methods.contains(&MethodKind::KeyboardInteractive) {
        match try_keyboard_interactive(handle, ctx, &user).await? {
            Some(true) => return Ok(true),
            Some(false) => {}
            None => anyhow::bail!("Login cancelled"),
        }
    }

    if methods.contains(&MethodKind::Password) {
        return try_password(handle, ctx, &user).await;
    }
    Ok(false)
}

enum KeyOutcome {
    Success,
    Failed(MethodSet),
    Cancelled,
}

async fn try_key(
    handle: &mut client::Handle<Handler>,
    ctx: &ConnCtx,
    user: &str,
    path: &str,
) -> anyhow::Result<KeyOutcome> {
    let session = ctx.req.session_id;
    let key = match keys::load_secret_key(path, None) {
        Ok(k) => k,
        Err(keys::Error::KeyIsEncrypted) => {
            let mut stored = session.and_then(|s| secrets::get(s, SecretKind::Passphrase));
            let mut loaded = None;
            for attempt in 0..MAX_ATTEMPTS {
                let (passphrase, save) = match stored.take() {
                    Some(p) => (p, false),
                    None => {
                        let a = ctx
                            .prompts
                            .ask(Prompt::Passphrase {
                                key_path: path.to_string(),
                                retry: attempt > 0,
                                can_save: session.is_some(),
                            })
                            .await;
                        if !a.accept {
                            return Ok(KeyOutcome::Cancelled);
                        }
                        (a.values.into_iter().next().unwrap_or_default(), a.save)
                    }
                };
                if let Ok(k) = keys::load_secret_key(path, Some(&passphrase)) {
                    if let (true, Some(s)) = (save, session) {
                        secrets::set(s, SecretKind::Passphrase, &passphrase)?;
                    }
                    loaded = Some(k);
                    break;
                }
            }
            loaded.ok_or_else(|| anyhow::anyhow!("Wrong passphrase for {path}"))?
        }
        Err(e) => anyhow::bail!("Couldn't read key file {path}: {e}"),
    };

    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let result = handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await?;
    Ok(match result {
        client::AuthResult::Success => KeyOutcome::Success,
        client::AuthResult::Failure {
            remaining_methods, ..
        } => KeyOutcome::Failed(remaining_methods),
    })
}

/// Returns Some(true) on success, Some(false) when the server rejects us, and
/// None when the user cancels.
async fn try_keyboard_interactive(
    handle: &mut client::Handle<Handler>,
    ctx: &ConnCtx,
    user: &str,
) -> anyhow::Result<Option<bool>> {
    let session = ctx.req.session_id;
    let mut stored = session.and_then(|s| secrets::get(s, SecretKind::Password));
    let mut response = handle
        .authenticate_keyboard_interactive_start(user, None::<String>)
        .await?;
    let mut to_save: Option<String> = None;
    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => {
                if let (Some(pw), Some(s)) = (to_save, session) {
                    secrets::set(s, SecretKind::Password, &pw)?;
                }
                return Ok(Some(true));
            }
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(Some(false)),
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let single_secret = prompts.len() == 1 && !prompts[0].echo;
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if let (true, Some(pw)) = (single_secret, stored.take()) {
                    vec![pw]
                } else {
                    let a = ctx
                        .prompts
                        .ask(Prompt::KeyboardInteractive {
                            name,
                            instructions,
                            fields: prompts
                                .iter()
                                .map(|p| PromptField {
                                    label: p.prompt.clone(),
                                    echo: p.echo,
                                })
                                .collect(),
                            can_save: single_secret && session.is_some(),
                        })
                        .await;
                    if !a.accept {
                        return Ok(None);
                    }
                    if a.save && single_secret {
                        to_save = a.values.first().cloned();
                    }
                    a.values
                };
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
}

async fn try_password(
    handle: &mut client::Handle<Handler>,
    ctx: &ConnCtx,
    user: &str,
) -> anyhow::Result<bool> {
    let session = ctx.req.session_id;
    let mut stored = session.and_then(|s| secrets::get(s, SecretKind::Password));
    for attempt in 0..MAX_ATTEMPTS {
        let (password, save) = match stored.take() {
            Some(p) => (p, false),
            None => {
                let a = ctx
                    .prompts
                    .ask(Prompt::Password {
                        user: user.to_string(),
                        host: ctx.req.host.clone(),
                        retry: attempt > 0,
                        can_save: session.is_some(),
                    })
                    .await;
                if !a.accept {
                    anyhow::bail!("Login cancelled");
                }
                (a.values.into_iter().next().unwrap_or_default(), a.save)
            }
        };
        if handle
            .authenticate_password(user, &password)
            .await?
            .success()
        {
            if let (true, Some(s)) = (save, session) {
                secrets::set(s, SecretKind::Password, &password)?;
            }
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_ids_carry_connection() {
        assert_eq!(prompt_conn((7 << 16) | 3), 7);
    }
}

/// End-to-end tests against a real OpenSSH server. They are skipped unless
/// GHOSTKEY_TEST_HOST is set; CI starts a server and sets these variables:
/// GHOSTKEY_TEST_HOST, GHOSTKEY_TEST_PORT, GHOSTKEY_TEST_USER,
/// GHOSTKEY_TEST_PASSWORD, GHOSTKEY_TEST_KEY, GHOSTKEY_TEST_KEY_PASSPHRASE.
/// The server should send a banner containing a login.tailscale.com link.
#[cfg(test)]
mod live {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::mpsc::UnboundedReceiver;

    struct Env {
        host: String,
        port: u16,
        user: String,
        password: String,
        key: String,
        passphrase: String,
    }

    fn env() -> Option<Env> {
        let v = |k: &str| std::env::var(k).ok();
        Some(Env {
            host: v("GHOSTKEY_TEST_HOST")?,
            port: v("GHOSTKEY_TEST_PORT")?.parse().ok()?,
            user: v("GHOSTKEY_TEST_USER")?,
            password: v("GHOSTKEY_TEST_PASSWORD")?,
            key: v("GHOSTKEY_TEST_KEY")?,
            passphrase: v("GHOSTKEY_TEST_KEY_PASSPHRASE")?,
        })
    }

    enum Seen {
        Event(ConnEvent),
        Output(Vec<u8>),
    }

    fn start(
        ssh: &Arc<Ssh>,
        env: &Env,
        auth: AuthMethod,
        opened: Arc<StdMutex<Vec<String>>>,
    ) -> (u32, UnboundedReceiver<Seen>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let tx2 = tx.clone();
        let sinks = Sinks {
            events: Arc::new(move |e| {
                let _ = tx.send(Seen::Event(e));
            }),
            output: Arc::new(move |d| {
                let _ = tx2.send(Seen::Output(d));
            }),
            open_url: Arc::new(move |u| {
                opened.lock().unwrap().push(u.to_string());
                Ok(())
            }),
        };
        let req = ConnectRequest {
            session_id: None,
            host: env.host.clone(),
            port: env.port,
            username: env.user.clone(),
            auth,
            key_path: Some(env.key.clone()),
            auto_open_tailscale: true,
            log: auth == AuthMethod::Password,
            label: "live test".into(),
            forwards: Vec::new(),
            jump: None,
            cols: 80,
            rows: 24,
        };
        (ssh.connect(req, sinks), rx)
    }

    /// Answers prompts with `answer` until the connection is up or closed.
    /// Returns (prompt kinds seen, banner links seen, close error if closed).
    async fn drive(
        ssh: &Arc<Ssh>,
        rx: &mut UnboundedReceiver<Seen>,
        mut answer: impl FnMut(&Prompt) -> PromptAnswer,
    ) -> (Vec<String>, Vec<BannerLink>, Option<Option<String>>) {
        let mut kinds = Vec::new();
        let mut links = Vec::new();
        loop {
            let seen = tokio::time::timeout(Duration::from_secs(20), rx.recv())
                .await
                .expect("timed out waiting for the connection")
                .expect("connection dropped its sinks");
            match seen {
                Seen::Event(ConnEvent::Prompt { id, prompt }) => {
                    kinds.push(
                        serde_json::to_value(&prompt).unwrap()["kind"]
                            .as_str()
                            .unwrap()
                            .to_string(),
                    );
                    ssh.answer(id, answer(&prompt));
                }
                Seen::Event(ConnEvent::Banner { links: l, .. }) => links.extend(l),
                Seen::Event(ConnEvent::Connected) => return (kinds, links, None),
                Seen::Event(ConnEvent::Closed { error }) => return (kinds, links, Some(error)),
                _ => {}
            }
        }
    }

    async fn expect_output(rx: &mut UnboundedReceiver<Seen>, needle: &str) {
        let mut all = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while !all.contains(needle) {
            let seen = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .unwrap_or_else(|_| panic!("never saw {needle:?} in output: {all:?}"));
            if let Some(Seen::Output(d)) = seen {
                all.push_str(&String::from_utf8_lossy(&d));
            }
        }
    }

    /// Waits for the first log in `dir` to be closed, then returns its text.
    async fn wait_for_log(dir: &std::path::Path) -> String {
        for _ in 0..50 {
            if let Some(Ok(entry)) = std::fs::read_dir(dir).ok().and_then(|mut d| d.next()) {
                let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                if text.contains("=== log closed") {
                    return text;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("no finished log in {}", dir.display());
    }

    fn yes(values: &[&str]) -> PromptAnswer {
        PromptAnswer {
            accept: true,
            values: values.iter().map(|s| s.to_string()).collect(),
            save: false,
        }
    }

    #[tokio::test]
    async fn password_key_and_host_key_flows() {
        let Some(env) = env() else {
            eprintln!("GHOSTKEY_TEST_HOST not set; skipping live SSH tests");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let known_hosts = dir.path().join("known_hosts");
        let log_dir = dir.path().join("logs");
        let ssh = Arc::new(Ssh::new(known_hosts.clone(), log_dir.clone()));
        let opened = Arc::new(StdMutex::new(Vec::new()));

        // 1. New host: trust prompt, then password. The banner's Tailscale link
        //    is found and auto-opened.
        let (id, mut rx) = start(&ssh, &env, AuthMethod::Password, opened.clone());
        let pw = env.password.clone();
        let (kinds, links, closed) = drive(&ssh, &mut rx, |p| match p {
            Prompt::HostKey { fingerprint, .. } => {
                assert!(fingerprint.starts_with("SHA256:"));
                yes(&[])
            }
            Prompt::Password { .. } | Prompt::KeyboardInteractive { .. } => yes(&[&pw]),
            other => panic!("unexpected prompt {other:?}"),
        })
        .await;
        assert_eq!(closed, None, "login failed");
        assert_eq!(kinds[0], "hostKey");
        assert!(
            links.iter().any(|l| l.tailscale),
            "banner link not found: {links:?}"
        );
        assert!(opened
            .lock()
            .unwrap()
            .iter()
            .any(|u| u.contains("login.tailscale.com")));
        ssh.input(id, b"echo GK_$((40+2))\n".to_vec());
        expect_output(&mut rx, "GK_42").await;
        ssh.resize(id, 120, 40);
        ssh.input(id, b"stty size\n".to_vec());
        expect_output(&mut rx, "40 120").await;
        ssh.close(id);

        // The session was logged (password sessions log in this test) as
        // plain text, closed with a footer.
        let log_text = wait_for_log(&log_dir).await;
        assert!(log_text.contains("GK_42"), "{log_text}");
        assert!(
            !log_text.contains('\x1b'),
            "escape codes in log: {log_text:?}"
        );

        // 2. Known host now: no trust prompt. A wrong password re-prompts,
        //    and cancelling ends the connection with an error.
        let (_, mut rx) = start(&ssh, &env, AuthMethod::Password, opened.clone());
        let mut tries = 0;
        let (kinds, _, closed) = drive(&ssh, &mut rx, |p| match p {
            Prompt::Password { .. } | Prompt::KeyboardInteractive { .. } => {
                tries += 1;
                if tries == 1 {
                    yes(&["wrong-password"])
                } else {
                    PromptAnswer::default()
                }
            }
            other => panic!("unexpected prompt {other:?}"),
        })
        .await;
        assert!(!kinds.contains(&"hostKey".to_string()));
        assert!(tries >= 2, "wrong password did not re-prompt");
        assert!(closed.flatten().unwrap_or_default().contains("cancelled"));

        // 3. Encrypted key: passphrase prompt, then logged in without a password.
        let (id, mut rx) = start(&ssh, &env, AuthMethod::Key, opened.clone());
        let pass = env.passphrase.clone();
        let (kinds, _, closed) = drive(&ssh, &mut rx, |p| match p {
            Prompt::Passphrase { .. } => yes(&[&pass]),
            other => panic!("unexpected prompt {other:?}"),
        })
        .await;
        assert_eq!(closed, None, "key login failed");
        assert_eq!(kinds, vec!["passphrase"]);
        ssh.input(id, b"whoami\n".to_vec());
        expect_output(&mut rx, &env.user).await;
        ssh.close(id);

        // 4. Changed host key: refused with a warning, no prompt.
        let line = std::fs::read_to_string(&known_hosts).unwrap();
        let host_part = line.split(' ').next().unwrap();
        std::fs::write(
            &known_hosts,
            format!("{host_part} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ\n"),
        )
        .unwrap();
        let (_, mut rx) = start(&ssh, &env, AuthMethod::Password, opened.clone());
        let (kinds, _, closed) = drive(&ssh, &mut rx, |p| panic!("unexpected prompt {p:?}")).await;
        assert!(kinds.is_empty());
        assert!(closed.flatten().unwrap_or_default().contains("CHANGED"));
    }

    #[tokio::test]
    async fn sftp_round_trip_overwrite_and_cancel() {
        let Some(env) = env() else {
            eprintln!("GHOSTKEY_TEST_HOST not set; skipping live SFTP tests");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let ssh = Arc::new(Ssh::new(
            dir.path().join("known_hosts"),
            dir.path().join("logs"),
        ));
        let (id, mut rx) = start(
            &ssh,
            &env,
            AuthMethod::Password,
            Arc::new(StdMutex::new(Vec::new())),
        );
        let pw = env.password.clone();
        let (_, _, closed) = drive(&ssh, &mut rx, |p| match p {
            Prompt::HostKey { .. } => yes(&[]),
            _ => yes(&[&pw]),
        })
        .await;
        assert_eq!(closed, None, "login failed");

        let s = ssh.sftp(id).await.expect("open sftp");
        let home = crate::sftp::list(&s, "").await.unwrap().path;
        let work = crate::sftp::join(&home, &format!("gk-sftp-{}", Uuid::new_v4()));
        s.create_dir(work.clone()).await.unwrap();

        // Binary data, larger than one chunk, survives a round trip.
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i * 7 % 256) as u8).collect();
        let local = dir.path().join("blob.bin");
        std::fs::write(&local, &data).unwrap();
        let remote = crate::sftp::join(&work, "blob.bin");
        let cancel = AtomicBool::new(false);
        let last = StdMutex::new((0, 0));
        let progress = |d, t| *last.lock().unwrap() = (d, t);
        crate::sftp::upload(&s, &local, &remote, false, &cancel, &progress)
            .await
            .unwrap();
        assert_eq!(
            *last.lock().unwrap(),
            (data.len() as u64, data.len() as u64)
        );
        let back = dir.path().join("back.bin");
        let existing_part = dir.path().join("back.bin.ghostkey-part");
        std::fs::write(&existing_part, b"unrelated file").unwrap();
        crate::sftp::download(&s, &remote, &back, false, &cancel, &progress)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), data);
        assert_eq!(std::fs::read(&existing_part).unwrap(), b"unrelated file");

        // Existing files are only replaced when asked, and keep their permissions.
        let e = crate::sftp::upload(&s, &local, &remote, false, &cancel, &progress)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("already exists"), "{e}");
        assert!(
            crate::sftp::download(&s, &remote, &back, false, &cancel, &progress)
                .await
                .is_err()
        );
        let attrs = russh_sftp::protocol::FileAttributes {
            permissions: Some(0o640),
            ..russh_sftp::protocol::FileAttributes::empty()
        };
        s.set_metadata(remote.clone(), attrs).await.unwrap();
        std::fs::write(&local, b"new").unwrap();
        crate::sftp::upload(&s, &local, &remote, true, &cancel, &progress)
            .await
            .unwrap();
        let meta = s.metadata(remote.clone()).await.unwrap();
        assert_eq!(meta.size, Some(3));
        assert_eq!(meta.permissions.unwrap() & 0o777, 0o640);
        crate::sftp::download(&s, &remote, &back, true, &cancel, &progress)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), b"new");

        // A cancelled transfer leaves nothing behind, under either name.
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        let other = crate::sftp::join(&work, "cancelled.bin");
        let e = crate::sftp::upload(&s, &local, &other, false, &cancel, &progress)
            .await
            .unwrap_err();
        assert!(matches!(
            crate::sftp::outcome(Err(e)),
            crate::sftp::TransferEvent::Cancelled
        ));
        let names: Vec<_> = crate::sftp::list(&s, &work)
            .await
            .unwrap()
            .entries
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, ["blob.bin"]);
        let gone = dir.path().join("gone.bin");
        assert!(
            crate::sftp::download(&s, &remote, &gone, false, &cancel, &progress)
                .await
                .is_err()
        );
        assert!(std::fs::read_dir(dir.path()).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("gone")));

        s.remove_file(remote).await.unwrap();
        s.remove_dir(work).await.unwrap();

        // The shell still works alongside SFTP.
        ssh.input(id, b"echo GK_$((40+3))\n".to_vec());
        expect_output(&mut rx, "GK_43").await;
        ssh.close(id);
    }

    /// Waits until the tunnel `id` reaches `state` and returns its status.
    async fn tunnel(
        rx: &mut UnboundedReceiver<Seen>,
        id: Uuid,
        state: crate::forward::TunnelState,
    ) -> TunnelStatus {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let seen = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .unwrap_or_else(|_| panic!("tunnel never reached {state:?}"));
            if let Some(Seen::Event(ConnEvent::Tunnels { tunnels })) = seen {
                if let Some(t) = tunnels
                    .into_iter()
                    .find(|t| t.forward.id == id && t.state == state)
                {
                    return t;
                }
            }
        }
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    async fn read_some(s: &mut tokio::net::TcpStream) -> String {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 256];
        let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf))
            .await
            .expect("no data through the tunnel")
            .unwrap();
        String::from_utf8_lossy(&buf[..n]).into_owned()
    }

    #[tokio::test]
    async fn tunnels_and_jump_host() {
        use crate::forward::{ForwardKind, TunnelState};
        use tokio::io::AsyncWriteExt;
        let Some(env) = env() else {
            eprintln!("GHOSTKEY_TEST_HOST not set; skipping live tunnel tests");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let ssh = Arc::new(Ssh::new(
            dir.path().join("known_hosts"),
            dir.path().join("logs"),
        ));
        let fwd = |kind, bind_port, dest_port| Forward {
            id: Uuid::new_v4(),
            kind,
            bind_host: "127.0.0.1".into(),
            bind_port,
            dest_host: "127.0.0.1".into(),
            dest_port,
            auto_start: true,
        };

        // Through a jump host (the same server, reached as itself), with a local
        // forward to the server's own SSH port started on connect.
        let local = fwd(ForwardKind::Local, free_port(), env.port);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let tx2 = tx.clone();
        let sinks = Sinks {
            events: Arc::new(move |e| {
                let _ = tx.send(Seen::Event(e));
            }),
            output: Arc::new(move |d| {
                let _ = tx2.send(Seen::Output(d));
            }),
            open_url: Arc::new(|_| Ok(())),
        };
        let id = ssh.connect(
            ConnectRequest {
                session_id: None,
                host: env.host.clone(),
                port: env.port,
                username: env.user.clone(),
                auth: AuthMethod::Password,
                key_path: None,
                auto_open_tailscale: false,
                log: false,
                label: String::new(),
                forwards: vec![local.clone()],
                jump: Some(JumpRequest {
                    session_id: None,
                    host: env.host.clone(),
                    port: env.port,
                    username: env.user.clone(),
                    auth: AuthMethod::Password,
                    key_path: None,
                }),
                cols: 80,
                rows: 24,
            },
            sinks,
        );
        let pw = env.password.clone();
        let (kinds, _, closed) = drive(&ssh, &mut rx, |p| match p {
            Prompt::HostKey { .. } => yes(&[]),
            _ => yes(&[&pw]),
        })
        .await;
        assert_eq!(closed, None, "login through the jump host failed");
        // Two logins: the jump host, then the server.
        let logins = kinds.iter().filter(|k| *k != "hostKey").count();
        assert_eq!(logins, 2, "{kinds:?}");

        let t = tunnel(&mut rx, local.id, TunnelState::Listening).await;
        assert_eq!(
            t.bound.as_deref(),
            Some(format!("127.0.0.1:{}", local.bind_port).as_str())
        );
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", local.bind_port))
            .await
            .unwrap();
        assert!(read_some(&mut s).await.starts_with("SSH-2.0-"));
        drop(s);

        // An occupied port is reported, not fatal.
        let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let clash = fwd(
            ForwardKind::Local,
            busy.local_addr().unwrap().port(),
            env.port,
        );
        ssh.start_forward(id, clash.clone());
        let t = tunnel(&mut rx, clash.id, TunnelState::Failed).await;
        assert!(t.error.unwrap().contains("already in use"));

        // Dynamic SOCKS5: CONNECT to the server's SSH port by name.
        let socks = fwd(ForwardKind::Dynamic, free_port(), 0);
        ssh.start_forward(id, socks.clone());
        tunnel(&mut rx, socks.id, TunnelState::Listening).await;
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", socks.bind_port))
            .await
            .unwrap();
        s.write_all(&[5, 1, 0]).await.unwrap();
        let mut req = vec![5, 1, 0, 3, 9];
        req.extend_from_slice(b"localhost");
        req.extend_from_slice(&env.port.to_be_bytes());
        s.write_all(&req).await.unwrap();
        let mut reply = [0u8; 12];
        tokio::io::AsyncReadExt::read_exact(&mut s, &mut reply)
            .await
            .unwrap();
        assert_eq!(&reply[..4], &[5, 0, 5, 0], "{reply:?}");
        let banner = read_some(&mut s).await;
        assert!(banner.starts_with("SSH-2.0-"), "{banner:?}");
        drop(s);

        // Remote: the server listens and connections come back to a listener here.
        let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let echo_task = tokio::spawn(async move {
            let (mut c, _) = echo.accept().await.unwrap();
            c.write_all(b"hello from here").await.unwrap();
            let mut byte = [0u8; 1];
            tokio::io::AsyncReadExt::read(&mut c, &mut byte).await.unwrap()
        });
        let remote = fwd(ForwardKind::Remote, free_port(), echo_port);
        ssh.start_forward(id, remote.clone());
        tunnel(&mut rx, remote.id, TunnelState::Listening).await;
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", remote.bind_port))
            .await
            .unwrap();
        assert_eq!(read_some(&mut s).await, "hello from here");
        ssh.stop_forward(id, remote.id);
        let mut byte = [0u8; 1];
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(5),
                tokio::io::AsyncReadExt::read(&mut s, &mut byte),
            )
            .await
            .expect("accepted remote connection survived Stop")
            .unwrap(),
            0
        );
        assert_eq!(echo_task.await.unwrap(), 0);

        // Stopping closes the listener.
        ssh.stop_forward(id, local.id);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::net::TcpStream::connect(("127.0.0.1", local.bind_port))
            .await
            .is_ok()
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "listener still open after stop"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        // Disconnecting closes the rest.
        ssh.close(id);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::net::TcpStream::connect(("127.0.0.1", socks.bind_port))
            .await
            .is_ok()
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "SOCKS listener still open after disconnect"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
