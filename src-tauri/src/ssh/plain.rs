//! Terminals that aren't SSH: a local shell in a PTY, a serial port, and
//! Telnet. They share the SSH connection's commands and events, so the
//! frontend treats them like any other pane. Features that need SSH (files,
//! tunnels, tmux) answer that they aren't available here.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use super::{stop_log, tcp_connect, ConnCmd, ConnCtx, ConnEvent, Ended};
use crate::logging::LineLog;

/// What a pane connects to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    #[default]
    Ssh,
    Telnet,
    Serial,
    /// A shell on this computer.
    Local,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Parity {
    #[default]
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Flow {
    #[default]
    None,
    Software,
    Hardware,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialSettings {
    /// e.g. `/dev/ttyUSB0` or `COM3`.
    pub path: String,
    pub baud: u32,
    #[serde(default = "eight")]
    pub data_bits: u8,
    #[serde(default)]
    pub parity: Parity,
    #[serde(default = "one")]
    pub stop_bits: u8,
    #[serde(default)]
    pub flow: Flow,
}

fn eight() -> u8 {
    8
}
fn one() -> u8 {
    1
}

impl SerialSettings {
    pub fn check(&self) -> anyhow::Result<()> {
        if self.path.trim().is_empty() {
            anyhow::bail!("Choose a serial port");
        }
        if !(50..=4_000_000).contains(&self.baud) {
            anyhow::bail!("Speed must be between 50 and 4000000 baud");
        }
        if !(5..=8).contains(&self.data_bits) {
            anyhow::bail!("Data bits must be 5, 6, 7 or 8");
        }
        if !(1..=2).contains(&self.stop_bits) {
            anyhow::bail!("Stop bits must be 1 or 2");
        }
        Ok(())
    }
}

/// What a reader thread or task saw.
enum Io {
    Data(Vec<u8>),
    /// The other end finished normally (shell exited, server closed).
    End,
    /// The device or connection failed.
    Failed(String),
}

/// Runs the terminal loop shared by every non-SSH kind: output to the pane and
/// the log, input and resizes to `write` and `resize`.
async fn pump(
    ctx: &ConnCtx,
    cmds: &mut mpsc::UnboundedReceiver<ConnCmd>,
    mut output: mpsc::UnboundedReceiver<Io>,
    mut write: impl FnMut(Vec<u8>) -> bool,
    mut resize: impl FnMut(u32, u32),
    what: &str,
) -> Ended {
    let mut log = LineLog::default();
    log.set_width(ctx.req.cols as usize);
    if ctx.req.log {
        ctx.start_log(&mut log);
    }
    let unavailable = || anyhow::anyhow!("{what} doesn't support this; it needs SSH");
    let ended = loop {
        tokio::select! {
            msg = output.recv() => match msg {
                Some(Io::Data(data)) => {
                    if let Err(e) = log.feed(&data) {
                        ctx.log_error(format!("Logging stopped: {e}"));
                    }
                    (ctx.sinks.output)(data);
                }
                Some(Io::End) | None => break Ended::Closed,
                Some(Io::Failed(e)) => break Ended::Lost(Some(e)),
            },
            cmd = cmds.recv() => match cmd {
                Some(ConnCmd::Input(data)) => {
                    if !write(data) {
                        break Ended::Lost(Some(format!("Couldn't write to the {what}")));
                    }
                }
                Some(ConnCmd::Resize(cols, rows)) => {
                    log.set_width(cols as usize);
                    resize(cols, rows);
                }
                Some(ConnCmd::Probe) => {}
                Some(ConnCmd::StartLog) => ctx.start_log(&mut log),
                Some(ConnCmd::StopLog) => stop_log(ctx, &mut log),
                Some(ConnCmd::StartForward(_)) | Some(ConnCmd::StopForward(_)) => {}
                Some(ConnCmd::OpenSftp(reply)) => {
                    let _ = reply.send(Err(unavailable()));
                }
                Some(ConnCmd::ListTmux(reply)) => {
                    let _ = reply.send(Err(unavailable()));
                }
                Some(ConnCmd::Close) | None => break Ended::Closed,
            },
        }
    };
    stop_log(ctx, &mut log);
    ended
}

/// Feeds a blocking writer from a channel on its own thread, so input never blocks the loop.
fn writer_thread(mut w: Box<dyn Write + Send>) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in rx {
            if w.write_all(&data).and_then(|_| w.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

// ---------------------------------------------------------------- local shell

/// The shell to start when none is chosen: PowerShell on Windows, the login shell elsewhere.
fn default_shell() -> portable_pty::CommandBuilder {
    if cfg!(windows) {
        portable_pty::CommandBuilder::new("powershell.exe")
    } else {
        portable_pty::CommandBuilder::new_default_prog()
    }
}

pub(super) async fn run_local(
    ctx: &ConnCtx,
    cmds: &mut mpsc::UnboundedReceiver<ConnCmd>,
) -> anyhow::Result<Ended> {
    use portable_pty::{CommandBuilder, PtySize};
    let size = |cols: u32, rows: u32| PtySize {
        rows: rows.clamp(1, u16::MAX as u32) as u16,
        cols: cols.clamp(1, u16::MAX as u32) as u16,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = portable_pty::native_pty_system()
        .openpty(size(ctx.req.cols, ctx.req.rows))
        .map_err(|e| anyhow::anyhow!("Couldn't open a terminal: {e}"))?;
    let shell = ctx
        .req
        .shell
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let mut cmd = match shell {
        Some(program) => CommandBuilder::new(program),
        None => default_shell(),
    };
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        anyhow::anyhow!(
            "Couldn't start {}: {e}",
            shell.unwrap_or("the default shell")
        )
    })?;
    drop(pair.slave);
    let mut killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader()?;
    let writer = writer_thread(pair.master.take_writer()?);
    // Behind a lock so the resize closure can be shared across the loop's await points.
    let master = std::sync::Mutex::new(pair.master);

    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let reader_tx = out_tx.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if reader_tx.send(Io::Data(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });
    // The shell's exit ends the terminal, even where the PTY stays readable (Windows).
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = out_tx.send(Io::End);
    });

    ctx.sinks.event(ConnEvent::Connected);
    let ended = pump(
        ctx,
        cmds,
        out_rx,
        |data| writer.send(data).is_ok(),
        |cols, rows| {
            let _ = master.lock().unwrap().resize(size(cols, rows));
        },
        "local terminal",
    )
    .await;
    // Ends the shell and anything it started in the foreground; other terminals are untouched.
    let _ = killer.kill();
    drop(master);
    Ok(match ended {
        Ended::Lost(_) => Ended::Closed,
        e => e,
    })
}

// ---------------------------------------------------------------- serial

pub fn list_serial_ports() -> Vec<String> {
    let mut ports: Vec<String> = serialport::available_ports()
        .map(|p| p.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default();
    ports.sort();
    ports
}

pub(super) async fn run_serial(
    ctx: &ConnCtx,
    cmds: &mut mpsc::UnboundedReceiver<ConnCmd>,
) -> anyhow::Result<Ended> {
    let Some(s) = ctx.req.serial.clone() else {
        anyhow::bail!("No serial port was chosen");
    };
    s.check()?;
    ctx.status(format!("Opening {} at {} baud…", s.path, s.baud));
    let builder = serialport::new(s.path.clone(), s.baud)
        .data_bits(match s.data_bits {
            5 => serialport::DataBits::Five,
            6 => serialport::DataBits::Six,
            7 => serialport::DataBits::Seven,
            _ => serialport::DataBits::Eight,
        })
        .parity(match s.parity {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        })
        .stop_bits(if s.stop_bits == 2 {
            serialport::StopBits::Two
        } else {
            serialport::StopBits::One
        })
        .flow_control(match s.flow {
            Flow::None => serialport::FlowControl::None,
            Flow::Software => serialport::FlowControl::Software,
            Flow::Hardware => serialport::FlowControl::Hardware,
        })
        .timeout(Duration::from_millis(100));
    let port = tokio::task::spawn_blocking(move || builder.open())
        .await?
        .map_err(|e| anyhow::anyhow!("Couldn't open {}: {e}", s.path))?;
    let mut reader = port.try_clone()?;
    let writer = writer_thread(Box::new(port));
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while !stopped.load(Ordering::Relaxed) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => {
                    if out_tx.send(Io::Data(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => {
                    let _ =
                        out_tx.send(Io::Failed(format!("The serial port stopped working: {e}")));
                    break;
                }
            }
        }
    });
    ctx.sinks.event(ConnEvent::Connected);
    let ended = pump(
        ctx,
        cmds,
        out_rx,
        |data| writer.send(data).is_ok(),
        |_, _| {},
        "serial port",
    )
    .await;
    stop.store(true, Ordering::Relaxed);
    Ok(ended)
}

// ---------------------------------------------------------------- telnet

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;
const ECHO: u8 = 1;
const SGA: u8 = 3;
const TTYPE: u8 = 24;
const NAWS: u8 = 31;
const MAX_SUB: usize = 512;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum State {
    #[default]
    Data,
    Iac,
    Verb(u8),
    Sub,
    SubIac,
}

/// Telnet option negotiation (RFC 854/855). Accepts the server's echo and
/// suppress-go-ahead, offers the window size and terminal type, and refuses
/// everything else.
#[derive(Debug)]
pub struct Telnet {
    state: State,
    sub: Vec<u8>,
    /// Options the server has turned on (it WILL).
    remote: [bool; 256],
    /// Options we have turned on (we WILL).
    local: [bool; 256],
    cols: u16,
    rows: u16,
}

impl Telnet {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            state: State::Data,
            sub: Vec::new(),
            remote: [false; 256],
            local: [false; 256],
            cols,
            rows,
        }
    }

    /// Splits what the server sent into terminal output and replies to send back.
    pub fn feed(&mut self, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut out = Vec::with_capacity(input.len());
        let mut reply = Vec::new();
        for &b in input {
            self.state = match self.state {
                State::Data if b == IAC => State::Iac,
                State::Data => {
                    out.push(b);
                    State::Data
                }
                State::Iac => match b {
                    IAC => {
                        out.push(IAC);
                        State::Data
                    }
                    WILL | WONT | DO | DONT => State::Verb(b),
                    SB => {
                        self.sub.clear();
                        State::Sub
                    }
                    // GA, NOP and other one-byte commands.
                    _ => State::Data,
                },
                State::Verb(verb) => {
                    self.negotiate(verb, b, &mut reply);
                    State::Data
                }
                State::Sub if b == IAC => State::SubIac,
                State::Sub => {
                    if self.sub.len() < MAX_SUB {
                        self.sub.push(b);
                    }
                    State::Sub
                }
                State::SubIac if b == SE => {
                    self.subnegotiation(&mut reply);
                    State::Data
                }
                State::SubIac => {
                    if self.sub.len() < MAX_SUB {
                        self.sub.push(b);
                    }
                    State::Sub
                }
            };
        }
        (out, reply)
    }

    fn negotiate(&mut self, verb: u8, opt: u8, reply: &mut Vec<u8>) {
        let o = opt as usize;
        match verb {
            WILL => {
                let ok = matches!(opt, ECHO | SGA);
                if ok && !self.remote[o] {
                    self.remote[o] = true;
                    reply.extend([IAC, DO, opt]);
                } else if !ok {
                    reply.extend([IAC, DONT, opt]);
                }
            }
            WONT if self.remote[o] => {
                self.remote[o] = false;
                reply.extend([IAC, DONT, opt]);
            }
            DO => {
                let ok = matches!(opt, NAWS | TTYPE | SGA);
                if ok && !self.local[o] {
                    self.local[o] = true;
                    reply.extend([IAC, WILL, opt]);
                    if opt == NAWS {
                        reply.extend(self.window_size());
                    }
                } else if ok && opt == NAWS {
                    reply.extend(self.window_size());
                } else if !ok {
                    reply.extend([IAC, WONT, opt]);
                }
            }
            DONT if self.local[o] => {
                self.local[o] = false;
                reply.extend([IAC, WONT, opt]);
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        // TERMINAL-TYPE SEND (RFC 1091): answer IS xterm-256color.
        if self.sub.first() == Some(&TTYPE)
            && self.sub.get(1) == Some(&1)
            && self.local[TTYPE as usize]
        {
            reply.extend([IAC, SB, TTYPE, 0]);
            reply.extend_from_slice(b"XTERM-256COLOR");
            reply.extend([IAC, SE]);
        }
    }

    /// NAWS with the current size, when the server asked for it.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.cols = cols;
        self.rows = rows;
        if self.local[NAWS as usize] {
            self.window_size()
        } else {
            Vec::new()
        }
    }

    fn window_size(&self) -> Vec<u8> {
        let mut v = vec![IAC, SB, NAWS];
        for b in [self.cols.to_be_bytes(), self.rows.to_be_bytes()].concat() {
            v.push(b);
            if b == IAC {
                v.push(IAC);
            }
        }
        v.extend([IAC, SE]);
        v
    }

    /// Escapes keyboard input: IAC is doubled, and Enter (CR) becomes CR LF.
    pub fn encode_input(data: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(data.len() + 4);
        let mut i = 0;
        while i < data.len() {
            match data[i] {
                IAC => v.extend([IAC, IAC]),
                b'\r' => {
                    v.extend(b"\r\n");
                    // xterm never sends CR LF for Enter, but a paste might.
                    if data.get(i + 1) == Some(&b'\n') {
                        i += 1;
                    }
                }
                b => v.push(b),
            }
            i += 1;
        }
        v
    }
}

pub(super) async fn run_telnet(
    ctx: &ConnCtx,
    cmds: &mut mpsc::UnboundedReceiver<ConnCmd>,
) -> anyhow::Result<Ended> {
    let req = &ctx.req;
    ctx.status(format!("Connecting to {}:{} (Telnet)…", req.host, req.port));
    let stream = tcp_connect(ctx, &req.host, req.port).await?;
    let (mut rd, mut wr) = stream.into_split();
    let telnet = Arc::new(std::sync::Mutex::new(Telnet::new(
        req.cols.min(u16::MAX as u32) as u16,
        req.rows.min(u16::MAX as u32) as u16,
    )));
    let (send_tx, mut send_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(data) = send_rx.recv().await {
            if wr.write_all(&data).await.is_err() {
                break;
            }
        }
    });
    let (out_tx, out_rx) = mpsc::unbounded_channel();
    let reader_telnet = telnet.clone();
    let replies = send_tx.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) => {
                    let _ = out_tx.send(Io::End);
                    break;
                }
                Ok(n) => {
                    let (data, reply) = reader_telnet.lock().unwrap().feed(&buf[..n]);
                    if !reply.is_empty() {
                        let _ = replies.send(reply);
                    }
                    if !data.is_empty() && out_tx.send(Io::Data(data)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = out_tx.send(Io::Failed(format!("The connection was lost: {e}")));
                    break;
                }
            }
        }
    });
    ctx.sinks.event(ConnEvent::Connected);
    let input = send_tx.clone();
    let ended = pump(
        ctx,
        cmds,
        out_rx,
        |data| input.send(Telnet::encode_input(&data)).is_ok(),
        |cols, rows| {
            let naws = telnet.lock().unwrap().resize(
                cols.min(u16::MAX as u32) as u16,
                rows.min(u16::MAX as u32) as u16,
            );
            if !naws.is_empty() {
                let _ = send_tx.send(naws);
            }
        },
        "Telnet connection",
    )
    .await;
    Ok(ended)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telnet_negotiation_accepts_echo_and_offers_size_and_type() {
        let mut t = Telnet::new(80, 24);
        let (out, reply) = t.feed(&[b'h', IAC, WILL, ECHO, IAC, DO, NAWS, IAC, DO, 39, b'i']);
        assert_eq!(out, b"hi");
        assert_eq!(
            reply,
            [IAC, DO, ECHO, IAC, WILL, NAWS, IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE, IAC, WONT, 39]
        );
        // Repeated requests that change nothing get no reply, so negotiation can't loop.
        let (_, reply) = t.feed(&[IAC, WILL, ECHO]);
        assert!(reply.is_empty());
        // Terminal type, split across reads.
        let (_, r1) = t.feed(&[IAC, DO, TTYPE, IAC, SB, TTYPE]);
        assert_eq!(r1, [IAC, WILL, TTYPE]);
        let (_, r2) = t.feed(&[1, IAC, SE]);
        assert_eq!(&r2[..4], &[IAC, SB, TTYPE, 0]);
        assert!(r2.ends_with(&[IAC, SE]));
        // Resizes are sent once NAWS is on; 255 in a size is escaped.
        assert_eq!(
            t.resize(255, 40),
            [IAC, SB, NAWS, 0, IAC, IAC, 0, 40, IAC, SE]
        );
    }

    #[test]
    fn telnet_data_and_input_are_escaped() {
        let mut t = Telnet::new(80, 24);
        let (out, reply) = t.feed(&[b'a', IAC, IAC, b'b', IAC, 241, b'c']);
        assert_eq!(out, [b'a', 255, b'b', b'c']);
        assert!(reply.is_empty());
        assert_eq!(
            Telnet::encode_input(&[b'x', 255, b'\r']),
            [b'x', 255, 255, b'\r', b'\n']
        );
        assert_eq!(Telnet::encode_input(b"a\r\nb"), b"a\r\nb");
        // An endless subnegotiation is capped instead of growing without limit.
        let mut big = vec![IAC, SB, 99];
        big.extend(vec![b'x'; 10_000]);
        t.feed(&big);
        assert!(t.sub.len() <= MAX_SUB);
    }

    #[test]
    fn serial_settings_are_checked() {
        let ok = SerialSettings {
            path: "/dev/ttyUSB0".into(),
            baud: 115_200,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
            flow: Flow::None,
        };
        assert!(ok.check().is_ok());
        for bad in [
            SerialSettings {
                path: " ".into(),
                ..ok.clone()
            },
            SerialSettings {
                baud: 10,
                ..ok.clone()
            },
            SerialSettings {
                data_bits: 9,
                ..ok.clone()
            },
            SerialSettings {
                stop_bits: 3,
                ..ok.clone()
            },
        ] {
            assert!(bad.check().is_err());
        }
    }
}
