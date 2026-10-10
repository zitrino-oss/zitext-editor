//! The large file and log viewer.
//!
//! The editor loads a whole document into memory, which caps it at a few
//! megabytes. The viewer instead keeps the file open and builds a sparse line
//! index in the background (the byte offset of every 512th line), so any line
//! can be reached by seeking to the nearest checkpoint and reading forward.
//! Filters, searches, time lookups and exports all stream the file a piece at a
//! time, so memory use stays small however large the file is.
//!
//! Log files grow and get rotated while they are being watched. A refresh
//! re-checks the path: appended data is indexed (and filtered) incrementally,
//! and a replaced or truncated file is reopened and indexed from the start.

use crate::{
    authorize_path, canonical_form, clean_path, file_identity, open_regular_file_any_size,
    persist_with_retry, sweep_stale_temp_files, FILE_WRITE_LOCK, TEMP_WRITE_PREFIX,
};
use regex::bytes::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering as CmpOrdering;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

/// Lines between two index checkpoints. Reaching any line costs one seek and
/// at most this many line skips, while the index stays tiny (8 bytes per 512
/// lines, about 2 MB for a billion lines).
const CHECKPOINT_LINES: u64 = 512;
/// Read size for indexing, filtering and other whole-file scans.
const SCAN_CHUNK: usize = 1 << 20;
/// Read size for the small, scattered reads behind scrolling.
const READ_BUFFER: usize = 64 * 1024;
/// A line is shown with at most this many characters; longer lines are cut
/// so a single minified or binary line can't stall the renderer.
const MAX_DISPLAY_CHARS: usize = 16_384;
/// Bytes of a line kept for display. Every character is at most 4 bytes, so
/// this always holds the first `MAX_DISPLAY_CHARS` characters; the rest of the
/// line is skipped without being kept.
const DISPLAY_KEEP: usize = 64 * 1024;
/// Filters and searches match on at most this much of each line, so a
/// pathological multi-gigabyte line can't exhaust memory.
const MATCH_KEEP: usize = 1 << 20;
/// Timestamps are looked for only near the start of a line.
const TIMESTAMP_START_BYTES: usize = 64;
/// Room for a timestamp that starts near the end of that window.
const TIMESTAMP_KEEP: usize = TIMESTAMP_START_BYTES + 40;
/// Lines after a checkpoint that may be checked for a timestamp when a time
/// lookup samples that block.
const TIMESTAMP_SAMPLE_LINES: u64 = 64;
const MAX_SESSIONS: usize = 8;
const MAX_LINES_PER_REQUEST: u32 = 1000;
const MAX_EXPORT_LINE_LIST: usize = 100_000;
/// Appends larger than this are indexed in the background so a refresh call
/// returns quickly; smaller ones are indexed before it returns.
const BACKGROUND_APPEND_BYTES: u64 = 8 << 20;
const SEARCH_TIME_BUDGET: Duration = Duration::from_secs(5);
/// Go to time gives up after this long (a file without readable timestamps,
/// or not in time order, would otherwise be read to the end).
const TIME_SEARCH_BUDGET: Duration = Duration::from_secs(10);
/// Most matching lines a filter keeps (4 bytes each, so about 40 MB). An
/// exclude-only filter on a huge log can otherwise keep nearly every line.
const MAX_FILTER_MATCHES: usize = 10_000_000;
/// Tests lower the limit to reach it with a small file.
static FILTER_MATCH_LIMIT: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(MAX_FILTER_MATCHES);
/// How often a filter waiting for the indexer checks again.
const FILTER_WAIT: Duration = Duration::from_millis(20);
/// Size limits for compiled patterns, so a hostile pattern can't make the
/// regex engine allocate without bound.
const REGEX_SIZE_LIMIT: usize = 10 << 20;

const NOT_OPEN: &str = "This file is no longer open in the viewer.";
const TOO_MANY_OPEN: &str = "Too many large files are open. Close one first.";
const BAD_TIME: &str = "Couldn't read that time. Use a format like 2026-10-07 14:30:00.";
const TIME_SEARCH_TOO_LONG: &str = "Looking for that time took too long. The file may have no timestamps ZITEXT can read, or may not be in time order.";
const SAME_AS_SOURCE: &str = "Choose a different file than the one being viewed.";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileStatus {
    pub id: u64,
    pub path: String,
    pub size: u64,
    pub indexed_bytes: u64,
    pub line_count: u64,
    pub indexing: bool,
    pub rotations: u32,
    pub missing: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub number: u64,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRule {
    pub pattern: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineFilter {
    #[serde(default)]
    pub include: Vec<LineRule>,
    #[serde(default)]
    pub exclude: Vec<LineRule>,
    #[serde(default)]
    pub match_all: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FilterStatus {
    pub active: bool,
    pub matched: u64,
    pub scanned_lines: u64,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub line: Option<u64>,
    /// Set when the time budget ran out before a match: searching again from
    /// this line continues where this search stopped.
    pub stopped_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExportSelection {
    All,
    Filtered,
    Range { start: u64, end: u64 },
    Matching { rules: Vec<LineRule> },
    Lines { lines: Vec<u64> },
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// The line index of one opened file.
///
/// `indexed_bytes` only grows while the same file is open; a refresh raises
/// `target` and the indexer catches up to it.
#[derive(Debug)]
struct LineIndex {
    /// `checkpoints[k]` is the byte offset where line `k * CHECKPOINT_LINES`
    /// starts.
    checkpoints: Vec<u64>,
    /// Lines ended by a newline so far.
    terminated_lines: u64,
    /// Where the line after the last newline starts.
    last_line_start: u64,
    indexed_bytes: u64,
    /// The file size the index is working towards (the last size seen).
    target: u64,
    indexing: bool,
    error: Option<String>,
}

impl LineIndex {
    fn new(target: u64) -> Self {
        LineIndex {
            checkpoints: vec![0],
            terminated_lines: 0,
            last_line_start: 0,
            indexed_bytes: 0,
            target,
            indexing: target > 0,
            error: None,
        }
    }

    /// Records the line starts in `chunk`, which begins at `chunk_offset`
    /// (always the current `indexed_bytes`).
    fn add(&mut self, chunk: &[u8], chunk_offset: u64) {
        let mut from = 0;
        while let Some(found) = chunk[from..].iter().position(|&b| b == b'\n') {
            let newline = from + found;
            self.terminated_lines += 1;
            self.last_line_start = chunk_offset + newline as u64 + 1;
            if self.terminated_lines.is_multiple_of(CHECKPOINT_LINES) {
                self.checkpoints.push(self.last_line_start);
            }
            from = newline + 1;
        }
        self.indexed_bytes = chunk_offset + chunk.len() as u64;
    }

    /// The end of the data that can be read as whole lines. While indexing is
    /// behind, the bytes after the last newline may be the middle of a line
    /// cut by a read, so they are left out until the index reaches the end.
    fn readable_end(&self) -> u64 {
        if self.indexed_bytes >= self.target {
            self.indexed_bytes
        } else {
            self.last_line_start
        }
    }

    /// Lines readable now. An unterminated last line counts once the index
    /// has reached the end of the file.
    fn line_count(&self) -> u64 {
        let tail = self.readable_end() > self.last_line_start;
        self.terminated_lines + u64::from(tail)
    }
}

/// One opened instance of the file. A rotation replaces it with a new one, so
/// work running against the old file (index, filter) never mixes the two.
struct Epoch {
    file: File,
    identity: String,
    index: Mutex<LineIndex>,
    /// Stops the indexer when the file is rotated or the viewer closed.
    cancel: AtomicBool,
}

impl Epoch {
    fn new(file: File, identity: String, size: u64) -> Self {
        Epoch {
            file,
            identity,
            index: Mutex::new(LineIndex::new(size)),
            cancel: AtomicBool::new(false),
        }
    }

    /// The readable end and line count, read together.
    fn snapshot(&self) -> (u64, u64) {
        let index = lock(&self.index);
        (index.readable_end(), index.line_count())
    }

    fn checkpoint(&self, block: u64) -> Option<u64> {
        let index = lock(&self.index);
        usize::try_from(block)
            .ok()
            .and_then(|block| index.checkpoints.get(block).copied())
    }
}

struct CompiledFilter {
    include: Vec<Regex>,
    exclude: Vec<Regex>,
    match_all: bool,
}

impl CompiledFilter {
    fn matches(&self, line: &[u8]) -> bool {
        let included = self.include.is_empty()
            || if self.match_all {
                self.include.iter().all(|rule| rule.is_match(line))
            } else {
                self.include.iter().any(|rule| rule.is_match(line))
            };
        included && !self.exclude.iter().any(|rule| rule.is_match(line))
    }
}

#[derive(Default)]
struct FilterProgress {
    /// Matching line numbers among the lines ended by a newline.
    matches: Vec<u32>,
    /// Byte offset just past the last newline-ended line scanned.
    consumed: u64,
    /// Newline-ended lines scanned.
    complete_lines: u64,
    /// The readable end the last scan pass reached.
    scanned_end: u64,
    /// Whether the unterminated last line (if any) matched. It is checked
    /// again when appended data extends it.
    tail: Option<bool>,
    done: bool,
    error: Option<String>,
}

impl FilterProgress {
    fn status(&self) -> FilterStatus {
        FilterStatus {
            active: true,
            matched: self.matches.len() as u64 + u64::from(self.tail == Some(true)),
            scanned_lines: self.complete_lines + u64::from(self.tail.is_some()),
            done: self.done,
            error: self.error.clone(),
        }
    }

    /// Every matching line number, including a matching unterminated line.
    fn matched_line(&self, position: u64) -> Option<u64> {
        let stored = self.matches.len() as u64;
        if position < stored {
            Some(u64::from(self.matches[position as usize]))
        } else if position == stored && self.tail == Some(true) {
            Some(self.complete_lines)
        } else {
            None
        }
    }
}

/// One run of a filter over one epoch. Replacing the filter, rotating the
/// file or closing the viewer cancels it.
struct FilterJob {
    filter: Arc<CompiledFilter>,
    epoch: Arc<Epoch>,
    cancel: AtomicBool,
    progress: Mutex<FilterProgress>,
}

impl FilterJob {
    fn new(filter: Arc<CompiledFilter>, epoch: Arc<Epoch>) -> Arc<Self> {
        Arc::new(FilterJob {
            filter,
            epoch,
            cancel: AtomicBool::new(false),
            progress: Mutex::new(FilterProgress::default()),
        })
    }
}

struct SessionState {
    epoch: Arc<Epoch>,
    filter: Option<Arc<FilterJob>>,
    rotations: u32,
    missing: bool,
    error: Option<String>,
}

/// Lock order: `state`, then an epoch's `index`, then a filter's `progress`.
struct Session {
    path: PathBuf,
    state: Mutex<SessionState>,
}

struct Registry {
    next_id: u64,
    sessions: HashMap<u64, Arc<Session>>,
}

static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();

fn registry() -> &'static Mutex<Registry> {
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            next_id: 0,
            sessions: HashMap::new(),
        })
    })
}

/// A panic in one viewer thread must not make every later call fail, and all
/// data behind these locks stays consistent between statements.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn session(id: u64) -> Result<Arc<Session>, String> {
    lock(registry())
        .sessions
        .get(&id)
        .cloned()
        .ok_or_else(|| NOT_OPEN.to_string())
}

fn current_epoch(session: &Session) -> Arc<Epoch> {
    lock(&session.state).epoch.clone()
}

fn read_error(error: io::Error) -> String {
    format!("Couldn't read the file: {error}")
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Reads at an offset without moving a shared file cursor, so the indexer,
/// a filter and the renderer's reads can use one handle at the same time.
#[cfg(unix)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buf, offset)
}

#[cfg(windows)]
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    // seek_read moves the cursor, but every read here is positional, so
    // nothing depends on where it is.
    std::os::windows::fs::FileExt::seek_read(file, buf, offset)
}

#[cfg(not(any(unix, windows)))]
fn read_at(_file: &File, _buf: &mut [u8], _offset: u64) -> io::Result<usize> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "positional reads are not supported on this platform",
    ))
}

/// Fills `buf` from `offset`, stopping early only at the end of the file.
fn read_full_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match read_at(file, &mut buf[filled..], offset + filled as u64) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

/// Where one line lies in the file.
#[derive(Debug, Clone, Copy)]
struct LineMeta {
    start: u64,
    /// Length including the terminator.
    raw_len: u64,
    /// Length without the `\n` or `\r\n` terminator.
    content_len: u64,
    terminated: bool,
}

/// Reads lines forward from an offset, keeping at most `keep` bytes of each
/// line's text in memory (the rest is scanned past, never kept).
struct LineScanner<'a> {
    file: &'a File,
    buf: Vec<u8>,
    /// File offset of `buf[0]`.
    buf_offset: u64,
    pos: usize,
    len: usize,
    end: u64,
    keep: usize,
    /// The start of the current line, terminator included, up to `keep + 2`
    /// bytes (enough to see a `\r\n` right after the kept text).
    raw: Vec<u8>,
}

impl<'a> LineScanner<'a> {
    fn new(file: &'a File, offset: u64, end: u64, buffer: usize, keep: usize) -> Self {
        LineScanner {
            file,
            buf: vec![0; buffer],
            buf_offset: offset,
            pos: 0,
            len: 0,
            end,
            keep,
            raw: Vec::new(),
        }
    }

    fn next_line(&mut self) -> io::Result<Option<LineMeta>> {
        self.raw.clear();
        let start = self.buf_offset + self.pos as u64;
        let cap = self.keep + 2;
        let mut raw_len = 0u64;
        let mut last_content_byte = None;
        let mut terminated = false;
        loop {
            if self.pos == self.len {
                let next = self.buf_offset + self.len as u64;
                if next >= self.end {
                    break;
                }
                let want = (self.end - next).min(self.buf.len() as u64) as usize;
                let read = read_full_at(self.file, &mut self.buf[..want], next)?;
                self.buf_offset = next;
                self.pos = 0;
                self.len = read;
                if read == 0 {
                    // The file is shorter than expected (truncated while
                    // being read): treat this as its end.
                    self.end = next;
                    break;
                }
            }
            let available = &self.buf[self.pos..self.len];
            let newline = available.iter().position(|&b| b == b'\n');
            let take = newline.map_or(available.len(), |at| at + 1);
            let segment = &available[..take];
            if self.raw.len() < cap {
                let room = cap - self.raw.len();
                self.raw.extend_from_slice(&segment[..take.min(room)]);
            }
            let content = if newline.is_some() {
                &segment[..take - 1]
            } else {
                segment
            };
            if let Some(&byte) = content.last() {
                last_content_byte = Some(byte);
            }
            raw_len += take as u64;
            self.pos += take;
            if newline.is_some() {
                terminated = true;
                break;
            }
        }
        if raw_len == 0 {
            return Ok(None);
        }
        let content_len = if terminated {
            raw_len - 1 - u64::from(last_content_byte == Some(b'\r'))
        } else {
            raw_len
        };
        Ok(Some(LineMeta {
            start,
            raw_len,
            content_len,
            terminated,
        }))
    }

    /// The kept text of the line, without its terminator.
    fn content(&self, line: &LineMeta) -> &[u8] {
        let len = (line.content_len as usize)
            .min(self.keep)
            .min(self.raw.len());
        &self.raw[..len]
    }

    /// The whole line with its terminator, when it fit in memory.
    fn raw_line(&self, line: &LineMeta) -> Option<&[u8]> {
        usize::try_from(line.raw_len)
            .ok()
            .filter(|&len| len <= self.raw.len())
            .map(|len| &self.raw[..len])
    }
}

/// Walks the lines of an epoch by number, using the checkpoints to jump.
struct LineCursor<'a> {
    epoch: &'a Epoch,
    end: u64,
    count: u64,
    keep: usize,
    buffer: usize,
    scanner: Option<LineScanner<'a>>,
    /// The number of the line the scanner returns next.
    next_number: u64,
}

impl<'a> LineCursor<'a> {
    fn new(epoch: &'a Epoch, keep: usize, buffer: usize) -> Self {
        let (end, count) = epoch.snapshot();
        LineCursor {
            epoch,
            end,
            count,
            keep,
            buffer,
            scanner: None,
            next_number: 0,
        }
    }

    /// Positions the cursor so `next` returns line `target`. False when the
    /// line is past the readable lines.
    fn seek(&mut self, target: u64) -> Result<bool, String> {
        if target >= self.count {
            return Ok(false);
        }
        let block = target / CHECKPOINT_LINES;
        let block_start = block * CHECKPOINT_LINES;
        let reuse =
            self.scanner.is_some() && self.next_number <= target && block_start <= self.next_number;
        if !reuse {
            let Some(offset) = self.epoch.checkpoint(block) else {
                return Ok(false);
            };
            self.scanner = Some(LineScanner::new(
                &self.epoch.file,
                offset,
                self.end,
                self.buffer,
                self.keep,
            ));
            self.next_number = block_start;
        }
        while self.next_number < target {
            if self.next()?.is_none() {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn next(&mut self) -> Result<Option<(u64, LineMeta)>, String> {
        if self.next_number >= self.count {
            return Ok(None);
        }
        if self.scanner.is_none() && !self.seek(self.next_number)? {
            return Ok(None);
        }
        let Some(scanner) = self.scanner.as_mut() else {
            return Ok(None);
        };
        match scanner.next_line().map_err(read_error)? {
            Some(line) => {
                let number = self.next_number;
                self.next_number += 1;
                Ok(Some((number, line)))
            }
            None => Ok(None),
        }
    }

    fn scanner(&self) -> &LineScanner<'a> {
        self.scanner
            .as_ref()
            .expect("a line was just read, so the scanner exists")
    }
}

/// Lossy UTF-8 text of a line, cut to `MAX_DISPLAY_CHARS` characters.
fn display_line(number: u64, content: &[u8], content_len: u64) -> LogLine {
    let mut truncated = content_len > content.len() as u64;
    let text = String::from_utf8_lossy(content);
    let text = match text.char_indices().nth(MAX_DISPLAY_CHARS) {
        Some((cut, _)) => {
            truncated = true;
            text[..cut].to_string()
        }
        None => text.into_owned(),
    };
    LogLine {
        number,
        text,
        truncated,
    }
}

/// Reads the given line numbers (ascending) for display.
fn read_display_lines(
    epoch: &Epoch,
    numbers: impl IntoIterator<Item = u64>,
) -> Result<Vec<LogLine>, String> {
    let mut cursor = LineCursor::new(epoch, DISPLAY_KEEP, READ_BUFFER);
    let mut lines = Vec::new();
    for number in numbers {
        if !cursor.seek(number)? {
            break;
        }
        let Some((number, line)) = cursor.next()? else {
            break;
        };
        lines.push(display_line(
            number,
            cursor.scanner().content(&line),
            line.content_len,
        ));
    }
    Ok(lines)
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/// Indexes the epoch up to its target, then clears `indexing`. The caller
/// must have set `indexing` (which makes it the only indexer of the epoch).
fn run_indexer(epoch: &Epoch) {
    let mut buf = vec![0u8; SCAN_CHUNK];
    loop {
        let (start, want) = {
            let mut index = lock(&epoch.index);
            if epoch.cancel.load(Ordering::Relaxed) || index.indexed_bytes >= index.target {
                index.indexing = false;
                return;
            }
            let want = (index.target - index.indexed_bytes).min(SCAN_CHUNK as u64);
            (index.indexed_bytes, want as usize)
        };
        let result = read_full_at(&epoch.file, &mut buf[..want], start);
        let mut index = lock(&epoch.index);
        match result {
            Ok(0) => {
                // The file ended earlier than its size said. The next
                // refresh sees the smaller size and treats it as a rotation.
                index.target = index.indexed_bytes;
                index.indexing = false;
                return;
            }
            Ok(read) => index.add(&buf[..read], start),
            Err(error) => {
                index.error = Some(read_error(error));
                index.indexing = false;
                return;
            }
        }
    }
}

/// Starts indexing an epoch in the background, if it has anything to index.
fn spawn_indexer(epoch: &Arc<Epoch>) {
    if !lock(&epoch.index).indexing {
        return;
    }
    let worker = epoch.clone();
    let spawned = std::thread::Builder::new()
        .name("large-file-index".into())
        .spawn(move || run_indexer(&worker));
    if let Err(error) = spawned {
        let mut index = lock(&epoch.index);
        index.indexing = false;
        index.error = Some(format!("Couldn't start indexing the file: {error}"));
    }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

fn compile_rule(rule: &LineRule) -> Result<Option<Regex>, String> {
    if rule.pattern.is_empty() {
        return Ok(None);
    }
    let pattern = if rule.regex {
        rule.pattern.clone()
    } else {
        regex::escape(&rule.pattern)
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!rule.case_sensitive)
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_SIZE_LIMIT)
        .build()
        .map(Some)
        .map_err(|error| error.to_string())
}

fn compile_rules(rules: &[LineRule]) -> Result<Vec<Regex>, String> {
    let mut compiled = Vec::new();
    for rule in rules {
        if let Some(regex) = compile_rule(rule)? {
            compiled.push(regex);
        }
    }
    Ok(compiled)
}

/// None when every pattern is empty: such a filter would keep every line.
fn compile_filter(filter: &LineFilter) -> Result<Option<CompiledFilter>, String> {
    let include = compile_rules(&filter.include)?;
    let exclude = compile_rules(&filter.exclude)?;
    if include.is_empty() && exclude.is_empty() {
        return Ok(None);
    }
    Ok(Some(CompiledFilter {
        include,
        exclude,
        match_all: filter.match_all,
    }))
}

fn too_many_lines_to_filter() -> String {
    format!(
        "This file has more than {} lines, which is too many to filter.",
        u32::MAX
    )
}

/// Scans the lines from the filter's last newline-ended line up to
/// `frontier`, publishing matches about every megabyte.
fn filter_pass(job: &FilterJob, frontier: u64) -> Result<(), String> {
    let (start, mut line_number) = {
        let progress = lock(&job.progress);
        (progress.consumed, progress.complete_lines)
    };
    let mut scanner = LineScanner::new(&job.epoch.file, start, frontier, SCAN_CHUNK, MATCH_KEEP);
    let stored = lock(&job.progress).matches.len();
    let mut batch = Vec::new();
    let mut consumed = start;
    let mut published_at = start;
    let mut tail = None;
    while let Some(line) = scanner.next_line().map_err(read_error)? {
        if job.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let number = u32::try_from(line_number).map_err(|_| too_many_lines_to_filter())?;
        let matched = job.filter.matches(scanner.content(&line));
        if !line.terminated {
            tail = Some(matched);
            break;
        }
        if matched {
            let limit = FILTER_MATCH_LIMIT.load(Ordering::Relaxed);
            if stored + batch.len() >= limit {
                // Keep what was found (it can still be viewed and exported)
                // and stop: the rest would only grow memory without bound.
                let mut progress = lock(&job.progress);
                progress.matches.append(&mut batch);
                progress.consumed = consumed;
                progress.complete_lines = line_number;
                progress.tail = None;
                progress.scanned_end = frontier;
                return Err(format!(
                    "More than {limit} lines match, so only the first {limit} are shown. Narrow the filter to see the rest."
                ));
            }
            batch.push(number);
        }
        line_number += 1;
        consumed = line.start + line.raw_len;
        if consumed - published_at >= SCAN_CHUNK as u64 {
            let mut progress = lock(&job.progress);
            progress.matches.append(&mut batch);
            progress.consumed = consumed;
            progress.complete_lines = line_number;
            // The previous pass's unterminated line was the first line of
            // this pass, so it is now counted among the complete lines.
            progress.tail = None;
            published_at = consumed;
        }
    }
    let mut progress = lock(&job.progress);
    progress.matches.append(&mut batch);
    progress.consumed = consumed;
    progress.complete_lines = line_number;
    progress.tail = tail;
    progress.scanned_end = frontier;
    Ok(())
}

/// Runs a filter until it has caught up with the index and the index is not
/// working, then marks it done. A refresh that adds lines restarts it.
fn run_filter(job: &FilterJob) {
    loop {
        if job.cancel.load(Ordering::Relaxed) {
            return;
        }
        let frontier = lock(&job.epoch.index).readable_end();
        let scanned_end = lock(&job.progress).scanned_end;
        if frontier > scanned_end {
            if let Err(error) = filter_pass(job, frontier) {
                let mut progress = lock(&job.progress);
                progress.error = Some(error);
                progress.done = true;
                return;
            }
            continue;
        }
        {
            // Decided under the index lock, so a refresh that raises the
            // target either sees `done` and restarts this filter, or is seen
            // here as indexing.
            let index = lock(&job.epoch.index);
            if !index.indexing && index.readable_end() == frontier {
                lock(&job.progress).done = true;
                return;
            }
        }
        std::thread::sleep(FILTER_WAIT);
    }
}

fn spawn_filter(job: Arc<FilterJob>) {
    let worker = job.clone();
    let spawned = std::thread::Builder::new()
        .name("large-file-filter".into())
        .spawn(move || run_filter(&worker));
    if let Err(error) = spawned {
        let mut progress = lock(&job.progress);
        progress.error = Some(format!("Couldn't start the filter: {error}"));
        progress.done = true;
    }
}

/// Restarts a finished filter so it covers lines added since it finished.
fn resume_filter(session: &Session) {
    let Some(job) = lock(&session.state).filter.clone() else {
        return;
    };
    {
        let mut progress = lock(&job.progress);
        if !progress.done || progress.error.is_some() || job.cancel.load(Ordering::Relaxed) {
            return;
        }
        progress.done = false;
    }
    spawn_filter(job);
}

fn inactive_filter() -> FilterStatus {
    FilterStatus {
        active: false,
        matched: 0,
        scanned_lines: 0,
        done: true,
        error: None,
    }
}

fn filter_status_of(state: &SessionState) -> FilterStatus {
    match &state.filter {
        Some(job) => lock(&job.progress).status(),
        None => inactive_filter(),
    }
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/// A timestamp as written in a log line. Time zones are ignored: lines of one
/// log are compared with each other as written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TimeKey {
    year: Option<u16>,
    month: u8,
    day: u8,
    seconds: u32,
    millis: u16,
}

impl TimeKey {
    /// Syslog lines carry no year; when either side lacks one, the year is
    /// left out of the comparison.
    fn compare(&self, other: &TimeKey) -> CmpOrdering {
        let rest = |key: &TimeKey| (key.month, key.day, key.seconds, key.millis);
        match (self.year, other.year) {
            (Some(left), Some(right)) => (left, rest(self)).cmp(&(right, rest(other))),
            _ => rest(self).cmp(&rest(other)),
        }
    }
}

const MONTHS: [&[u8; 3]; 12] = [
    b"jan", b"feb", b"mar", b"apr", b"may", b"jun", b"jul", b"aug", b"sep", b"oct", b"nov", b"dec",
];

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn byte(&mut self, expected: u8) -> Option<()> {
        (self.peek()? == expected).then(|| self.at += 1)
    }

    fn one_of(&mut self, choices: &[u8]) -> Option<()> {
        choices.contains(&self.peek()?).then(|| self.at += 1)
    }

    /// Exactly `count` ASCII digits.
    fn digits(&mut self, count: usize) -> Option<u32> {
        let slice = self.bytes.get(self.at..self.at + count)?;
        if !slice.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at += count;
        Some(slice.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0')))
    }

    /// One or two ASCII digits.
    fn short_number(&mut self) -> Option<u32> {
        let first = self.digits(1)?;
        Some(match self.digits(1) {
            Some(second) => first * 10 + second,
            None => first,
        })
    }

    fn month_name(&mut self) -> Option<u8> {
        let name = self.bytes.get(self.at..self.at + 3)?;
        let lower = [
            name[0].to_ascii_lowercase(),
            name[1].to_ascii_lowercase(),
            name[2].to_ascii_lowercase(),
        ];
        let month = MONTHS.iter().position(|m| **m == lower)?;
        self.at += 3;
        Some(month as u8 + 1)
    }

    /// `HH:MM`, then `:SS` and a fraction where `seconds_required` allows.
    fn clock(&mut self, seconds_required: bool) -> Option<(u32, u16)> {
        let hour = self.digits(2)?;
        self.byte(b':')?;
        let minute = self.digits(2)?;
        let mut second = 0;
        let mut millis = 0;
        let has_seconds = self.peek() == Some(b':') && {
            let saved = self.at;
            self.at += 1;
            match self.digits(2) {
                Some(value) => {
                    second = value;
                    true
                }
                None => {
                    self.at = saved;
                    false
                }
            }
        };
        if seconds_required && !has_seconds {
            return None;
        }
        if has_seconds && matches!(self.peek(), Some(b'.' | b',')) {
            let saved = self.at;
            self.at += 1;
            let mut digits = 0;
            let mut value = 0u16;
            while let Some(d) = self.peek().filter(u8::is_ascii_digit) {
                if digits < 3 {
                    value = value * 10 + u16::from(d - b'0');
                }
                digits += 1;
                self.at += 1;
            }
            if digits == 0 {
                self.at = saved;
            } else {
                for _ in digits..3 {
                    value *= 10;
                }
                millis = value;
            }
        }
        if hour > 23 || minute > 59 || second > 60 {
            return None;
        }
        Some((hour * 3600 + minute * 60 + second, millis))
    }
}

fn valid_date(month: u32, day: u32) -> bool {
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn key(year: Option<u32>, month: u32, day: u32, clock: (u32, u16)) -> Option<TimeKey> {
    if !valid_date(month, day) {
        return None;
    }
    Some(TimeKey {
        year: year.map(|year| year as u16),
        month: month as u8,
        day: day as u8,
        seconds: clock.0,
        millis: clock.1,
    })
}

/// `YYYY-MM-DD[T ]HH:MM[:SS[.frac]]` (ISO 8601 / RFC 3339; any zone is
/// ignored) and `YYYY/MM/DD HH:MM:SS[.frac]`.
fn parse_year_first(c: &mut Cursor) -> Option<TimeKey> {
    let year = c.digits(4)?;
    let separator = c.peek()?;
    c.one_of(b"-/")?;
    let month = c.digits(2)?;
    c.byte(separator)?;
    let day = c.digits(2)?;
    c.one_of(b"Tt ")?;
    let clock = c.clock(separator == b'/')?;
    key(Some(year), month, day, clock)
}

/// Apache / nginx: `DD/Mon/YYYY:HH:MM:SS`.
fn parse_common_log(c: &mut Cursor) -> Option<TimeKey> {
    let day = c.short_number()?;
    c.byte(b'/')?;
    let month = c.month_name()?;
    c.byte(b'/')?;
    let year = c.digits(4)?;
    c.byte(b':')?;
    let clock = c.clock(true)?;
    key(Some(year), u32::from(month), day, clock)
}

/// Syslog: `Mon DD HH:MM:SS`, the day padded with a space or a zero.
fn parse_syslog(c: &mut Cursor) -> Option<TimeKey> {
    let month = c.month_name()?;
    c.byte(b' ')?;
    if c.peek() == Some(b' ') {
        c.at += 1;
    }
    let day = c.short_number()?;
    c.byte(b' ')?;
    let clock = c.clock(true)?;
    key(None, u32::from(month), day, clock)
}

/// The first timestamp starting within the first `TIMESTAMP_START_BYTES`
/// bytes of a line.
fn parse_timestamp(line: &[u8]) -> Option<TimeKey> {
    let line = &line[..line.len().min(TIMESTAMP_KEEP)];
    for start in 0..line.len().min(TIMESTAMP_START_BYTES) {
        if start > 0 && line[start - 1].is_ascii_alphanumeric() {
            continue;
        }
        let parsers: [fn(&mut Cursor) -> Option<TimeKey>; 3] =
            [parse_year_first, parse_common_log, parse_syslog];
        for parse in parsers {
            let mut cursor = Cursor {
                bytes: line,
                at: start,
            };
            if let Some(found) = parse(&mut cursor) {
                return Some(found);
            }
        }
    }
    None
}

/// What the user asked to jump to.
#[derive(Debug, PartialEq, Eq)]
enum TimeTarget {
    Full(TimeKey),
    /// Only a time of day; the date comes from the file.
    TimeOfDay(u32, u16),
}

fn parse_time_target(text: &str) -> Option<TimeTarget> {
    let text = text.trim().as_bytes();
    let whole = |parse: fn(&mut Cursor) -> Option<TimeKey>| {
        let mut cursor = Cursor { bytes: text, at: 0 };
        parse(&mut cursor).filter(|_| cursor.at == text.len())
    };
    let mut cursor = Cursor { bytes: text, at: 0 };
    if let Some((seconds, millis)) = cursor.clock(false) {
        if cursor.at == text.len() {
            return Some(TimeTarget::TimeOfDay(seconds, millis));
        }
    }
    // A date alone means the start of that day.
    let date_only = |c: &mut Cursor| {
        let year = c.digits(4)?;
        let separator = c.peek()?;
        c.one_of(b"-/")?;
        let month = c.digits(2)?;
        c.byte(separator)?;
        let day = c.digits(2)?;
        key(Some(year), month, day, (0, 0))
    };
    if let Some(found) = whole(date_only) {
        return Some(TimeTarget::Full(found));
    }
    parse_timestamp(text).map(TimeTarget::Full)
}

fn first_timestamp(epoch: &Epoch, deadline: Instant) -> Result<Option<TimeKey>, String> {
    let mut cursor = LineCursor::new(epoch, TIMESTAMP_KEEP, SCAN_CHUNK);
    while let Some((number, line)) = cursor.next()? {
        if let Some(found) = parse_timestamp(cursor.scanner().content(&line)) {
            return Ok(Some(found));
        }
        if number.is_multiple_of(256) && Instant::now() >= deadline {
            return Err(TIME_SEARCH_TOO_LONG.to_string());
        }
    }
    Ok(None)
}

/// The first timestamp among the first lines of a checkpoint block.
fn block_sample(cursor: &mut LineCursor, block: u64) -> Result<Option<TimeKey>, String> {
    let first = block * CHECKPOINT_LINES;
    if !cursor.seek(first)? {
        return Ok(None);
    }
    while let Some((number, line)) = cursor.next()? {
        if number >= first + TIMESTAMP_SAMPLE_LINES {
            break;
        }
        if let Some(found) = parse_timestamp(cursor.scanner().content(&line)) {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// The first line whose timestamp is at or after `target`, for a log in time
/// order. A binary search over the checkpoint blocks finds the last block
/// that starts before the target, then lines are scanned from there.
fn find_time_in(epoch: &Epoch, target: &str) -> Result<Option<u64>, String> {
    find_time_within(epoch, target, TIME_SEARCH_BUDGET)
}

fn find_time_within(epoch: &Epoch, target: &str, budget: Duration) -> Result<Option<u64>, String> {
    let deadline = Instant::now() + budget;
    let target = match parse_time_target(target).ok_or_else(|| BAD_TIME.to_string())? {
        TimeTarget::Full(key) => key,
        TimeTarget::TimeOfDay(seconds, millis) => {
            let Some(first) = first_timestamp(epoch, deadline)? else {
                return Ok(None);
            };
            TimeKey {
                seconds,
                millis,
                ..first
            }
        }
    };
    let mut sampler = LineCursor::new(epoch, TIMESTAMP_KEEP, READ_BUFFER);
    let blocks = sampler.count.div_ceil(CHECKPOINT_LINES);
    // Invariant: block `low - 1` (if any) has a sample before the target, and
    // blocks from `high` on start at or after it (or have no sample, which is
    // treated the same: scanning from an earlier block is always correct).
    let (mut low, mut high) = (0, blocks);
    while low < high {
        let middle = low + (high - low) / 2;
        let before = block_sample(&mut sampler, middle)?
            .is_some_and(|sample| sample.compare(&target) == CmpOrdering::Less);
        if before {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    let start = low.saturating_sub(1) * CHECKPOINT_LINES;
    let mut cursor = LineCursor::new(epoch, TIMESTAMP_KEEP, SCAN_CHUNK);
    if !cursor.seek(start)? {
        return Ok(None);
    }
    while let Some((number, line)) = cursor.next()? {
        if let Some(found) = parse_timestamp(cursor.scanner().content(&line)) {
            if found.compare(&target) != CmpOrdering::Less {
                return Ok(Some(number));
            }
        }
        if number.is_multiple_of(256) && Instant::now() >= deadline {
            return Err(TIME_SEARCH_TOO_LONG.to_string());
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// `from_line` is exclusive; None searches from the start of the file
/// (forwards) or from its end (backwards), so the first and last lines can
/// be found too.
fn search_in(
    epoch: &Epoch,
    from_line: Option<u64>,
    backwards: bool,
    rule: &Regex,
    budget: Duration,
) -> Result<SearchHit, String> {
    let deadline = Instant::now() + budget;
    let mut cursor = LineCursor::new(epoch, MATCH_KEEP, SCAN_CHUNK);
    let count = cursor.count;
    let not_found = SearchHit {
        line: None,
        stopped_at: None,
    };
    if !backwards {
        let first = match from_line {
            None => 0,
            Some(line) => match line.checked_add(1) {
                Some(next) => next,
                None => return Ok(not_found),
            },
        };
        if !cursor.seek(first)? {
            return Ok(not_found);
        }
        while let Some((number, line)) = cursor.next()? {
            if rule.is_match(cursor.scanner().content(&line)) {
                return Ok(SearchHit {
                    line: Some(number),
                    stopped_at: None,
                });
            }
            if number.is_multiple_of(64) && Instant::now() >= deadline {
                return Ok(SearchHit {
                    line: None,
                    stopped_at: Some(number),
                });
            }
        }
        return Ok(not_found);
    }
    // Backwards: scan each checkpoint block forward and keep its last match,
    // moving to the block before when there is none.
    let upper = from_line.unwrap_or(u64::MAX).min(count);
    if upper == 0 {
        return Ok(not_found);
    }
    let mut block = (upper - 1) / CHECKPOINT_LINES;
    loop {
        let first = block * CHECKPOINT_LINES;
        let mut last_match = None;
        if cursor.seek(first)? {
            while let Some((number, line)) = cursor.next()? {
                if number >= upper {
                    break;
                }
                if rule.is_match(cursor.scanner().content(&line)) {
                    last_match = Some(number);
                }
                if number + 1 >= upper {
                    break;
                }
            }
        }
        if last_match.is_some() {
            return Ok(SearchHit {
                line: last_match,
                stopped_at: None,
            });
        }
        if block == 0 {
            return Ok(not_found);
        }
        if Instant::now() >= deadline {
            return Ok(SearchHit {
                line: None,
                stopped_at: Some(first),
            });
        }
        block -= 1;
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Copies bytes `[start, end)` of the file, returning the bytes copied.
fn copy_bytes(file: &File, out: &mut impl Write, start: u64, end: u64) -> Result<u64, String> {
    let mut buf = vec![0u8; SCAN_CHUNK.min((end - start) as usize).max(1)];
    let mut at = start;
    while at < end {
        let want = (end - at).min(buf.len() as u64) as usize;
        let read = read_full_at(file, &mut buf[..want], at).map_err(read_error)?;
        if read == 0 {
            break;
        }
        out.write_all(&buf[..read]).map_err(write_error)?;
        at += read as u64;
    }
    Ok(at - start)
}

fn write_error(error: io::Error) -> String {
    format!("Couldn't write the exported file: {error}")
}

/// Writes one line exactly as it is in the file, terminator included.
fn write_raw_line(
    file: &File,
    scanner: &LineScanner,
    line: &LineMeta,
    out: &mut impl Write,
) -> Result<(), String> {
    match scanner.raw_line(line) {
        Some(bytes) => out.write_all(bytes).map_err(write_error),
        None => copy_bytes(file, out, line.start, line.start + line.raw_len).map(|_| ()),
    }
}

/// Writes the given line numbers (ascending, no repeats).
fn export_line_numbers(
    epoch: &Epoch,
    numbers: impl IntoIterator<Item = u64>,
    out: &mut impl Write,
) -> Result<u64, String> {
    let mut cursor = LineCursor::new(epoch, DISPLAY_KEEP, SCAN_CHUNK);
    let mut written = 0;
    for number in numbers {
        if !cursor.seek(number)? {
            break;
        }
        let Some((_, line)) = cursor.next()? else {
            break;
        };
        write_raw_line(&epoch.file, cursor.scanner(), &line, out)?;
        written += 1;
    }
    Ok(written)
}

/// Writes the whole file as last seen, counting its lines on the way.
fn export_everything(epoch: &Epoch, out: &mut impl Write) -> Result<u64, String> {
    let size = lock(&epoch.index).target;
    let mut buf = vec![0u8; SCAN_CHUNK];
    let mut at = 0;
    let mut lines = 0;
    let mut last = b'\n';
    while at < size {
        let want = (size - at).min(SCAN_CHUNK as u64) as usize;
        let read = read_full_at(&epoch.file, &mut buf[..want], at).map_err(read_error)?;
        if read == 0 {
            break;
        }
        let chunk = &buf[..read];
        lines += chunk.iter().filter(|&&b| b == b'\n').count() as u64;
        last = chunk[read - 1];
        out.write_all(chunk).map_err(write_error)?;
        at += read as u64;
    }
    Ok(lines + u64::from(last != b'\n'))
}

/// Writes every line (of the whole file as last seen) that `filter` keeps.
fn export_matching(
    epoch: &Epoch,
    filter: &CompiledFilter,
    out: &mut impl Write,
) -> Result<u64, String> {
    let size = lock(&epoch.index).target;
    let mut scanner = LineScanner::new(&epoch.file, 0, size, SCAN_CHUNK, MATCH_KEEP);
    let mut written = 0;
    while let Some(line) = scanner.next_line().map_err(read_error)? {
        if filter.matches(scanner.content(&line)) {
            write_raw_line(&epoch.file, &scanner, &line, out)?;
            written += 1;
        }
    }
    Ok(written)
}

fn export_selection(
    session: &Session,
    selection: ExportSelection,
    out: &mut impl Write,
) -> Result<u64, String> {
    let (epoch, filter) = {
        let state = lock(&session.state);
        (state.epoch.clone(), state.filter.clone())
    };
    match selection {
        ExportSelection::All => export_everything(&epoch, out),
        ExportSelection::Filtered => {
            let job = filter.ok_or_else(|| "There is no filter to export.".to_string())?;
            let numbers = {
                let progress = lock(&job.progress);
                if !progress.done {
                    return Err(
                        "The filter is still running. Export again when it finishes.".to_string(),
                    );
                }
                if let Some(error) = &progress.error {
                    return Err(error.clone());
                }
                // Copied as they are stored (4 bytes a line), so the filter
                // isn't held up while the lines are written.
                let tail = (progress.tail == Some(true)).then_some(progress.complete_lines);
                (progress.matches.clone(), tail)
            };
            let (matches, tail) = numbers;
            export_line_numbers(
                &job.epoch,
                matches.into_iter().map(u64::from).chain(tail),
                out,
            )
        }
        ExportSelection::Range { start, end } => {
            if start > end {
                return Err("The first line of the range is after the last.".to_string());
            }
            export_line_numbers(&epoch, start..=end, out)
        }
        ExportSelection::Matching { rules } => {
            let include = compile_rules(&rules)?;
            if include.is_empty() {
                return Err("Enter a pattern to match.".to_string());
            }
            let filter = CompiledFilter {
                include,
                exclude: Vec::new(),
                match_all: false,
            };
            export_matching(&epoch, &filter, out)
        }
        ExportSelection::Lines { mut lines } => {
            if lines.len() > MAX_EXPORT_LINE_LIST {
                return Err(format!(
                    "Too many lines selected. Export at most {MAX_EXPORT_LINE_LIST} at a time."
                ));
            }
            lines.sort_unstable();
            lines.dedup();
            export_line_numbers(&epoch, lines, out)
        }
    }
}

fn export_sync(id: u64, destination: &str, selection: ExportSelection) -> Result<u64, String> {
    let session = session(id)?;
    let destination = authorize_path(destination)?;
    let epoch = current_epoch(&session);
    let existing = fs::symlink_metadata(&destination).ok();
    if existing.as_ref().is_some_and(|m| !m.is_file()) {
        return Err("Choose a file to export to, not a folder.".to_string());
    }
    let same_path = canonical_form(&destination)
        .is_some_and(|dest| canonical_form(&session.path).is_some_and(|source| source == dest));
    let same_file = existing.as_ref().is_some_and(|metadata| {
        !epoch.identity.is_empty() && file_identity(&destination, metadata) == epoch.identity
    });
    if same_path || same_file {
        return Err(SAME_AS_SOURCE.to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "The export destination has no folder.".to_string())?;

    // Written beside the destination and renamed over it, so a failed export
    // never leaves a half-written file under the chosen name. The rename
    // replaces the directory entry itself and never follows a link there.
    let mut builder = tempfile::Builder::new();
    builder.prefix(TEMP_WRITE_PREFIX);
    #[cfg(unix)]
    if existing.is_none() {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let temp = builder
        .tempfile_in(parent)
        .map_err(|e| format!("Couldn't create the exported file: {e}"))?;
    if let Some(metadata) = &existing {
        temp.as_file()
            .set_permissions(metadata.permissions())
            .map_err(|e| format!("Couldn't keep the file's permissions: {e}"))?;
    }
    let mut out = io::BufWriter::with_capacity(SCAN_CHUNK, temp);
    let written = export_selection(&session, selection, &mut out)?;
    let temp = out.into_inner().map_err(|e| write_error(e.into_error()))?;
    temp.as_file().sync_all().map_err(write_error)?;
    // Only replacing the destination waits for saves (one write at a time,
    // as everywhere else). Writing the export, which can take minutes for a
    // huge log, must not hold up Save and autosave.
    let _write_guard = FILE_WRITE_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .blocking_lock();
    persist_with_retry(temp, &destination)
        .map_err(|e| format!("Couldn't replace the destination file: {e}"))?;
    #[cfg(unix)]
    {
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
    }
    sweep_stale_temp_files(parent);
    Ok(written)
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

fn status_of(id: u64, session: &Session) -> LargeFileStatus {
    let state = lock(&session.state);
    let index = lock(&state.epoch.index);
    LargeFileStatus {
        id,
        path: clean_path(session.path.clone()),
        size: index.target,
        indexed_bytes: index.indexed_bytes,
        line_count: index.line_count(),
        indexing: index.indexing,
        rotations: state.rotations,
        missing: state.missing,
        error: state.error.clone().or_else(|| index.error.clone()),
    }
}

fn open_sync(path: &str) -> Result<LargeFileStatus, String> {
    let authorized = authorize_path(path)?;
    let (file, metadata) = open_regular_file_any_size(&authorized)?;
    let identity = file_identity(&authorized, &metadata);
    let epoch = Arc::new(Epoch::new(file, identity, metadata.len()));
    let session = Arc::new(Session {
        path: authorized,
        state: Mutex::new(SessionState {
            epoch: epoch.clone(),
            filter: None,
            rotations: 0,
            missing: false,
            error: None,
        }),
    });
    let id = {
        let mut registry = lock(registry());
        if registry.sessions.len() >= MAX_SESSIONS {
            return Err(TOO_MANY_OPEN.to_string());
        }
        registry.next_id += 1;
        let id = registry.next_id;
        registry.sessions.insert(id, session.clone());
        id
    };
    spawn_indexer(&epoch);
    Ok(status_of(id, &session))
}

fn close_sync(id: u64) {
    let Some(session) = lock(registry()).sessions.remove(&id) else {
        return;
    };
    let state = lock(&session.state);
    state.epoch.cancel.store(true, Ordering::Relaxed);
    if let Some(job) = &state.filter {
        job.cancel.store(true, Ordering::Relaxed);
    }
}

/// Reopens a rotated or truncated file and starts over on the new one.
fn rotate(session: &Session, old: &Arc<Epoch>) {
    let opened = open_regular_file_any_size(&session.path);
    let mut state = lock(&session.state);
    if !Arc::ptr_eq(&state.epoch, old) {
        // Another refresh already switched to the new file.
        return;
    }
    let (file, metadata) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            state.error = Some(error);
            return;
        }
    };
    let identity = file_identity(&session.path, &metadata);
    let epoch = Arc::new(Epoch::new(file, identity, metadata.len()));
    old.cancel.store(true, Ordering::Relaxed);
    state.epoch = epoch.clone();
    state.rotations = state.rotations.saturating_add(1);
    state.missing = false;
    state.error = None;
    if let Some(previous) = state.filter.take() {
        previous.cancel.store(true, Ordering::Relaxed);
        let job = FilterJob::new(previous.filter.clone(), epoch.clone());
        state.filter = Some(job.clone());
        spawn_filter(job);
    }
    spawn_indexer(&epoch);
}

fn refresh_sync(id: u64) -> Result<LargeFileStatus, String> {
    let session = session(id)?;
    let epoch = current_epoch(&session);
    let entry = match fs::symlink_metadata(&session.path) {
        Ok(entry) => entry,
        Err(error) => {
            let mut state = lock(&session.state);
            if error.kind() == io::ErrorKind::NotFound {
                // Keep showing what was read: the open handle still works.
                state.missing = true;
            } else {
                state.error = Some(format!("Couldn't check the file: {error}"));
            }
            drop(state);
            return Ok(status_of(id, &session));
        }
    };
    let size = entry.len();
    let replaced =
        !entry.file_type().is_file() || file_identity(&session.path, &entry) != epoch.identity;
    let shrank = size < lock(&epoch.index).target;
    if replaced || shrank {
        rotate(&session, &epoch);
        return Ok(status_of(id, &session));
    }
    {
        let mut state = lock(&session.state);
        state.missing = false;
        state.error = None;
    }

    enum Work {
        None,
        Inline,
        Background,
        AlreadyRunning,
    }
    let work = {
        let mut index = lock(&epoch.index);
        if size <= index.target {
            Work::None
        } else {
            index.target = size;
            if index.indexing {
                Work::AlreadyRunning
            } else {
                index.indexing = true;
                if size - index.indexed_bytes > BACKGROUND_APPEND_BYTES {
                    Work::Background
                } else {
                    Work::Inline
                }
            }
        }
    };
    match work {
        Work::None => {}
        Work::AlreadyRunning => resume_filter(&session),
        Work::Background => {
            spawn_indexer(&epoch);
            resume_filter(&session);
        }
        Work::Inline => {
            run_indexer(&epoch);
            resume_filter(&session);
        }
    }
    Ok(status_of(id, &session))
}

fn lines_sync(id: u64, start: u64, count: u32) -> Result<Vec<LogLine>, String> {
    let session = session(id)?;
    let epoch = current_epoch(&session);
    let line_count = lock(&epoch.index).line_count();
    let count = u64::from(count.min(MAX_LINES_PER_REQUEST));
    let end = start.saturating_add(count).min(line_count);
    if start >= end {
        return Ok(Vec::new());
    }
    read_display_lines(&epoch, start..end)
}

fn set_filter_sync(id: u64, filter: Option<LineFilter>) -> Result<FilterStatus, String> {
    let session = session(id)?;
    // Compiled first: an invalid pattern leaves the current filter in place.
    let compiled = match &filter {
        Some(filter) => compile_filter(filter)?,
        None => None,
    };
    let mut state = lock(&session.state);
    if let Some(previous) = state.filter.take() {
        previous.cancel.store(true, Ordering::Relaxed);
    }
    if let Some(compiled) = compiled {
        let job = FilterJob::new(Arc::new(compiled), state.epoch.clone());
        state.filter = Some(job.clone());
        spawn_filter(job);
    }
    Ok(filter_status_of(&state))
}

fn filter_status_sync(id: u64) -> Result<FilterStatus, String> {
    let session = session(id)?;
    let state = lock(&session.state);
    Ok(filter_status_of(&state))
}

fn filtered_lines_sync(id: u64, start: u64, count: u32) -> Result<Vec<LogLine>, String> {
    let session = session(id)?;
    let Some(job) = lock(&session.state).filter.clone() else {
        return Ok(Vec::new());
    };
    let numbers: Vec<u64> = {
        let progress = lock(&job.progress);
        (start..start.saturating_add(u64::from(count.min(MAX_LINES_PER_REQUEST))))
            .map_while(|position| progress.matched_line(position))
            .collect()
    };
    read_display_lines(&job.epoch, numbers)
}

fn search_sync(
    id: u64,
    from_line: Option<u64>,
    backwards: bool,
    rule: &LineRule,
) -> Result<SearchHit, String> {
    let session = session(id)?;
    let Some(regex) = compile_rule(rule)? else {
        return Ok(SearchHit {
            line: None,
            stopped_at: None,
        });
    };
    let epoch = current_epoch(&session);
    search_in(&epoch, from_line, backwards, &regex, SEARCH_TIME_BUDGET)
}

fn find_time_sync(id: u64, target: &str) -> Result<Option<u64>, String> {
    let session = session(id)?;
    let epoch = current_epoch(&session);
    find_time_in(&epoch, target)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Runs viewer work off the async runtime: all of it touches the disk.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("The file viewer task failed: {e}"))?
}

/// Opens a file in the viewer and starts indexing it in the background.
#[tauri::command]
pub async fn large_file_open(path: String) -> Result<LargeFileStatus, String> {
    blocking(move || open_sync(&path)).await
}

#[tauri::command]
pub async fn large_file_status(id: u64) -> Result<LargeFileStatus, String> {
    blocking(move || {
        let session = session(id)?;
        Ok(status_of(id, &session))
    })
    .await
}

/// Picks up appended data, a rotated or truncated file, or a deleted one.
#[tauri::command]
pub async fn large_file_refresh(id: u64) -> Result<LargeFileStatus, String> {
    blocking(move || refresh_sync(id)).await
}

#[tauri::command]
pub async fn large_file_lines(id: u64, start: u64, count: u32) -> Result<Vec<LogLine>, String> {
    blocking(move || lines_sync(id, start, count)).await
}

/// Replaces the filter (None clears it) and starts scanning in the
/// background.
#[tauri::command]
pub async fn large_file_set_filter(
    id: u64,
    filter: Option<LineFilter>,
) -> Result<FilterStatus, String> {
    blocking(move || set_filter_sync(id, filter)).await
}

#[tauri::command]
pub async fn large_file_filter_status(id: u64) -> Result<FilterStatus, String> {
    blocking(move || filter_status_sync(id)).await
}

/// Lines of the filter's results: `start` counts matches, and each line's
/// `number` is its line in the file.
#[tauri::command]
pub async fn large_file_filtered_lines(
    id: u64,
    start: u64,
    count: u32,
) -> Result<Vec<LogLine>, String> {
    blocking(move || filtered_lines_sync(id, start, count)).await
}

#[tauri::command]
pub async fn large_file_search(
    id: u64,
    from_line: Option<u64>,
    backwards: bool,
    rule: LineRule,
) -> Result<SearchHit, String> {
    blocking(move || search_sync(id, from_line, backwards, &rule)).await
}

#[tauri::command]
pub async fn large_file_find_time(id: u64, target: String) -> Result<Option<u64>, String> {
    blocking(move || find_time_sync(id, &target)).await
}

/// Writes the selected lines, byte for byte, to a file the user chose in the
/// Save dialog. Returns the number of lines written.
#[tauri::command]
pub async fn large_file_export(
    id: u64,
    destination: String,
    selection: ExportSelection,
) -> Result<u64, String> {
    blocking(move || export_sync(id, &destination, selection)).await
}

#[tauri::command]
pub async fn large_file_close(id: u64) -> Result<(), String> {
    close_sync(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grant_folder;
    use std::path::Path;

    /// The registry is shared by the whole process, and the session cap test
    /// needs every slot free, so these tests run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> MutexGuard<'static, ()> {
        lock(&SERIAL)
    }

    /// Closes the session when the test ends, even when it fails.
    struct Opened(u64);

    impl Drop for Opened {
        fn drop(&mut self) {
            close_sync(self.0);
        }
    }

    fn granted_dir() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temp directory");
        grant_folder(directory.path());
        directory
    }

    fn path_str(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn wait_until(mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// Opens a file and waits for its index to finish.
    fn open_indexed(path: &Path) -> (Opened, LargeFileStatus) {
        let status = open_sync(&path_str(path)).expect("open");
        let opened = Opened(status.id);
        wait_until(|| !status_sync(status.id).indexing);
        let status = status_sync(status.id);
        (opened, status)
    }

    fn status_sync(id: u64) -> LargeFileStatus {
        status_of(id, &session(id).expect("open session"))
    }

    fn texts(lines: &[LogLine]) -> Vec<&str> {
        lines.iter().map(|line| line.text.as_str()).collect()
    }

    fn numbers(lines: &[LogLine]) -> Vec<u64> {
        lines.iter().map(|line| line.number).collect()
    }

    fn all_lines(id: u64) -> Vec<LogLine> {
        lines_sync(id, 0, MAX_LINES_PER_REQUEST).expect("lines")
    }

    fn rule(pattern: &str) -> LineRule {
        LineRule {
            pattern: pattern.into(),
            regex: false,
            case_sensitive: true,
        }
    }

    fn regex_rule(pattern: &str) -> LineRule {
        LineRule {
            pattern: pattern.into(),
            regex: true,
            case_sensitive: true,
        }
    }

    fn filter(include: Vec<LineRule>, exclude: Vec<LineRule>, match_all: bool) -> LineFilter {
        LineFilter {
            include,
            exclude,
            match_all,
        }
    }

    fn finished_filter(id: u64) -> FilterStatus {
        wait_until(|| filter_status_sync(id).expect("filter status").done);
        filter_status_sync(id).expect("filter status")
    }

    fn all_filtered(id: u64) -> Vec<LogLine> {
        filtered_lines_sync(id, 0, MAX_LINES_PER_REQUEST).expect("filtered lines")
    }

    fn append(path: &Path, bytes: &[u8]) {
        fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open for append")
            .write_all(bytes)
            .expect("append");
    }

    fn numbered_lines(count: usize) -> String {
        (0..count).map(|i| format!("line {i}\n")).collect()
    }

    #[test]
    fn counts_lines_with_and_without_terminators() {
        let _serial = serial();
        let directory = granted_dir();
        let cases: [(&[u8], &[&str]); 7] = [
            (b"a\nb\n", &["a", "b"]),
            (b"a\nb", &["a", "b"]),
            (b"a\r\nb\r\n", &["a", "b"]),
            (b"", &[]),
            (b"\n\n", &["", ""]),
            (b"a\n\nb", &["a", "", "b"]),
            (b"cr\rinside\r\n", &["cr\rinside"]),
        ];
        for (number, (content, expected)) in cases.iter().enumerate() {
            let path = directory.path().join(format!("case{number}.log"));
            fs::write(&path, content).unwrap();
            let (opened, status) = open_indexed(&path);
            assert_eq!(status.line_count, expected.len() as u64, "{content:?}");
            assert_eq!(status.size, content.len() as u64);
            assert_eq!(status.indexed_bytes, content.len() as u64);
            assert_eq!(texts(&all_lines(opened.0)), *expected, "{content:?}");
        }
    }

    #[test]
    fn empty_file_is_not_indexing() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("empty.log");
        fs::write(&path, b"").unwrap();
        let status = open_sync(&path_str(&path)).unwrap();
        let _opened = Opened(status.id);
        assert!(!status.indexing);
        assert_eq!(status.line_count, 0);
        assert!(lines_sync(status.id, 0, 10).unwrap().is_empty());
    }

    #[test]
    fn reads_lines_across_checkpoints() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("numbered.log");
        fs::write(&path, numbered_lines(2000)).unwrap();
        let (opened, status) = open_indexed(&path);
        assert_eq!(status.line_count, 2000);

        let middle = lines_sync(opened.0, 500, 30).unwrap();
        assert_eq!(numbers(&middle), (500..530).collect::<Vec<_>>());
        assert_eq!(middle[0].text, "line 500");
        assert_eq!(middle[29].text, "line 529");

        // Crosses the checkpoints at 1024 and 1536.
        let across = lines_sync(opened.0, 1020, 600).unwrap();
        assert_eq!(across.len(), 600);
        for line in &across {
            assert_eq!(line.text, format!("line {}", line.number));
        }

        let end = lines_sync(opened.0, 1990, 50).unwrap();
        assert_eq!(numbers(&end), (1990..2000).collect::<Vec<_>>());
        assert!(lines_sync(opened.0, 2000, 10).unwrap().is_empty());
        assert!(lines_sync(opened.0, u64::MAX, 10).unwrap().is_empty());
        assert_eq!(lines_sync(opened.0, 0, 5000).unwrap().len(), 1000);
        assert!(lines_sync(opened.0, 0, 0).unwrap().is_empty());
    }

    #[test]
    fn cuts_long_lines_for_display() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("long.log");
        let mut content = "x".repeat(100_000).into_bytes();
        content.extend_from_slice(b"\r\nshort\n");
        content.extend("é".repeat(20_000).as_bytes());
        content.extend_from_slice(b"\n");
        content.extend("y".repeat(MAX_DISPLAY_CHARS).as_bytes());
        content.extend_from_slice(b"\r\n");
        fs::write(&path, &content).unwrap();
        let (opened, status) = open_indexed(&path);
        assert_eq!(status.line_count, 4);
        let lines = all_lines(opened.0);
        assert_eq!(lines[0].text, "x".repeat(MAX_DISPLAY_CHARS));
        assert!(lines[0].truncated);
        assert_eq!(lines[1].text, "short");
        assert!(!lines[1].truncated);
        assert_eq!(lines[2].text, "é".repeat(MAX_DISPLAY_CHARS));
        assert!(lines[2].truncated);
        // Exactly the limit, followed by \r\n: complete, not cut.
        assert_eq!(lines[3].text, "y".repeat(MAX_DISPLAY_CHARS));
        assert!(!lines[3].truncated);
    }

    #[test]
    fn invalid_utf8_is_shown_lossily() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("binary.log");
        fs::write(&path, b"ok \xff\xfe end\n").unwrap();
        let (opened, _) = open_indexed(&path);
        assert_eq!(all_lines(opened.0)[0].text, "ok \u{fffd}\u{fffd} end");
    }

    #[test]
    fn index_hides_a_line_cut_by_a_read_until_the_end_is_reached() {
        let mut index = LineIndex::new(20);
        index.add(b"one\ntwo\nthr", 0);
        assert!(index.indexing);
        assert_eq!(index.line_count(), 2, "the cut line is not shown yet");
        assert_eq!(index.readable_end(), 8);
        index.add(b"ee\nfour\n", 11);
        // A file of exactly 20 bytes would end in a newline here; this one
        // ends mid-line.
        index.target = 21;
        index.add(b"5", 19);
        assert_eq!(index.indexed_bytes, 20);
        assert_eq!(index.line_count(), 4);
        index.target = 20;
        assert_eq!(index.line_count(), 5, "an unterminated last line counts");
        assert_eq!(index.checkpoints, vec![0]);
    }

    #[test]
    fn index_records_every_512th_line_start() {
        let mut index = LineIndex::new(0);
        let content = numbered_lines(1100);
        index.add(content.as_bytes(), 0);
        assert_eq!(index.checkpoints.len(), 3);
        assert_eq!(
            index.checkpoints[1] as usize,
            content.find("line 512\n").unwrap()
        );
        assert_eq!(
            index.checkpoints[2] as usize,
            content.find("line 1024\n").unwrap()
        );
    }

    #[test]
    fn large_file_indexes_in_the_background_until_done() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("big.log");
        // Several read chunks, and more than the editor's own size limit.
        let content = numbered_lines(1_200_000);
        assert!(content.len() as u64 > 3 * SCAN_CHUNK as u64);
        fs::write(&path, &content).unwrap();
        let status = open_sync(&path_str(&path)).unwrap();
        let opened = Opened(status.id);
        assert_eq!(status.size, content.len() as u64);
        let mut last_indexed = 0;
        wait_until(|| {
            let status = status_sync(opened.0);
            assert!(status.indexed_bytes >= last_indexed);
            assert!(status.indexed_bytes <= status.size);
            last_indexed = status.indexed_bytes;
            // Whatever is counted can already be read.
            if status.line_count > 0 {
                let last = lines_sync(opened.0, status.line_count - 1, 1).unwrap();
                assert_eq!(last[0].text, format!("line {}", status.line_count - 1));
            }
            !status.indexing
        });
        let status = status_sync(opened.0);
        assert_eq!(status.line_count, 1_200_000);
        assert_eq!(status.indexed_bytes, content.len() as u64);
        assert_eq!(status.error, None);
        let line = lines_sync(opened.0, 1_000_123, 1).unwrap();
        assert_eq!(line[0].text, "line 1000123");
    }

    #[test]
    fn refresh_picks_up_appended_lines() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("tail.log");
        fs::write(&path, b"a\nb").unwrap();
        let (opened, status) = open_indexed(&path);
        assert_eq!(status.line_count, 2);

        // Continues the unterminated last line instead of adding one.
        append(&path, b"c\nd\n");
        let status = refresh_sync(opened.0).unwrap();
        assert_eq!(status.line_count, 3);
        assert_eq!(status.rotations, 0);
        assert!(!status.indexing);
        assert_eq!(texts(&all_lines(opened.0)), ["a", "bc", "d"]);

        // Nothing new: nothing changes.
        assert_eq!(refresh_sync(opened.0).unwrap(), status);

        append(&path, numbered_lines(1000).as_bytes());
        let status = refresh_sync(opened.0).unwrap();
        assert_eq!(status.line_count, 1003);
        let lines = lines_sync(opened.0, 1000, 10).unwrap();
        assert_eq!(texts(&lines), ["line 997", "line 998", "line 999"]);
    }

    #[test]
    fn refresh_indexes_a_large_append_in_the_background() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("burst.log");
        fs::write(&path, b"first\n").unwrap();
        let (opened, _) = open_indexed(&path);
        let burst = numbered_lines(1_000_000);
        assert!(burst.len() as u64 > BACKGROUND_APPEND_BYTES);
        append(&path, burst.as_bytes());
        refresh_sync(opened.0).unwrap();
        wait_until(|| !status_sync(opened.0).indexing);
        let status = status_sync(opened.0);
        assert_eq!(status.line_count, 1_000_001);
        assert_eq!(status.rotations, 0);
        let last = lines_sync(opened.0, 1_000_000, 1).unwrap();
        assert_eq!(last[0].text, "line 999999");
    }

    #[test]
    fn refresh_reopens_a_replaced_file() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("app.log");
        fs::write(&path, b"old 1\nold 2\nold 3\n").unwrap();
        let (opened, _) = open_indexed(&path);

        // Rotation: the log is renamed away and a new one created.
        fs::rename(&path, directory.path().join("app.log.1")).unwrap();
        fs::write(&path, b"new 1\n").unwrap();
        refresh_sync(opened.0).unwrap();
        wait_until(|| !status_sync(opened.0).indexing);
        let status = status_sync(opened.0);
        assert_eq!(status.rotations, 1);
        assert!(!status.missing);
        assert_eq!(status.line_count, 1);
        assert_eq!(texts(&all_lines(opened.0)), ["new 1"]);
    }

    #[test]
    fn refresh_starts_over_when_a_file_is_truncated() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("cut.log");
        fs::write(&path, b"one\ntwo\nthree\n").unwrap();
        let (opened, _) = open_indexed(&path);
        // Same file, emptied and rewritten shorter (copytruncate rotation).
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(0).unwrap();
        drop(file);
        append(&path, b"x\n");
        refresh_sync(opened.0).unwrap();
        wait_until(|| !status_sync(opened.0).indexing);
        let status = status_sync(opened.0);
        assert_eq!(status.rotations, 1);
        assert_eq!(status.line_count, 1);
        assert_eq!(texts(&all_lines(opened.0)), ["x"]);
    }

    #[test]
    fn a_deleted_file_is_reported_missing_and_stays_readable() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("gone.log");
        fs::write(&path, b"still here\n").unwrap();
        let (opened, _) = open_indexed(&path);
        fs::remove_file(&path).unwrap();
        let status = refresh_sync(opened.0).unwrap();
        assert!(status.missing);
        assert_eq!(status.rotations, 0);
        assert_eq!(texts(&all_lines(opened.0)), ["still here"]);

        // When it comes back it is a new file.
        fs::write(&path, b"back\n").unwrap();
        refresh_sync(opened.0).unwrap();
        wait_until(|| !status_sync(opened.0).indexing);
        let status = status_sync(opened.0);
        assert!(!status.missing);
        assert_eq!(status.rotations, 1);
        assert_eq!(texts(&all_lines(opened.0)), ["back"]);
    }

    #[test]
    fn filters_with_include_exclude_and_match_all() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("filter.log");
        fs::write(
            &path,
            b"INFO start\nERROR disk full\nWARN disk slow\nerror net down\nINFO done\r\n",
        )
        .unwrap();
        let (opened, _) = open_indexed(&path);
        let id = opened.0;

        // Any include matches (case-sensitive plain text).
        set_filter_sync(
            id,
            Some(filter(vec![rule("ERROR"), rule("WARN")], vec![], false)),
        )
        .unwrap();
        let status = finished_filter(id);
        assert_eq!(
            (status.active, status.matched, status.scanned_lines),
            (true, 2, 5)
        );
        assert_eq!(numbers(&all_filtered(id)), [1, 2]);

        // Case-insensitive.
        let mut insensitive = rule("error");
        insensitive.case_sensitive = false;
        set_filter_sync(id, Some(filter(vec![insensitive], vec![], false))).unwrap();
        finished_filter(id);
        assert_eq!(numbers(&all_filtered(id)), [1, 3]);

        // All includes must match.
        set_filter_sync(
            id,
            Some(filter(vec![rule("disk"), rule("WARN")], vec![], true)),
        )
        .unwrap();
        finished_filter(id);
        assert_eq!(texts(&all_filtered(id)), ["WARN disk slow"]);

        // Exclude only.
        set_filter_sync(id, Some(filter(vec![], vec![rule("disk")], false))).unwrap();
        finished_filter(id);
        assert_eq!(numbers(&all_filtered(id)), [0, 3, 4]);

        // Regex, anchored, matched without the \r\n terminator.
        set_filter_sync(
            id,
            Some(filter(vec![regex_rule(r"^INFO \w+$")], vec![], false)),
        )
        .unwrap();
        finished_filter(id);
        assert_eq!(texts(&all_filtered(id)), ["INFO start", "INFO done"]);

        // Plain patterns are not regexes.
        set_filter_sync(id, Some(filter(vec![rule("^INFO")], vec![], false))).unwrap();
        assert_eq!(finished_filter(id).matched, 0);

        // Paging through the matches.
        set_filter_sync(id, Some(filter(vec![rule("i")], vec![], false))).unwrap();
        finished_filter(id);
        let page = filtered_lines_sync(id, 1, 1).unwrap();
        assert_eq!(numbers(&page), [2]);
        assert!(filtered_lines_sync(id, 10, 5).unwrap().is_empty());

        // An invalid regex is an error and keeps the current filter.
        let error =
            set_filter_sync(id, Some(filter(vec![regex_rule("(")], vec![], false))).unwrap_err();
        assert!(error.contains("unclosed group"), "{error}");
        assert!(filter_status_sync(id).unwrap().active);

        // Empty patterns are ignored; a filter of only empty ones is none.
        let status =
            set_filter_sync(id, Some(filter(vec![rule("")], vec![rule("")], false))).unwrap();
        assert!(!status.active);

        set_filter_sync(id, Some(filter(vec![rule("INFO")], vec![], false))).unwrap();
        finished_filter(id);
        let cleared = set_filter_sync(id, None).unwrap();
        assert_eq!(cleared, inactive_filter());
        assert!(all_filtered(id).is_empty());
    }

    #[test]
    fn filter_covers_many_lines_and_checkpoints() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("many.log");
        fs::write(&path, numbered_lines(300_000)).unwrap();
        let (opened, _) = open_indexed(&path);
        set_filter_sync(
            opened.0,
            Some(filter(vec![regex_rule(r"^line \d*777$")], vec![], false)),
        )
        .unwrap();
        let status = finished_filter(opened.0);
        assert_eq!(status.scanned_lines, 300_000);
        let expected: Vec<u64> = (0..300_000u64)
            .filter(|n| n.to_string().ends_with("777"))
            .collect();
        assert_eq!(status.matched, expected.len() as u64);
        assert_eq!(numbers(&all_filtered(opened.0)), expected);
    }

    #[test]
    fn a_filter_stops_at_its_match_limit_and_keeps_what_it_found() {
        struct RestoreLimit;
        impl Drop for RestoreLimit {
            fn drop(&mut self) {
                FILTER_MATCH_LIMIT.store(MAX_FILTER_MATCHES, Ordering::Relaxed);
            }
        }
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("limit.log");
        fs::write(&path, numbered_lines(5000)).unwrap();
        let (opened, _) = open_indexed(&path);
        let _restore = RestoreLimit;
        FILTER_MATCH_LIMIT.store(700, Ordering::Relaxed);
        set_filter_sync(opened.0, Some(filter(vec![rule("line")], vec![], false))).unwrap();
        let status = finished_filter(opened.0);
        assert_eq!(status.matched, 700, "memory stays bounded");
        assert!(status.error.unwrap().contains("only the first 700"));
        assert_eq!(
            numbers(&all_filtered(opened.0)),
            (0..700).collect::<Vec<u64>>()
        );
    }

    #[test]
    fn looking_for_a_time_gives_up_after_its_time_limit() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("untimed.log");
        fs::write(&path, numbered_lines(5000)).unwrap();
        let (opened, _) = open_indexed(&path);
        let epoch = current_epoch(&session(opened.0).unwrap());
        for target in ["12:00", "2026-10-07 12:00"] {
            assert_eq!(
                find_time_within(&epoch, target, Duration::ZERO),
                Err(TIME_SEARCH_TOO_LONG.to_string()),
                "{target}"
            );
        }
        // Given time, the same search reads the file and finds nothing.
        assert_eq!(find_time_sync(opened.0, "2026-10-07 12:00"), Ok(None));
    }

    #[test]
    fn filter_continues_over_appended_lines() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("grow.log");
        fs::write(&path, b"hit 0\nmiss\nhit 2").unwrap();
        let (opened, _) = open_indexed(&path);
        let id = opened.0;
        set_filter_sync(id, Some(filter(vec![rule("hit")], vec![], false))).unwrap();
        let status = finished_filter(id);
        assert_eq!((status.matched, status.scanned_lines), (2, 3));

        // Extends the unterminated matching line: still one match for it.
        append(&path, b" more\nmiss\nhit 4\n");
        refresh_sync(id).unwrap();
        let status = finished_filter(id);
        assert_eq!((status.matched, status.scanned_lines), (3, 5));
        assert_eq!(texts(&all_filtered(id)), ["hit 0", "hit 2 more", "hit 4"]);

        // An unterminated line that stops matching once it is extended.
        set_filter_sync(
            id,
            Some(filter(vec![rule("hit")], vec![rule("hit!")], false)),
        )
        .unwrap();
        assert_eq!(finished_filter(id).matched, 3);
        append(&path, b"hit");
        refresh_sync(id).unwrap();
        let status = finished_filter(id);
        assert_eq!((status.matched, status.scanned_lines), (4, 6));
        append(&path, b"!\n");
        refresh_sync(id).unwrap();
        let status = finished_filter(id);
        assert_eq!((status.matched, status.scanned_lines), (3, 6));
        assert_eq!(texts(&all_filtered(id)), ["hit 0", "hit 2 more", "hit 4"]);

        // A rotation rescans the new file with the same filter.
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"hit new\n").unwrap();
        refresh_sync(id).unwrap();
        let status = finished_filter(id);
        assert_eq!((status.matched, status.scanned_lines), (1, 1));
        assert_eq!(texts(&all_filtered(id)), ["hit new"]);
    }

    #[test]
    fn searches_forwards_and_backwards() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("search.log");
        let mut content = numbered_lines(2000);
        content = content.replace("line 3\n", "needle 3\n");
        content = content.replace("line 1500\n", "Needle 1500\n");
        fs::write(&path, content).unwrap();
        let (opened, _) = open_indexed(&path);
        let id = opened.0;
        let found = |from, backwards, rule: LineRule| {
            search_sync(id, Some(from), backwards, &rule).unwrap()
        };

        assert_eq!(found(0, false, rule("needle")).line, Some(3));
        // Exclusive of the start line.
        assert_eq!(found(3, false, rule("needle")).line, None);
        let mut insensitive = rule("needle");
        insensitive.case_sensitive = false;
        assert_eq!(found(3, false, insensitive.clone()).line, Some(1500));
        assert_eq!(found(1999, true, insensitive.clone()).line, Some(1500));
        assert_eq!(found(1500, true, insensitive.clone()).line, Some(3));
        assert_eq!(found(3, true, insensitive.clone()).line, None);
        // Starting past the end searches backwards from the last line.
        assert_eq!(found(u64::MAX, true, insensitive).line, Some(1500));
        // No start line: the very first and very last lines are found too.
        let whole =
            |backwards, rule: LineRule| search_sync(id, None, backwards, &rule).unwrap().line;
        assert_eq!(whole(false, regex_rule(r"^line 0$")), Some(0));
        assert_eq!(whole(true, regex_rule(r"^line 1999$")), Some(1999));
        // The last line in a block, found from the next block.
        assert_eq!(
            found(1100, true, regex_rule(r"^line 1023$")).line,
            Some(1023)
        );
        assert_eq!(
            found(1023, false, regex_rule(r"^line 1024$")).line,
            Some(1024)
        );
        assert_eq!(
            found(0, false, rule("absent")),
            SearchHit {
                line: None,
                stopped_at: None
            }
        );
        assert!(search_sync(id, Some(0), false, &regex_rule("[")).is_err());
    }

    #[test]
    fn search_reports_where_it_stopped_when_out_of_time() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("slow.log");
        fs::write(&path, numbered_lines(5000)).unwrap();
        let (opened, _) = open_indexed(&path);
        let epoch = current_epoch(&session(opened.0).unwrap());
        let absent = compile_rule(&rule("absent")).unwrap().unwrap();
        let forwards = search_in(&epoch, Some(10), false, &absent, Duration::ZERO).unwrap();
        assert_eq!(forwards.line, None);
        let stopped = forwards.stopped_at.expect("stopped");
        assert!(stopped > 10 && stopped < 5000);
        let backwards = search_in(&epoch, Some(4000), true, &absent, Duration::ZERO).unwrap();
        assert_eq!(backwards.stopped_at, Some(3584));
    }

    fn ts(year: Option<u16>, month: u8, day: u8, h: u32, m: u32, s: u32, ms: u16) -> TimeKey {
        TimeKey {
            year,
            month,
            day,
            seconds: h * 3600 + m * 60 + s,
            millis: ms,
        }
    }

    #[test]
    fn parses_each_timestamp_format() {
        let cases: [(&str, TimeKey); 9] = [
            (
                "2026-10-07T14:30:05.123Z INFO",
                ts(Some(2026), 10, 7, 14, 30, 5, 123),
            ),
            (
                "2026-10-07 14:30:05,5 WARN",
                ts(Some(2026), 10, 7, 14, 30, 5, 500),
            ),
            ("[2026-10-07 14:30] x", ts(Some(2026), 10, 7, 14, 30, 0, 0)),
            (
                "2026-10-07T14:30:05+02:00",
                ts(Some(2026), 10, 7, 14, 30, 5, 0),
            ),
            ("2026/10/07 14:30:05 x", ts(Some(2026), 10, 7, 14, 30, 5, 0)),
            (
                r#"127.0.0.1 - - [07/Oct/2026:14:30:05 +0000] "GET /""#,
                ts(Some(2026), 10, 7, 14, 30, 5, 0),
            ),
            (
                "Oct  7 14:30:05 host sshd[1]: x",
                ts(None, 10, 7, 14, 30, 5, 0),
            ),
            ("Oct 17 04:03:02 host", ts(None, 10, 17, 4, 3, 2, 0)),
            (
                "pid=12 at 2026-01-02 03:04:05",
                ts(Some(2026), 1, 2, 3, 4, 5, 0),
            ),
        ];
        for (line, expected) in cases {
            assert_eq!(parse_timestamp(line.as_bytes()), Some(expected), "{line}");
        }
        for line in [
            "no time here",
            "2026-13-07 14:30:05",
            "2026-10-07 25:30:05",
            "2026/10/07 14:30",
            "12026-10-07 14:30:05",
            "x2026-10-07 14:30:05",
            "October 7 14:30:05",
            "Oct 32 14:30:05",
        ] {
            assert_eq!(parse_timestamp(line.as_bytes()), None, "{line}");
        }
        // Only the start of a line is searched.
        let late = format!("{} 2026-10-07 14:30:05", "x".repeat(70));
        assert_eq!(parse_timestamp(late.as_bytes()), None);
    }

    #[test]
    fn compares_timestamps_without_a_year_when_one_is_missing() {
        let with_year = ts(Some(2025), 12, 31, 23, 0, 0, 0);
        let later_year = ts(Some(2026), 1, 1, 0, 0, 0, 0);
        let no_year = ts(None, 6, 1, 0, 0, 0, 0);
        assert_eq!(with_year.compare(&later_year), CmpOrdering::Less);
        assert_eq!(with_year.compare(&no_year), CmpOrdering::Greater);
        assert_eq!(later_year.compare(&no_year), CmpOrdering::Less);
        assert_eq!(
            ts(None, 1, 1, 0, 0, 1, 0).compare(&ts(None, 1, 1, 0, 0, 1, 1)),
            CmpOrdering::Less
        );
    }

    #[test]
    fn parses_time_targets() {
        assert_eq!(
            parse_time_target(" 14:30 "),
            Some(TimeTarget::TimeOfDay(14 * 3600 + 30 * 60, 0))
        );
        assert_eq!(
            parse_time_target("14:30:05.25"),
            Some(TimeTarget::TimeOfDay(14 * 3600 + 30 * 60 + 5, 250))
        );
        assert_eq!(
            parse_time_target("2026-10-07"),
            Some(TimeTarget::Full(ts(Some(2026), 10, 7, 0, 0, 0, 0)))
        );
        assert_eq!(
            parse_time_target("2026-10-07 14:30:00"),
            Some(TimeTarget::Full(ts(Some(2026), 10, 7, 14, 30, 0, 0)))
        );
        assert_eq!(
            parse_time_target("Oct 7 14:30:00"),
            Some(TimeTarget::Full(ts(None, 10, 7, 14, 30, 0, 0)))
        );
        assert_eq!(parse_time_target("yesterday"), None);
        assert_eq!(parse_time_target("25:00"), None);
    }

    /// One line per second from 2026-10-07 10:00:00, with untimed lines mixed
    /// in.
    fn timed_log(lines: u32) -> String {
        let mut content = String::from("header without a time\n");
        for i in 0..lines {
            let (h, m, s) = (10 + i / 3600, i / 60 % 60, i % 60);
            content.push_str(&format!("2026-10-07T{h:02}:{m:02}:{s:02}.000Z event {i}\n"));
            if i % 7 == 0 {
                content.push_str("    continuation without a time\n");
            }
        }
        content
    }

    #[test]
    fn finds_the_first_line_at_or_after_a_time() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("timed.log");
        fs::write(&path, timed_log(5000)).unwrap();
        let (opened, _) = open_indexed(&path);
        let id = opened.0;
        let line_of = |target: &str| {
            find_time_sync(id, target)
                .unwrap()
                .map(|n| lines_sync(id, n, 1).unwrap().remove(0).text)
        };
        let event = |line: Option<String>| {
            line.map(|text| text.rsplit(' ').next().unwrap().parse::<u32>().unwrap())
        };
        // 10:41:40 is event 2500 (deep inside, past several checkpoints).
        assert_eq!(event(line_of("2026-10-07 10:41:40")), Some(2500));
        // Between two events: the next one.
        assert_eq!(event(line_of("2026-10-07T10:41:39.500")), Some(2500));
        // Time only takes the file's first date.
        assert_eq!(event(line_of("10:41:40")), Some(2500));
        assert_eq!(event(line_of("11:00")), Some(3600));
        // Before the first line: the first timed line, not the header.
        assert_eq!(find_time_sync(id, "2026-10-07").unwrap(), Some(1));
        assert_eq!(event(line_of("2026-10-07 11:23:19")), Some(4999));
        // After the last line.
        assert_eq!(find_time_sync(id, "2026-10-07 11:23:20").unwrap(), None);
        assert_eq!(find_time_sync(id, "2026-10-08 00:00:00").unwrap(), None);
        assert_eq!(find_time_sync(id, "not a time").unwrap_err(), BAD_TIME);
    }

    #[test]
    fn finds_times_in_syslog_and_access_logs() {
        let _serial = serial();
        let directory = granted_dir();
        let syslog = directory.path().join("syslog");
        fs::write(
            &syslog,
            "Oct  6 23:59:58 host a\nOct  7 00:00:01 host b\nOct  7 09:15:00 host c\n",
        )
        .unwrap();
        let (opened, _) = open_indexed(&syslog);
        assert_eq!(find_time_sync(opened.0, "Oct 7 00:00:00").unwrap(), Some(1));
        // No year in the file: a dated target is compared without it.
        assert_eq!(
            find_time_sync(opened.0, "2026-10-07 09:00").unwrap(),
            Some(2)
        );
        // Time only takes the first line's date (Oct 6).
        assert_eq!(find_time_sync(opened.0, "23:59:59").unwrap(), Some(1));
        drop(opened);

        let access = directory.path().join("access.log");
        fs::write(
            &access,
            "1.2.3.4 - - [07/Oct/2026:14:00:00 +0000] \"GET /a\"\n\
             1.2.3.4 - - [07/Oct/2026:14:30:00 +0000] \"GET /b\"\n",
        )
        .unwrap();
        let (opened, _) = open_indexed(&access);
        assert_eq!(find_time_sync(opened.0, "14:10").unwrap(), Some(1));
        assert_eq!(
            find_time_sync(opened.0, "2026/10/07 14:00:00").unwrap(),
            Some(0)
        );
        drop(opened);

        let untimed = directory.path().join("plain.txt");
        fs::write(&untimed, "nothing\nto see\n").unwrap();
        let (opened, _) = open_indexed(&untimed);
        assert_eq!(find_time_sync(opened.0, "14:10").unwrap(), None);
        assert_eq!(find_time_sync(opened.0, "2026-10-07 14:10").unwrap(), None);
    }

    fn export(id: u64, destination: &Path, selection: ExportSelection) -> Result<u64, String> {
        export_sync(id, &path_str(destination), selection)
    }

    #[test]
    fn exports_raw_lines_for_each_selection() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("source.log");
        let content: &[u8] = b"a ERROR\r\nb\nc ERROR\r\n\nd ERROR";
        fs::write(&path, content).unwrap();
        let (opened, status) = open_indexed(&path);
        assert_eq!(status.line_count, 5);
        let id = opened.0;
        let out = directory.path().join("out.log");
        let exported = |selection| {
            let written = export(id, &out, selection).expect("export");
            (written, fs::read(&out).unwrap())
        };

        assert_eq!(exported(ExportSelection::All), (5, content.to_vec()));
        assert_eq!(
            exported(ExportSelection::Range { start: 1, end: 2 }),
            (2, b"b\nc ERROR\r\n".to_vec())
        );
        // Clamped to the end; the unterminated last line is written as-is.
        assert_eq!(
            exported(ExportSelection::Range { start: 3, end: 99 }),
            (2, b"\nd ERROR".to_vec())
        );
        assert!(export(id, &out, ExportSelection::Range { start: 2, end: 1 }).is_err());
        assert_eq!(
            exported(ExportSelection::Lines {
                lines: vec![4, 0, 0, 99]
            }),
            (2, b"a ERROR\r\nd ERROR".to_vec())
        );
        assert!(export(
            id,
            &out,
            ExportSelection::Lines {
                lines: vec![0; MAX_EXPORT_LINE_LIST + 1]
            }
        )
        .is_err());
        assert_eq!(
            exported(ExportSelection::Matching {
                rules: vec![rule("b"), regex_rule("^c")]
            }),
            (2, b"b\nc ERROR\r\n".to_vec())
        );
        assert!(export(id, &out, ExportSelection::Matching { rules: vec![] }).is_err());

        assert!(
            export(id, &out, ExportSelection::Filtered).is_err(),
            "no filter yet"
        );
        set_filter_sync(id, Some(filter(vec![rule("ERROR")], vec![], false))).unwrap();
        finished_filter(id);
        assert_eq!(
            exported(ExportSelection::Filtered),
            (3, b"a ERROR\r\nc ERROR\r\nd ERROR".to_vec())
        );
        // No temporary files are left behind.
        let leftovers: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(TEMP_WRITE_PREFIX)
            })
            .collect();
        assert!(leftovers.is_empty());
        // The source is untouched.
        assert_eq!(fs::read(&path).unwrap(), content);
    }

    #[test]
    fn export_copies_lines_longer_than_its_buffer() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("wide.log");
        let mut content = vec![b'w'; 3 * DISPLAY_KEEP];
        content.extend_from_slice(b"\r\nnext\n");
        fs::write(&path, &content).unwrap();
        let (opened, _) = open_indexed(&path);
        let out = directory.path().join("wide-out.log");
        assert_eq!(
            export(opened.0, &out, ExportSelection::Lines { lines: vec![0] }),
            Ok(1)
        );
        assert_eq!(fs::read(&out).unwrap(), &content[..3 * DISPLAY_KEEP + 2]);
    }

    #[test]
    fn export_refuses_the_viewed_file_and_ungranted_paths() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("viewed.log");
        fs::write(&path, b"keep me\n").unwrap();
        let (opened, _) = open_indexed(&path);
        assert_eq!(
            export(opened.0, &path, ExportSelection::All),
            Err(SAME_AS_SOURCE.to_string())
        );
        // The same file through a different spelling of its path.
        let indirect = directory.path().join(".").join("viewed.log");
        assert_eq!(
            export(opened.0, &indirect, ExportSelection::All),
            Err(SAME_AS_SOURCE.to_string())
        );
        #[cfg(unix)]
        {
            let link = directory.path().join("link.log");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            assert_eq!(
                export(opened.0, &link, ExportSelection::All),
                Err(SAME_AS_SOURCE.to_string())
            );
        }
        assert_eq!(fs::read(&path).unwrap(), b"keep me\n");

        let elsewhere = tempfile::tempdir().unwrap();
        let ungranted = elsewhere.path().join("out.log");
        let error = export(opened.0, &ungranted, ExportSelection::All).unwrap_err();
        assert!(error.starts_with("Access denied"), "{error}");
        assert!(!ungranted.exists());

        assert_eq!(
            export(
                999_999,
                &directory.path().join("x.log"),
                ExportSelection::All
            ),
            Err(NOT_OPEN.to_string())
        );
    }

    #[test]
    fn refuses_ungranted_paths_and_unknown_ids() {
        let _serial = serial();
        let elsewhere = tempfile::tempdir().unwrap();
        let path = elsewhere.path().join("secret.log");
        fs::write(&path, b"secret\n").unwrap();
        let error = open_sync(&path_str(&path)).unwrap_err();
        assert!(error.starts_with("Access denied"), "{error}");

        let directory = granted_dir();
        let folder_error = open_sync(&path_str(directory.path())).unwrap_err();
        assert_eq!(folder_error, "Only regular files can be opened");

        assert_eq!(lines_sync(424_242, 0, 1).unwrap_err(), NOT_OPEN);
        assert_eq!(refresh_sync(424_242).unwrap_err(), NOT_OPEN);
        assert_eq!(filter_status_sync(424_242).unwrap_err(), NOT_OPEN);
        assert_eq!(find_time_sync(424_242, "10:00").unwrap_err(), NOT_OPEN);
        close_sync(424_242);
    }

    #[test]
    fn allows_at_most_eight_open_files() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("shared.log");
        fs::write(&path, b"x\n").unwrap();
        let mut opened: Vec<Opened> = (0..MAX_SESSIONS)
            .map(|_| Opened(open_sync(&path_str(&path)).unwrap().id))
            .collect();
        assert_eq!(open_sync(&path_str(&path)).unwrap_err(), TOO_MANY_OPEN);
        let closed = opened.pop().unwrap();
        let closed_id = closed.0;
        drop(closed);
        assert_eq!(lines_sync(closed_id, 0, 1).unwrap_err(), NOT_OPEN);
        let reopened = open_sync(&path_str(&path)).unwrap();
        assert_ne!(reopened.id, closed_id, "ids are not reused");
        opened.push(Opened(reopened.id));
    }

    #[test]
    fn commands_run_through_the_async_runtime() {
        let _serial = serial();
        let directory = granted_dir();
        let path = directory.path().join("cmd.log");
        fs::write(&path, b"one\ntwo\n").unwrap();
        let status = tauri::async_runtime::block_on(large_file_open(path_str(&path))).unwrap();
        let opened = Opened(status.id);
        wait_until(|| !status_sync(opened.0).indexing);
        let lines = tauri::async_runtime::block_on(large_file_lines(opened.0, 1, 5)).unwrap();
        assert_eq!(texts(&lines), ["two"]);
        assert!(tauri::async_runtime::block_on(large_file_close(opened.0)).is_ok());
        assert!(tauri::async_runtime::block_on(large_file_close(opened.0)).is_ok());
        assert_eq!(
            tauri::async_runtime::block_on(large_file_status(opened.0)).unwrap_err(),
            NOT_OPEN
        );
    }

    #[test]
    fn api_shapes_match_the_renderer() {
        let status = LargeFileStatus {
            id: 1,
            path: "/x".into(),
            size: 2,
            indexed_bytes: 3,
            line_count: 4,
            indexing: true,
            rotations: 5,
            missing: false,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({"id": 1, "path": "/x", "size": 2, "indexedBytes": 3,
                "lineCount": 4, "indexing": true, "rotations": 5, "missing": false,
                "error": null})
        );
        assert_eq!(
            serde_json::to_value(SearchHit {
                line: None,
                stopped_at: Some(7)
            })
            .unwrap(),
            serde_json::json!({"line": null, "stoppedAt": 7})
        );
        assert_eq!(
            serde_json::to_value(inactive_filter()).unwrap(),
            serde_json::json!({"active": false, "matched": 0, "scannedLines": 0,
                "done": true, "error": null})
        );
        let filter: LineFilter = serde_json::from_value(serde_json::json!({
            "include": [{"pattern": "a", "regex": true, "caseSensitive": true}],
            "exclude": [], "matchAll": true
        }))
        .unwrap();
        assert!(filter.match_all && filter.include[0].case_sensitive);
        for (json, expected) in [
            (serde_json::json!({"kind": "all"}), "All"),
            (serde_json::json!({"kind": "filtered"}), "Filtered"),
            (
                serde_json::json!({"kind": "range", "start": 1, "end": 2}),
                "Range",
            ),
            (
                serde_json::json!({"kind": "matching", "rules": []}),
                "Matching",
            ),
            (serde_json::json!({"kind": "lines", "lines": [3]}), "Lines"),
        ] {
            let selection: ExportSelection = serde_json::from_value(json).unwrap();
            assert!(format!("{selection:?}").starts_with(expected));
        }
    }
}
