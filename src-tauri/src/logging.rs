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
/// State is kept between chunks, so a sequence split across reads still works.
/// Cursor moves past this column are clamped, so a hostile server can't make
/// the log allocate a huge line.
const MAX_COL: usize = 4096;

struct Cleaner<W: Write> {
    out: W,
    line: Vec<char>,
    col: usize,
    err: Option<io::Error>,
}

impl<W: Write> Cleaner<W> {
    fn new(out: W) -> Self {
        Self {
            out,
            line: Vec::new(),
            col: 0,
            err: None,
        }
    }

    fn newline(&mut self) {
        let line: String = self.line.drain(..).collect();
        self.col = 0;
        if let Err(e) = writeln!(self.out, "{}", line.trim_end()) {
            self.err = Some(e);
        }
    }

    fn put_char(&mut self, c: char) {
        if self.col < self.line.len() {
            self.line[self.col] = c;
        } else {
            self.line.resize(self.col, ' ');
            self.line.push(c);
        }
        self.col += 1;
    }
}

impl<W: Write> Perform for Cleaner<W> {
    fn print(&mut self, c: char) {
        self.put_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' => self.newline(),
            b'\r' => self.col = 0,
            b'\t' => self.put_char('\t'),
            0x08 => self.col = self.col.saturating_sub(1),
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, _: &[u8], _: bool, action: char) {
        let first = params
            .iter()
            .next()
            .and_then(|p| p.first().copied())
            .unwrap_or(0) as usize;
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
            'G' => self.col = (first.max(1) - 1).min(MAX_COL),
            // Delete characters at the cursor.
            'P' => {
                let n = first.max(1).min(self.line.len().saturating_sub(self.col));
                self.line.drain(self.col..self.col + n);
            }
            _ => {}
        }
    }
}

pub struct SessionLog {
    path: PathBuf,
    parser: Parser,
    cleaner: Cleaner<BufWriter<File>>,
}

impl SessionLog {
    /// Creates `<dir>/<label>_<YYYY-MM-DD_HH-MM-SS>.log` and writes a header.
    pub fn create(dir: &Path, label: &str, host: &str, port: u16) -> io::Result<Self> {
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
        Ok(Self {
            path,
            parser: Parser::new(),
            cleaner: Cleaner::new(out),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write(&mut self, data: &[u8]) -> io::Result<()> {
        self.parser.advance(&mut self.cleaner, data);
        if let Some(e) = self.cleaner.err.take() {
            return Err(e);
        }
        self.cleaner.out.flush()
    }

    /// Writes any unfinished line and a footer.
    pub fn finish(mut self) -> io::Result<()> {
        if !self.cleaner.line.is_empty() {
            self.cleaner.newline();
        }
        writeln!(
            self.cleaner.out,
            "=== log closed {} ===",
            Local::now().format("%Y-%m-%d %H:%M:%S %z")
        )?;
        self.cleaner.out.flush()
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
        let mut c = Cleaner::new(Vec::new());
        for chunk in chunks {
            parser.advance(&mut c, chunk);
        }
        if !c.line.is_empty() {
            c.newline();
        }
        String::from_utf8(c.out).unwrap()
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
    fn file_names_are_safe_and_unique() {
        let dir = tempfile::tempdir().unwrap();
        let a = SessionLog::create(dir.path(), "Lab / kali-vm", "10.0.0.5", 22).unwrap();
        let b = SessionLog::create(dir.path(), "Lab / kali-vm", "10.0.0.5", 22).unwrap();
        let name = a.path().file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("Lab___kali-vm_"), "{name}");
        assert!(name.ends_with(".log"));
        assert_ne!(a.path(), b.path());
    }

    #[test]
    fn log_file_has_header_body_and_footer() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = SessionLog::create(dir.path(), "box", "h", 2222).unwrap();
        log.write(b"\x1b[1mhello\x1b[0m\r\nworld").unwrap();
        let path = log.path().to_path_buf();
        log.finish().unwrap();
        let text = fs::read_to_string(path).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert!(lines[0].starts_with("=== GhostKey session log: h:2222"));
        assert_eq!(&lines[1..3], &["hello", "world"]);
        assert!(lines[3].starts_with("=== log closed"));
    }
}
