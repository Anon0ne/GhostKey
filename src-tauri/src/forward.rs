//! Port forwarding over a session's SSH connection: local (-L), remote (-R),
//! and dynamic SOCKS (-D). Each tunnel runs in its own task and reports its
//! state; all of them stop when the connection closes.

use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use russh::client;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    /// Listen here, connect from the server (`ssh -L`).
    Local,
    /// Listen on the server, connect from here (`ssh -R`).
    Remote,
    /// A SOCKS5 proxy here; the server makes each connection (`ssh -D`).
    Dynamic,
}

fn loopback() -> String {
    "127.0.0.1".into()
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub id: Uuid,
    pub kind: ForwardKind,
    /// Where to listen: here for local and dynamic, on the server for remote.
    /// Loopback unless the user explicitly widens it.
    #[serde(default = "loopback")]
    pub bind_host: String,
    pub bind_port: u16,
    /// Where connections go. Unused for dynamic forwards.
    #[serde(default)]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
    /// Start when the session connects.
    #[serde(default = "yes")]
    pub auto_start: bool,
}

impl Forward {
    pub fn validate(&self) -> Result<(), String> {
        if self.bind_host.trim().is_empty() {
            return Err("Enter a listen address, such as 127.0.0.1".into());
        }
        if self.kind != ForwardKind::Remote && self.bind_port == 0 {
            return Err("Enter a listen port".into());
        }
        if self.kind != ForwardKind::Dynamic {
            if self.dest_host.trim().is_empty() {
                return Err("Enter a destination host".into());
            }
            if self.dest_port == 0 {
                return Err("Enter a destination port".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TunnelState {
    Starting,
    Listening,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub forward: Forward,
    pub state: TunnelState,
    /// The address actually listened on, e.g. when the server picked the port.
    pub bound: Option<String>,
    /// Why the tunnel failed, or the last connection that couldn't be made.
    pub error: Option<String>,
    pub connections: u32,
}

pub type Emit = Arc<dyn Fn(Vec<TunnelStatus>) + Send + Sync>;

/// Shared tunnel states; every change is sent to the UI as the full list.
#[derive(Clone)]
struct Board {
    tunnels: Arc<Mutex<Vec<TunnelStatus>>>,
    emit: Emit,
}

impl Board {
    fn update(&self, id: Uuid, f: impl FnOnce(&mut TunnelStatus)) {
        let list = {
            let mut tunnels = self.tunnels.lock().unwrap();
            match tunnels.iter_mut().find(|t| t.forward.id == id) {
                Some(t) => f(t),
                None => return,
            }
            tunnels.clone()
        };
        (self.emit)(list);
    }

    fn reporter(&self, id: Uuid) -> Reporter {
        Reporter {
            board: self.clone(),
            id,
            stopped: watch::channel(false).0,
        }
    }
}

/// Lets one tunnel's tasks update its state.
#[derive(Clone)]
pub struct Reporter {
    board: Board,
    id: Uuid,
    stopped: watch::Sender<bool>,
}

impl Reporter {
    fn listening(&self, bound: String) {
        self.board.update(self.id, |t| {
            t.state = TunnelState::Listening;
            t.bound = Some(bound);
            t.error = None;
        });
    }

    fn failed(&self, error: String) {
        self.board.update(self.id, |t| {
            t.state = TunnelState::Failed;
            t.error = Some(error);
        });
    }

    /// A single connection failed; the tunnel keeps listening.
    pub fn connection_error(&self, error: String) {
        self.board.update(self.id, |t| t.error = Some(error));
    }

    fn opened(&self) {
        self.board.update(self.id, |t| t.connections += 1);
    }

    fn closed(&self) {
        self.board
            .update(self.id, |t| t.connections = t.connections.saturating_sub(1));
    }

    /// Runs one forwarded connection, keeping the open-connection count.
    pub async fn carry<A, B>(&self, mut a: A, mut b: B)
    where
        A: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
        B: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let mut stopped = self.stopped.subscribe();
        if *stopped.borrow() {
            return;
        }
        self.opened();
        tokio::select! {
            biased;
            _ = stopped.changed() => {}
            _ = tokio::io::copy_bidirectional(&mut a, &mut b) => {}
        }
        self.closed();
    }
}

/// Where a remote forward's connections go, found by the port the server listens on.
#[derive(Clone)]
pub struct RemoteTarget {
    pub host: String,
    pub port: u16,
    pub reporter: Reporter,
}

pub type RemoteTargets = Arc<Mutex<HashMap<u32, RemoteTarget>>>;

/// Connects a connection the server forwarded to us to its local destination.
pub async fn serve_remote<S>(target: RemoteTarget, channel: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut stopped = target.reporter.stopped.subscribe();
    if *stopped.borrow() {
        return;
    }
    let connection = tokio::select! {
        biased;
        _ = stopped.changed() => return,
        result = TcpStream::connect((target.host.as_str(), target.port)) => result,
    };
    match connection {
        Ok(sock) => target.reporter.carry(sock, channel).await,
        Err(e) => target.reporter.connection_error(format!(
            "Couldn't reach {}:{} from this computer: {e}",
            target.host, target.port
        )),
    }
}

pub struct Tunnels<H: client::Handler> {
    handle: Arc<client::Handle<H>>,
    remote: RemoteTargets,
    board: Board,
    tasks: HashMap<Uuid, (ForwardKind, JoinHandle<()>)>,
    cancellations: HashMap<Uuid, watch::Sender<bool>>,
}

impl<H: client::Handler + 'static> Tunnels<H> {
    pub fn new(handle: Arc<client::Handle<H>>, remote: RemoteTargets, emit: Emit) -> Self {
        Self {
            handle,
            remote,
            board: Board {
                tunnels: Arc::new(Mutex::new(Vec::new())),
                emit,
            },
            tasks: HashMap::new(),
            cancellations: HashMap::new(),
        }
    }

    /// Starts a tunnel, replacing one with the same id.
    pub fn start(&mut self, forward: Forward) {
        self.stop(forward.id);
        let id = forward.id;
        let status = TunnelStatus {
            forward: forward.clone(),
            state: TunnelState::Starting,
            bound: None,
            error: None,
            connections: 0,
        };
        self.board.tunnels.lock().unwrap().push(status.clone());
        let reporter = self.board.reporter(id);
        self.cancellations.insert(id, reporter.stopped.clone());
        if let Err(e) = forward.validate() {
            reporter.failed(e);
            return;
        }
        // Show it as starting right away.
        reporter.board.update(id, |_| {});
        let handle = self.handle.clone();
        let kind = forward.kind;
        let task = match kind {
            ForwardKind::Local | ForwardKind::Dynamic => {
                tokio::spawn(listen(handle, forward, reporter))
            }
            ForwardKind::Remote => {
                let remote = self.remote.clone();
                tokio::spawn(async move {
                    match handle
                        .tcpip_forward(forward.bind_host.clone(), forward.bind_port.into())
                        .await
                    {
                        Ok(port) => {
                            // The server only reports the port when it picked one.
                            let port = if forward.bind_port == 0 {
                                port
                            } else {
                                forward.bind_port.into()
                            };
                            let cancelled = {
                                let mut targets = remote.lock().unwrap();
                                if *reporter.stopped.borrow() {
                                    true
                                } else {
                                    targets.insert(
                                        port,
                                        RemoteTarget {
                                            host: forward.dest_host.clone(),
                                            port: forward.dest_port,
                                            reporter: reporter.clone(),
                                        },
                                    );
                                    false
                                }
                            };
                            if cancelled {
                                let _ = handle.cancel_tcpip_forward(forward.bind_host, port).await;
                                return;
                            }
                            reporter
                                .listening(format!("{}:{port} on the server", forward.bind_host));
                        }
                        Err(e) => reporter.failed(format!(
                            "The server refused to listen on {}:{}: {e}",
                            forward.bind_host, forward.bind_port
                        )),
                    }
                })
            }
        };
        self.tasks.insert(id, (kind, task));
    }

    /// Stops a tunnel and forgets it. Connections already open are closed too.
    pub fn stop(&mut self, id: Uuid) {
        if let Some(stopped) = self.cancellations.remove(&id) {
            stopped.send_replace(true);
        }
        if let Some((kind, task)) = self.tasks.remove(&id) {
            // Remote setup must receive the server reply so it can cancel a
            // forward accepted after Stop, instead of leaving a listener behind.
            if kind != ForwardKind::Remote {
                task.abort();
            }
        }
        let removed = {
            let mut tunnels = self.board.tunnels.lock().unwrap();
            let before = tunnels.len();
            let gone: Vec<_> = tunnels
                .iter()
                .filter(|t| t.forward.id == id)
                .cloned()
                .collect();
            tunnels.retain(|t| t.forward.id != id);
            (before != tunnels.len()).then_some(gone)
        };
        let Some(gone) = removed else { return };
        for t in gone {
            if t.forward.kind == ForwardKind::Remote {
                let port = {
                    let mut remote = self.remote.lock().unwrap();
                    let port = remote
                        .iter()
                        .find(|(_, r)| r.reporter.id == id)
                        .map(|(p, _)| *p);
                    if let Some(p) = port {
                        remote.remove(&p);
                    }
                    port
                };
                if let Some(port) = port {
                    let handle = self.handle.clone();
                    let host = t.forward.bind_host.clone();
                    tokio::spawn(async move {
                        let _ = handle.cancel_tcpip_forward(host, port).await;
                    });
                }
            }
        }
        let list = self.board.tunnels.lock().unwrap().clone();
        (self.board.emit)(list);
    }

    /// Stops every tunnel, for a closing connection.
    pub fn stop_all(&mut self) {
        for (_, stopped) in self.cancellations.drain() {
            stopped.send_replace(true);
        }
        for (_, (kind, task)) in self.tasks.drain() {
            if kind != ForwardKind::Remote {
                task.abort();
            }
        }
        self.remote.lock().unwrap().clear();
        self.board.tunnels.lock().unwrap().clear();
    }
}

fn describe_bind_error(host: &str, port: u16, e: &io::Error) -> String {
    match e.kind() {
        io::ErrorKind::AddrInUse => format!("Port {port} on {host} is already in use"),
        io::ErrorKind::PermissionDenied => {
            format!("Not allowed to listen on {host}:{port}; ports below 1024 usually need admin rights")
        }
        io::ErrorKind::AddrNotAvailable => format!("{host} isn't an address of this computer"),
        _ => format!("Couldn't listen on {host}:{port}: {e}"),
    }
}

/// Runs a local or dynamic listener until aborted.
async fn listen<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    forward: Forward,
    reporter: Reporter,
) {
    let listener = match TcpListener::bind((forward.bind_host.as_str(), forward.bind_port)).await {
        Ok(l) => l,
        Err(e) => {
            reporter.failed(describe_bind_error(
                &forward.bind_host,
                forward.bind_port,
                &e,
            ));
            return;
        }
    };
    let bound = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| format!("{}:{}", forward.bind_host, forward.bind_port));
    reporter.listening(bound);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Ok((sock, peer)) = accepted else { continue };
                let handle = handle.clone();
                let forward = forward.clone();
                let reporter = reporter.clone();
                connections.spawn(async move {
                    let _ = sock.set_nodelay(true);
                    match forward.kind {
                        ForwardKind::Dynamic => socks(handle, sock, peer, reporter).await,
                        _ => {
                            let dest = (forward.dest_host.clone(), forward.dest_port);
                            open_and_carry(&handle, sock, peer, dest, &reporter).await;
                        }
                    }
                });
            }
            // Reap finished connections so the set doesn't grow.
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    // Aborting this task drops `connections`, which aborts every open connection.
}

async fn open_and_carry<H: client::Handler>(
    handle: &client::Handle<H>,
    sock: TcpStream,
    peer: SocketAddr,
    (host, port): (String, u16),
    reporter: &Reporter,
) {
    match handle
        .channel_open_direct_tcpip(
            host.clone(),
            port.into(),
            peer.ip().to_string(),
            peer.port().into(),
        )
        .await
    {
        Ok(channel) => reporter.carry(sock, channel.into_stream()).await,
        Err(e) => {
            reporter.connection_error(format!("The server couldn't reach {host}:{port}: {e}"))
        }
    }
}

// ------------------------------------------------------------ SOCKS5

const SOCKS_VERSION: u8 = 5;

/// Reads a SOCKS5 greeting and CONNECT request. Only "no authentication" is
/// offered, which is safe because the proxy listens on loopback by default.
pub async fn socks_request<S>(s: &mut S) -> io::Result<(String, u16)>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    let mut head = [0u8; 2];
    s.read_exact(&mut head).await?;
    if head[0] != SOCKS_VERSION {
        return Err(bad("not a SOCKS5 client"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    s.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        s.write_all(&[SOCKS_VERSION, 0xFF]).await?;
        return Err(bad("the client wants authentication"));
    }
    s.write_all(&[SOCKS_VERSION, 0]).await?;

    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[0] != SOCKS_VERSION {
        return Err(bad("bad SOCKS5 request"));
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            Ipv4Addr::from(a).to_string()
        }
        3 => {
            let len = s.read_u8().await? as usize;
            let mut name = vec![0u8; len];
            s.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| bad("bad host name"))?
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            Ipv6Addr::from(a).to_string()
        }
        _ => {
            socks_reply(s, 8).await?;
            return Err(bad("unknown address type"));
        }
    };
    let port = s.read_u16().await?;
    if req[1] != 1 {
        // Only CONNECT; no BIND or UDP.
        socks_reply(s, 7).await?;
        return Err(bad("only CONNECT is supported"));
    }
    Ok((host, port))
}

/// Sends a SOCKS5 reply: 0 is success, others are the RFC 1928 error codes.
pub async fn socks_reply<S>(s: &mut S, code: u8) -> io::Result<()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    // The bound address is not meaningful here, so it is sent as 0.0.0.0:0.
    s.write_all(&[SOCKS_VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
}

async fn socks<H: client::Handler + 'static>(
    handle: Arc<client::Handle<H>>,
    mut sock: TcpStream,
    peer: SocketAddr,
    reporter: Reporter,
) {
    let Ok((host, port)) = socks_request(&mut sock).await else {
        return;
    };
    match handle
        .channel_open_direct_tcpip(
            host.clone(),
            port.into(),
            peer.ip().to_string(),
            peer.port().into(),
        )
        .await
    {
        Ok(channel) => {
            if socks_reply(&mut sock, 0).await.is_ok() {
                reporter.carry(sock, channel.into_stream()).await;
            }
        }
        Err(e) => {
            // 5 = connection refused; the client shows its own error.
            let _ = socks_reply(&mut sock, 5).await;
            reporter.connection_error(format!("The server couldn't reach {host}:{port}: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fwd(kind: ForwardKind) -> Forward {
        Forward {
            id: Uuid::new_v4(),
            kind,
            bind_host: loopback(),
            bind_port: 8080,
            dest_host: "db.internal".into(),
            dest_port: 5432,
            auto_start: true,
        }
    }

    #[tokio::test]
    async fn stopping_remote_connections_closes_both_streams() {
        let board = Board {
            tunnels: Arc::default(),
            emit: Arc::new(|_| {}),
        };
        let reporter = board.reporter(Uuid::new_v4());
        let stopped = reporter.stopped.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = RemoteTarget {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            reporter,
        };
        let (channel, mut peer) = tokio::io::duplex(128);
        let task = tokio::spawn(serve_remote(target, channel));
        let (mut destination, _) = listener.accept().await.unwrap();
        peer.write_all(b"x").await.unwrap();
        let mut byte = [0u8; 1];
        destination.read_exact(&mut byte).await.unwrap();
        assert_eq!(byte, [b'x']);
        stopped.send_replace(true);
        tokio::time::timeout(std::time::Duration::from_secs(2), task)
            .await
            .expect("remote connection survived Stop")
            .unwrap();
        assert_eq!(peer.read(&mut byte).await.unwrap(), 0);
        assert_eq!(destination.read(&mut byte).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn late_remote_connections_do_not_reopen_a_stopped_tunnel() {
        let board = Board {
            tunnels: Arc::default(),
            emit: Arc::new(|_| {}),
        };
        let reporter = board.reporter(Uuid::new_v4());
        reporter.stopped.send_replace(true);
        let (channel, mut peer) = tokio::io::duplex(128);
        serve_remote(
            RemoteTarget {
                host: "127.0.0.1".into(),
                port: 1,
                reporter,
            },
            channel,
        )
        .await;
        assert_eq!(
            peer.read_u8().await.unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn validates_each_kind() {
        assert!(fwd(ForwardKind::Local).validate().is_ok());
        let mut d = fwd(ForwardKind::Dynamic);
        d.dest_host.clear();
        d.dest_port = 0;
        assert!(d.validate().is_ok());
        let mut l = fwd(ForwardKind::Local);
        l.dest_port = 0;
        assert!(l.validate().is_err());
        let mut r = fwd(ForwardKind::Remote);
        r.bind_port = 0; // the server picks one
        assert!(r.validate().is_ok());
        let mut l = fwd(ForwardKind::Local);
        l.bind_port = 0;
        assert!(l.validate().is_err());
    }

    #[test]
    fn saved_forwards_default_to_loopback_and_auto_start() {
        let f: Forward = serde_json::from_str(
            r#"{"id":"6f1c2c1e-1b7c-4c69-9c55-8c3c7f7e8a11","kind":"local","bindPort":8080,"destHost":"x","destPort":80}"#,
        )
        .unwrap();
        assert_eq!(f.bind_host, "127.0.0.1");
        assert!(f.auto_start);
    }

    #[test]
    fn bind_errors_are_explained() {
        let e = io::Error::from(io::ErrorKind::AddrInUse);
        assert_eq!(
            describe_bind_error("127.0.0.1", 8080, &e),
            "Port 8080 on 127.0.0.1 is already in use"
        );
    }

    #[tokio::test]
    async fn socks5_connect_by_name_and_by_address() {
        let (mut client, mut server) = tokio::io::duplex(256);
        let c = tokio::spawn(async move {
            client.write_all(&[5, 1, 0]).await.unwrap();
            let mut ok = [0u8; 2];
            client.read_exact(&mut ok).await.unwrap();
            assert_eq!(ok, [5, 0]);
            let mut req = vec![5, 1, 0, 3, 11];
            req.extend_from_slice(b"example.com");
            req.extend_from_slice(&443u16.to_be_bytes());
            client.write_all(&req).await.unwrap();
            client
        });
        assert_eq!(
            socks_request(&mut server).await.unwrap(),
            ("example.com".into(), 443)
        );
        c.await.unwrap();

        let (mut client, mut server) = tokio::io::duplex(256);
        tokio::spawn(async move {
            client
                .write_all(&[5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 22])
                .await
                .unwrap();
            let mut sink = Vec::new();
            let _ = client.read_to_end(&mut sink).await;
        });
        assert_eq!(
            socks_request(&mut server).await.unwrap(),
            ("10.0.0.7".into(), 22)
        );
    }

    #[tokio::test]
    async fn socks5_refuses_authentication_and_bind() {
        let (mut client, mut server) = tokio::io::duplex(256);
        tokio::spawn(async move {
            client.write_all(&[5, 1, 2]).await.unwrap(); // username/password only
            let mut reply = [0u8; 2];
            client.read_exact(&mut reply).await.unwrap();
            assert_eq!(reply, [5, 0xFF]);
        });
        assert!(socks_request(&mut server).await.is_err());

        let (mut client, mut server) = tokio::io::duplex(256);
        let c = tokio::spawn(async move {
            client
                .write_all(&[5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80])
                .await
                .unwrap();
            let mut buf = vec![0u8; 2 + 10];
            client.read_exact(&mut buf).await.unwrap();
            buf[3] // reply code
        });
        assert!(socks_request(&mut server).await.is_err());
        assert_eq!(c.await.unwrap(), 7);
    }
}
