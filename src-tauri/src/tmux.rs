//! tmux on the server: the command that attaches to (or creates) a named
//! session, and reading the list of sessions. Session names are checked and
//! quoted here, so nothing typed by the user reaches the shell unquoted.
//! GhostKey never kills a tmux session.

use serde::Serialize;

pub const MAX_NAME: usize = 64;

/// Whether `name` can be used as a tmux session name. tmux itself rewrites
/// `.` and `:`, so they're refused rather than silently changed.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '@' | '+' | '='))
}

/// Quotes `s` for a POSIX shell.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The command run instead of a login shell: attach to `name`, creating it if
/// needed. Without tmux, it says so and starts an ordinary login shell.
pub fn attach_command(name: &str) -> anyhow::Result<String> {
    if !valid_name(name) {
        anyhow::bail!(
            "\"{name}\" can't be a tmux session name. Use letters, digits, - and _ (at most {MAX_NAME})."
        );
    }
    Ok(format!(
        "if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s {}; \
         else echo 'GhostKey: tmux is not installed on this server, so this is an ordinary shell.'; \
         exec \"${{SHELL:-/bin/sh}}\" -l; fi",
        quote(name)
    ))
}

/// Lists sessions with fields separated by tabs. Prints `GK_NO_TMUX` when tmux
/// is missing; "no server running" just means there are no sessions.
pub const LIST_COMMAND: &str = "command -v tmux >/dev/null 2>&1 || { echo GK_NO_TMUX; exit 0; }; \
    tmux list-sessions -F '#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}' 2>/dev/null; exit 0";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub name: String,
    /// How many clients are attached now.
    pub attached: u32,
    pub windows: u32,
    /// Seconds since the Unix epoch.
    pub created: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TmuxList {
    pub installed: bool,
    pub sessions: Vec<TmuxSession>,
}

pub fn parse_list(output: &str) -> TmuxList {
    if output.lines().any(|l| l.trim() == "GK_NO_TMUX") {
        return TmuxList {
            installed: false,
            sessions: Vec::new(),
        };
    }
    let sessions = output
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\t');
            let name = f.next()?.to_string();
            let attached = f.next()?.trim().parse().ok()?;
            let windows = f.next()?.trim().parse().ok()?;
            let created = f.next().and_then(|c| c.trim().parse().ok());
            (!name.is_empty()).then_some(TmuxSession {
                name,
                attached,
                windows,
                created,
            })
        })
        .collect();
    TmuxList {
        installed: true,
        sessions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_checked_and_quoted() {
        assert!(valid_name("work"));
        assert!(valid_name("client-a_2"));
        for bad in [
            "",
            "a b",
            "a;b",
            "a'b",
            "x.y",
            "x:y",
            "$(id)",
            &"a".repeat(65),
        ] {
            assert!(!valid_name(bad), "{bad:?}");
            assert!(attach_command(bad).is_err());
        }
        let cmd = attach_command("work").unwrap();
        assert!(cmd.contains("tmux new-session -A -s 'work'"), "{cmd}");
        assert_eq!(quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn list_output_is_parsed() {
        let out = "work\t1\t3\t1700000000\nbuild\t0\t1\t1700000100\nnot a row\n";
        let list = parse_list(out);
        assert!(list.installed);
        assert_eq!(list.sessions.len(), 2);
        assert_eq!(
            list.sessions[0],
            TmuxSession {
                name: "work".into(),
                attached: 1,
                windows: 3,
                created: Some(1_700_000_000)
            }
        );
        assert!(!parse_list("GK_NO_TMUX\n").installed);
        assert!(parse_list("").sessions.is_empty());
    }
}
