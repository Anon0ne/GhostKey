//! Session logs: what the server printed, as plain text with colors and
//! cursor movement removed, like PuTTY's "printable output" log.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use vte::{Params, Parser, Perform};

/// Turns a raw terminal stream into readable lines. It tracks the cursor
/// within the current line, so shell line editing (backspace, erase to end of
/// line, carriage-return redraws) logs the text as it ended up on screen.
/// A line longer than the terminal is one logical line made of several screen
/// rows; knowing the width lets carriage return and cursor-up act on the
/// current row, which is how shells redraw long command lines.
/// State is kept between chunks, so a sequence split across reads still works.
/// Lines are cut at this column, so a hostile server can't make the log
/// allocate a huge line.
const MAX_COL: usize = 4096;

struct Cleaner<W: Write> {
    /// Where finished lines go; None while not logging.
    out: Option<W>,
    line: Vec<char>,
    col: usize,
    /// Terminal width in columns; 0 when unknown.
    width: usize,
    /// The last character filled the row, and the cursor waits at its end
    /// until the next character wraps it.
    wrap_pending: bool,
    err: Option<io::Error>,
}

impl<W: Write> Cleaner<W> {
    fn new(out: Option<W>) -> Self {
        Self {
            out,
            line: Vec::new(),
            col: 0,
            width: 0,
            wrap_pending: false,
            err: None,
        }
    }

    fn newline(&mut self) {
        self.write_line();
        self.line.clear();
        self.col = 0;
        self.wrap_pending = false;
    }

    fn write_line(&mut self) {
        let Some(out) = self.out.as_mut() else { return };
        let line: String = self.line.iter().collect();
        if let Err(e) = writeln!(out, "{}", line.trim_end()) {
            self.err = Some(e);
        }
    }

    fn put_char(&mut self, c: char) {
        if self.col >= MAX_COL {
            return;
        }
        if self.col < self.line.len() {
            self.line[self.col] = c;
        } else {
            self.line.resize(self.col, ' ');
            self.line.push(c);
        }
        self.col += 1;
        self.wrap_pending = self.width > 0 && self.col % self.width == 0;
    }

    /// Where the cursor's screen row starts within the logical line.
    fn row_start(&self) -> usize {
        if self.width == 0 {
            return 0;
        }
        let at = if self.wrap_pending {
            self.col - 1
        } else {
            self.col
        };
        at - at % self.width
    }
}

impl<W: Write> Perform for Cleaner<W> {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' => self.newline(),
            b'\r' => self.col = self.row_start(),
            b'\t' => self.put_char('\t'),
            0x08 => {
                self.col = if self.wrap_pending {
                    self.col - 1
                } else {
                    self.col.saturating_sub(1)
                };
            }
            _ => {}
        }
        if byte != b'\t' {
            self.wrap_pending = false;
        }
    }

    fn csi_dispatch(&mut self, params: &Params, _: &[u8], _: bool, action: char) {
        let first = params
            .iter()
            .next()
            .and_then(|p| p.first().copied())
            .unwrap_or(0) as usize;
        let row = self.row_start();
        self.wrap_pending = false;
        match action {
            // Erase in line: 0 = to end, 1 = to start, 2 = whole line.
            'K' => match first {
                0 => self.line.truncate(self.col),
                1 => {
                    let end = self.col.min(self.line.len());
                    self.line[..end].fill(' ');
                }
                _ => self.line.clear(),
            },
            'C' => self.col = (self.col + first.max(1)).min(MAX_COL),
            'D' => self.col = self.col.saturating_sub(first.max(1)),
            'G' => self.col = (row + first.max(1) - 1).min(MAX_COL),
            // Cursor up: back to an earlier row of the same long line.
            'A' if self.width > 0 => {
                let up = first.max(1) * self.width;
                self.col = row.saturating_sub(up) + (self.col - row).min(self.width - 1);
            }
            // Delete characters at the cursor.
            'P' => {
                let n = first.max(1).min(self.line.len().saturating_sub(self.col));
                self.line.drain(self.col..self.col + n);
            }
            _ => {}
        }
    }
}

/// Follows a session's output for its whole life, and writes it to a file
/// while logging. Following it all the time means a log started mid-line,
/// usually right after the prompt, still knows where the cursor is.
pub struct LineLog {
    parser: Parser,
    cleaner: Cleaner<BufWriter<File>>,
    path: Option<PathBuf>,
}

impl Default for LineLog {
    fn default() -> Self {
        Self {
            parser: Parser::new(),
            cleaner: Cleaner::new(None),
            path: None,
        }
    }
}

impl LineLog {
    /// Tells the log the terminal width, so long wrapped lines log correctly.
    pub fn set_width(&mut self, cols: usize) {
        self.cleaner.width = cols.min(MAX_COL);
    }

    /// The file being written, if logging.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Starts writing to a new `<dir>/<label>_<YYYY-MM-DD_HH-MM-SS>.log`.
    pub fn start(&mut self, dir: &Path, label: &str, host: &str, port: u16) -> io::Result<PathBuf> {
        if let Some(path) = &self.path {
            return Ok(path.clone());
        }
        fs::create_dir_all(dir)?;
        let now = Local::now();
        let path = unique_path(dir, &file_stem(label, &now));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let mut out = BufWriter::new(file);
        writeln!(
            out,
            "=== GhostKey session log: {host}:{port}, started {} ===",
            now.format("%Y-%m-%d %H:%M:%S %z")
        )?;
        out.flush()?;
        self.cleaner.out = Some(out);
        self.path = Some(path.clone());
        Ok(path)
    }

    /// Follows more output. A write error stops logging and is returned;
    /// following goes on.
    pub fn feed(&mut self, data: &[u8]) -> io::Result<()> {
        self.parser.advance(&mut self.cleaner, data);
        let result = match (self.cleaner.err.take(), self.cleaner.out.as_mut()) {
            (Some(e), _) => Err(e),
            (None, Some(out)) => out.flush(),
            (None, None) => Ok(()),
        };
        if result.is_err() {
            self.cleaner.out = None;
            self.path = None;
        }
        result
    }

    /// Writes the unfinished line and a footer, and stops logging.
    pub fn stop(&mut self) -> io::Result<()> {
        if self.path.take().is_none() {
            return Ok(());
        }
        if !self.cleaner.line.is_empty() {
            self.cleaner.write_line();
        }
        let mut out = self.cleaner.out.take().expect("logging has a file");
        if let Some(e) = self.cleaner.err.take() {
            return Err(e);
        }
        writeln!(
            out,
            "=== log closed {} ===",
            Local::now().format("%Y-%m-%d %H:%M:%S %z")
        )?;
        out.flush()
    }
}

fn file_stem(label: &str, now: &DateTime<Local>) -> String {
    let clean: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim_matches(['_', '.']);
    let clean = if clean.is_empty() { "session" } else { clean };
    format!("{}_{}", clean, now.format("%Y-%m-%d_%H-%M-%S"))
}

fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.log"));
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| dir.join(format!("{stem}_{n}.log")))
        .find(|p| !p.exists())
        .expect("an unused file name")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(chunks: &[&[u8]]) -> String {
        let mut parser = Parser::new();
        let mut c = Cleaner::new(Some(Vec::new()));
        for chunk in chunks {
            parser.advance(&mut c, chunk);
        }
        if !c.line.is_empty() {
            c.newline();
        }
        String::from_utf8(c.out.unwrap()).unwrap()
    }

    #[test]
    fn strips_colors_and_keeps_text() {
        let raw: &[u8] = b"\x1b[32m\xe2\x94\x8c\xe2\x94\x80\xe2\x94\x80(\x1b[1;34mkali\xe3\x89\xbfkali\x1b[0m)\r\n\x1b[1;34mDesktop\x1b[0m\tnotes.txt\r\n";
        assert_eq!(clean(&[raw]), "┌──(kali㉿kali)\nDesktop\tnotes.txt\n");
    }

    #[test]
    fn handles_sequences_split_across_chunks() {
        assert_eq!(
            clean(&[b"ab\x1b[3", b"1mcd\x1b]0;title\x07ef\r\n"]),
            "abcdef\n"
        );
    }

    #[test]
    fn carriage_return_overwrites_and_backspace_erases() {
        assert_eq!(clean(&[b"10%\r50%\r100%\r\n"]), "100%\n");
        assert_eq!(clean(&[b"lsx\x08 \x08 -la\r\n"]), "ls -la\n");
        // How bash erases: back up, then erase to end of line.
        assert_eq!(clean(&[b"lsx\x08\x1b[K -la\r\n"]), "ls -la\n");
        assert_eq!(clean(&[b"abcdef\x1b[3D\x1b[P\r\n"]), "abcef\n");
    }

    #[test]
    fn long_lines_wrapped_by_the_shell_stay_whole() {
        let clean_at = |width: usize, raw: &[u8]| {
            let mut parser = Parser::new();
            let mut c = Cleaner::new(Some(Vec::new()));
            c.width = width;
            parser.advance(&mut c, raw);
            String::from_utf8(c.out.unwrap()).unwrap()
        };
        // Readline wraps at the margin with " \r" and keeps going on the next row.
        assert_eq!(
            clean_at(10, b"$ echo hel \rlo world\r\n"),
            "$ echo hello world\n"
        );
        // A carriage return on the second row only rewinds that row.
        assert_eq!(clean_at(5, b"abcdefgh\rXY\r\n"), "abcdeXYh\n");
        // Backspace from the pending-wrap position stays on the first row.
        assert_eq!(clean_at(4, b"abcd\x08X\r\n"), "abcX\n");
        // Cursor up returns to the first row of the same line.
        assert_eq!(clean_at(4, b"abcdef\x1b[A\rZ\r\n"), "Zbcdef\n");
    }

    #[test]
    fn huge_lines_are_cut() {
        let long = vec![b'x'; MAX_COL * 2];
        assert_eq!(clean(&[&long]).len(), MAX_COL + 1);
    }

    fn started(dir: &Path, label: &str) -> (LineLog, PathBuf) {
        let mut log = LineLog::default();
        let path = log.start(dir, label, "h", 2222).unwrap();
        (log, path)
    }

    #[test]
    fn file_names_are_safe_and_unique() {
        let dir = tempfile::tempdir().unwrap();
        let (_a, a) = started(dir.path(), "Lab / kali-vm");
        let (_b, b) = started(dir.path(), "Lab / kali-vm");
        let name = a.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("Lab___kali-vm_"), "{name}");
        assert!(name.ends_with(".log"));
        assert_ne!(a, b);
    }

    #[test]
    fn log_file_has_header_body_and_footer() {
        let dir = tempfile::tempdir().unwrap();
        let (mut log, path) = started(dir.path(), "box");
        log.feed(b"\x1b[1mhello\x1b[0m\r\nworld").unwrap();
        log.stop().unwrap();
        assert_eq!(log.path(), None);
        let text = fs::read_to_string(path).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert!(lines[0].starts_with("=== GhostKey session log: h:2222"));
        assert_eq!(&lines[1..3], &["hello", "world"]);
        assert!(lines[3].starts_with("=== log closed"));
    }

    #[test]
    fn log_started_after_the_prompt_keeps_the_whole_line() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = LineLog::default();
        log.set_width(29);
        // The prompt arrives before logging starts.
        log.feed(b"before\r\n\x1b[1;32mkali@vm\x1b[0m:~$ ").unwrap();
        let path = log.start(dir.path(), "box", "h", 22).unwrap();
        // Readline wraps the long command at the margin with " \r".
        log.feed(b"echo a long comman \rd here\r\nout\r\n").unwrap();
        log.stop().unwrap();
        let text = fs::read_to_string(path).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(
            &lines[1..3],
            &["kali@vm:~$ echo a long command here", "out"]
        );
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn stopping_and_starting_again_makes_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let (mut log, first) = started(dir.path(), "box");
        log.feed(b"one\r\n").unwrap();
        log.stop().unwrap();
        log.feed(b"not logged\r\n").unwrap();
        let second = log.start(dir.path(), "box", "h", 22).unwrap();
        log.feed(b"two\r\n").unwrap();
        log.stop().unwrap();
        assert_ne!(first, second);
        assert!(fs::read_to_string(&first).unwrap().contains("one"));
        let text = fs::read_to_string(&second).unwrap();
        assert!(text.contains("two") && !text.contains("not logged"));
    }
}
