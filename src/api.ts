import { Channel, invoke } from "@tauri-apps/api/core";
import type { Scan } from "./importPlan";
import type { Snippet } from "./snippets";
import type { Listing, TransferEvent } from "./files";
import type { Forward, TunnelStatus } from "./tunnels";
import type { Stage } from "./diagnostics";
import type { Environment } from "./hostLabels";
import type { Workspace } from "./workspace";
import type { TmuxList } from "./tmux";

export type AuthMethod = "password" | "key" | "agent";

export interface SavedSession {
  id: string;
  name: string;
  folder: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath: string | null;
  autoOpenTailscale: boolean;
  autoLog: boolean;
  /** Port forwards saved with the session. */
  forwards: Forward[];
  /** Another saved session to connect through first. */
  jumpSession: string | null;
  /** Labels for finding sessions. */
  tags: string[];
  environment: Environment;
  /** tmux session to attach to on connect; empty for a plain shell. */
  tmux: string;
}

export interface JumpRequest {
  sessionId: string | null;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath: string | null;
}

export interface ConnectRequest {
  sessionId: string | null;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath: string | null;
  autoOpenTailscale: boolean;
  /** Start a session log as soon as the shell opens. */
  log: boolean;
  /** Names the log file; usually the session's name. */
  label: string;
  /** Tunnels to start when the shell opens (those set to start automatically). */
  forwards: Forward[];
  /** Jump hosts to go through first, outermost first. Empty connects directly. */
  jumps: JumpRequest[];
  /** Attach to (or create) this tmux session instead of a plain shell. */
  tmux: string | null;
  cols: number;
  rows: number;
}

export interface BannerLink {
  url: string;
  tailscale: boolean;
}

export type Prompt =
  | { kind: "hostKey"; host: string; port: number; algorithm: string; fingerprint: string }
  | { kind: "password"; user: string; host: string; retry: boolean; canSave: boolean }
  | { kind: "passphrase"; keyPath: string; retry: boolean; canSave: boolean }
  | {
      kind: "keyboardInteractive";
      name: string;
      instructions: string;
      fields: { label: string; echo: boolean }[];
      canSave: boolean;
    };

export type ConnEvent =
  | { type: "status"; message: string }
  | { type: "banner"; text: string; links: BannerLink[]; autoOpened: string | null }
  | { type: "prompt"; id: number; prompt: Prompt }
  | { type: "connected" }
  | { type: "step"; stage: Stage; done: boolean; hop: string | null; detail: string | null }
  | { type: "logging"; path: string | null; error: string | null }
  | { type: "tunnels"; tunnels: TunnelStatus[] }
  | { type: "closed"; error: string | null; lost?: boolean; retryable?: boolean };

export interface PromptAnswer {
  accept: boolean;
  values: string[];
  save: boolean;
}

export const api = {
  listSessions: () => invoke<SavedSession[]>("list_sessions"),
  saveSession: (session: SavedSession) => invoke<void>("save_session", { session }),
  deleteSession: (id: string) => invoke<void>("delete_session", { id }),
  forgetSecrets: (id: string) => invoke<void>("forget_secrets", { id }),
  connect: (
    request: ConnectRequest,
    onEvent: (e: ConnEvent) => void,
    onOutput: (data: Uint8Array) => void,
  ) => {
    const events = new Channel<ConnEvent>();
    events.onmessage = onEvent;
    const output = new Channel<ArrayBuffer>();
    output.onmessage = (buf) => onOutput(new Uint8Array(buf));
    return invoke<number>("connect", { request, events, output });
  },
  sendInput: (id: number, data: string) => invoke<void>("send_input", { id, data }),
  resize: (id: number, cols: number, rows: number) => invoke<void>("resize", { id, cols, rows }),
  disconnect: (id: number) => invoke<void>("disconnect", { id }),
  answerPrompt: (id: number, answer: PromptAnswer) =>
    invoke<void>("answer_prompt", { id, answer }),
  openLink: (url: string) => invoke<void>("open_link", { url }),
  startLog: (id: number) => invoke<void>("start_log", { id }),
  stopLog: (id: number) => invoke<void>("stop_log", { id }),
  /** Checks every connection now, after sleep or a network change. */
  probeConnections: () => invoke<void>("probe_connections"),
  getLogDir: () => invoke<string>("get_log_dir"),
  setLogDir: (dir: string | null) => invoke<string>("set_log_dir", { dir }),
  openLogDir: () => invoke<void>("open_log_dir"),
  listSnippets: () => invoke<Snippet[]>("list_snippets"),
  saveSnippet: (snippet: Snippet) => invoke<void>("save_snippet", { snippet }),
  deleteSnippet: (id: string) => invoke<void>("delete_snippet", { id }),
  scanImports: () => invoke<Scan>("scan_imports"),
  scanSshConfig: (path: string) => invoke<Scan>("scan_ssh_config", { path }),
  sftpList: (id: number, path: string) => invoke<Listing>("sftp_list", { id, path }),
  sftpMkdir: (id: number, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpRename: (id: number, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpRemove: (id: number, path: string, dir: boolean) => invoke<void>("sftp_remove", { id, path, dir }),
  sftpExists: (id: number, path: string) => invoke<boolean>("sftp_exists", { id, path }),
  /** Starts a transfer and returns its id; progress and the result arrive on `onEvent`. */
  sftpTransfer: (
    id: number,
    t: { upload: boolean; local: string; remote: string; overwrite: boolean },
    onEvent: (e: TransferEvent) => void,
  ) => {
    const events = new Channel<TransferEvent>();
    events.onmessage = onEvent;
    return invoke<number>("sftp_transfer", { id, ...t, events });
  },
  startForward: (id: number, forward: Forward) => invoke<void>("start_forward", { id, forward }),
  stopForward: (id: number, forward: string) => invoke<void>("stop_forward", { id, forward }),
  sftpCancel: (transfer: number) => invoke<void>("sftp_cancel", { transfer }),
  localKind: (path: string) => invoke<"file" | "dir" | "missing">("local_kind", { path }),
  defaultDownloadDir: () => invoke<string | null>("default_download_dir"),
  keyInspect: (path: string, passphrase: string | null) => invoke<KeyInfo>("key_inspect", { path, passphrase }),
  keyGenerate: (path: string, kind: KeyKind, comment: string, passphrase: string | null) =>
    invoke<KeyInfo>("key_generate", { path, kind, comment, passphrase }),
  keyConvert: (from: string, passphrase: string | null, to: string, newPassphrase: string | null) =>
    invoke<KeyInfo>("key_convert", { from, passphrase, to, newPassphrase }),
  listWorkspaces: () => invoke<unknown[]>("list_workspaces"),
  saveWorkspace: (workspace: Workspace) => invoke<void>("save_workspace", { workspace }),
  deleteWorkspace: (id: string) => invoke<void>("delete_workspace", { id }),
  listTmux: (id: number) => invoke<TmuxList>("list_tmux", { id }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, text: string) => invoke<void>("write_text_file", { path, text }),
  agentStatus: () => invoke<AgentStatus>("agent_status"),
  agentAdd: (path: string, passphrase: string | null) => invoke<void>("agent_add", { path, passphrase }),
};

export type KeyKind = "ed25519" | "ecdsa256" | "rsa4096";

/** What a key file holds. Never includes private material. */
export interface KeyInfo {
  format: string;
  algorithm: string;
  bits: number | null;
  fingerprint: string;
  comment: string;
  encrypted: boolean;
  needsPassphrase: boolean;
  publicLine: string;
}

export interface AgentKey {
  algorithm: string;
  bits: number | null;
  fingerprint: string;
  comment: string;
  certificate: boolean;
}

export interface AgentStatus {
  kind: string | null;
  error: string | null;
  keys: AgentKey[];
}
