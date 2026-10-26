import { Channel, invoke } from "@tauri-apps/api/core";

export type AuthMethod = "password" | "key";

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
}

export interface ConnectRequest {
  sessionId: string | null;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath: string | null;
  autoOpenTailscale: boolean;
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
  | { type: "closed"; error: string | null };

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
};
