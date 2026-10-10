//! macOS single-instance handoff.
//!
//! Replaces `tauri-plugin-single-instance` on macOS only. The plugin's macOS
//! implementation (`platform_impl/macos.rs`) uses the fixed path
//! `/tmp/<identifier>_si.sock` in world-writable `/tmp`, never checks who owns
//! the socket or who is on the other end, and exits after sending argv + cwd
//! to whoever is listening. Any other local account could bind that path
//! first and receive every launch.
//!
//! This version:
//! - puts the socket in the per-user temp directory
//!   (`confstr(_CS_DARWIN_USER_TEMP_DIR)`, `/var/folders/../T`, mode 0700),
//!   which other accounts can neither create entries in nor traverse, and
//!   refuses to use it unless it is a real directory owned by us and not
//!   group/other-writable;
//! - before connecting, `lstat`s the socket path and only connects to a
//!   socket owned by our uid (never follows a symlink);
//! - after connecting, checks the listener's uid with `getpeereid`, and on
//!   accept checks the client's uid the same way;
//! - bounds each message (size and time) so a stuck client cannot wedge the
//!   listener;
//! - re-binds if macOS's dirhelper (daily, files older than 3 days) removes
//!   the socket while ZITEXT is running;
//! - on exit unlinks the socket only if it is still the one we bound.
//!
//! Any failure falls back to launching normally without single-instance
//! (two windows), never to sending data to an unverified peer.
//!
//! Wire format is the plugin's: `cwd \0\0 arg0 \0 arg1 ...`, then EOF.

use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Development builds use their own socket, so `tauri dev` doesn't hand its
/// launch to an installed ZITEXT that is running (and exit).
#[cfg(not(debug_assertions))]
const SOCKET_NAME: &str = "com.zitrino.zitext.si.sock";
#[cfg(debug_assertions)]
const SOCKET_NAME: &str = "com.zitrino.zitext.dev.si.sock";
/// `sizeof(sockaddr_un.sun_path)` on macOS, including the trailing NUL.
const SUN_PATH_LEN: usize = 104;
const MAX_MESSAGE: usize = 1 << 20;
const IO_DEADLINE: Duration = Duration::from_secs(3);
/// How often the idle listener checks that its socket still exists.
const HEAL_INTERVAL_MS: libc::c_int = 60_000;

/// Listener bound in `acquire_or_exit`, waiting for `serve` to pick it up.
static PENDING: Mutex<Option<Primary>> = Mutex::new(None);
/// Path and (dev, ino) of the socket we currently own, for `cleanup`.
static BOUND: Mutex<Option<(PathBuf, (u64, u64))>> = Mutex::new(None);

pub(crate) struct Primary {
    listener: UnixListener,
    path: PathBuf,
    identity: (u64, u64),
}

pub(crate) enum Acquire {
    /// We are the first instance; the socket is bound.
    Primary(Primary),
    /// An instance of ours is already running and received our arguments.
    Delivered,
    /// Single-instance is not available; launch normally.
    Unavailable(String),
}

#[derive(Debug, PartialEq, Eq)]
enum Existing {
    Missing,
    /// A socket owned by the expected uid.
    OwnSocket,
    /// Something else owned by the expected uid (file, symlink, ...).
    OwnOther,
    /// Owned by another uid: never connect to it, never remove it.
    Foreign,
}

fn current_euid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

/// `/var/folders/xx/yyyy/T` for the current user (created on demand by the
/// system). Not `$TMPDIR`: LaunchServices and Terminal launches can differ.
fn user_temp_dir() -> Option<PathBuf> {
    // SAFETY: a null buffer with length 0 only queries the required size.
    let len = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, std::ptr::null_mut(), 0) };
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u8; len];
    // SAFETY: buf is writable for `len` bytes.
    let written =
        unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buf.as_mut_ptr().cast(), len) };
    if written == 0 || written > len {
        return None;
    }
    buf.truncate(written - 1); // drop the NUL
    while buf.len() > 1 && buf.last() == Some(&b'/') {
        buf.pop(); // lstat the directory itself, not what a trailing "/" resolves
    }
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(&buf)))
}

fn check_private_dir(dir: &Path, euid: u32) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("temp dir: {e}"))?;
    if !meta.file_type().is_dir() {
        return Err("temp dir is not a directory".into());
    }
    if meta.uid() != euid {
        return Err("temp dir is not owned by this user".into());
    }
    if meta.mode() & 0o022 != 0 {
        return Err("temp dir is group- or world-writable".into());
    }
    Ok(())
}

fn socket_path(dir: &Path) -> Result<PathBuf, String> {
    let path = dir.join(SOCKET_NAME);
    if path.as_os_str().len() >= SUN_PATH_LEN {
        return Err("socket path too long".into());
    }
    Ok(path)
}

fn classify(path: &Path, euid: u32) -> io::Result<Existing> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Existing::Missing),
        Err(e) => Err(e),
        Ok(meta) if meta.uid() != euid => Ok(Existing::Foreign),
        Ok(meta) if meta.file_type().is_socket() => Ok(Existing::OwnSocket),
        Ok(_) => Ok(Existing::OwnOther),
    }
}

fn identity(path: &Path) -> io::Result<(u64, u64)> {
    let meta = std::fs::symlink_metadata(path)?;
    Ok((meta.dev(), meta.ino()))
}

fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: valid connected socket fd and valid out-pointers.
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

pub(crate) fn encode(cwd: &str, args: &[String]) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(cwd.len() + 2 + args.iter().map(|a| a.len() + 1).sum::<usize>());
    out.extend_from_slice(cwd.as_bytes());
    out.extend_from_slice(b"\0\0");
    out.extend_from_slice(args.join("\0").as_bytes());
    out
}

/// Returns `(args, cwd)`, or None for a malformed message.
pub(crate) fn decode(bytes: Vec<u8>) -> Option<(Vec<String>, String)> {
    let text = String::from_utf8(bytes).ok()?;
    let (cwd, args) = text.split_once("\0\0")?;
    Some((
        args.split('\0').map(String::from).collect(),
        cwd.to_string(),
    ))
}

fn bind(path: &Path) -> io::Result<Primary> {
    let listener = UnixListener::bind(path)?;
    // The directory is already private; this is belt and braces.
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    let identity = identity(path)?;
    Ok(Primary {
        listener,
        path: path.to_path_buf(),
        identity,
    })
}

enum Connect {
    Delivered,
    Stale,
    Failed(String),
}

fn connect_and_send(path: &Path, payload: &[u8], euid: u32) -> Connect {
    let mut stream = match UnixStream::connect(path) {
        Ok(stream) => stream,
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => return Connect::Stale,
        Err(e) => return Connect::Failed(format!("connect: {e}")),
    };
    match peer_uid(&stream) {
        Ok(uid) if uid == euid => {}
        Ok(_) => return Connect::Failed("listener belongs to another user".into()),
        Err(e) => return Connect::Failed(format!("getpeereid: {e}")),
    }
    let _ = stream.set_write_timeout(Some(IO_DEADLINE));
    match stream
        .write_all(payload)
        .and_then(|_| stream.flush())
        .and_then(|_| stream.shutdown(std::net::Shutdown::Write))
    {
        Ok(()) => Connect::Delivered,
        Err(e) => Connect::Failed(format!("send: {e}")),
    }
}

pub(crate) fn acquire_in(dir: &Path, payload: &[u8], euid: u32) -> Acquire {
    if let Err(reason) = check_private_dir(dir, euid) {
        return Acquire::Unavailable(reason);
    }
    let path = match socket_path(dir) {
        Ok(path) => path,
        Err(reason) => return Acquire::Unavailable(reason),
    };
    // Second pass only if another instance won a bind race.
    for _ in 0..2 {
        match classify(&path, euid) {
            Err(e) => return Acquire::Unavailable(format!("lstat: {e}")),
            Ok(Existing::Foreign) => {
                return Acquire::Unavailable("socket path owned by another user".into())
            }
            Ok(Existing::OwnOther) => {
                // Only we can create entries in our private dir.
                if let Err(e) = std::fs::remove_file(&path) {
                    return Acquire::Unavailable(format!("remove non-socket: {e}"));
                }
            }
            Ok(Existing::OwnSocket) => match connect_and_send(&path, payload, euid) {
                Connect::Delivered => return Acquire::Delivered,
                Connect::Failed(reason) => return Acquire::Unavailable(reason),
                Connect::Stale => {
                    // Left behind by a crash; nobody is listening.
                    if let Err(e) = std::fs::remove_file(&path) {
                        return Acquire::Unavailable(format!("remove stale socket: {e}"));
                    }
                }
            },
            Ok(Existing::Missing) => {}
        }
        match bind(&path) {
            Ok(primary) => return Acquire::Primary(primary),
            Err(e) if e.kind() == io::ErrorKind::AddrInUse => continue,
            Err(e) => return Acquire::Unavailable(format!("bind: {e}")),
        }
    }
    Acquire::Unavailable("lost the bind race twice".into())
}

/// Call first thing in `run()`, before Tauri starts. Exits the process if an
/// existing instance accepted our arguments.
pub fn acquire_or_exit() {
    let Some(dir) = user_temp_dir() else {
        return;
    };
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let args: Vec<String> = std::env::args_os()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    match acquire_in(&dir, &encode(&cwd, &args), current_euid()) {
        Acquire::Delivered => std::process::exit(0),
        Acquire::Primary(primary) => {
            if let Ok(mut bound) = BOUND.lock() {
                *bound = Some((primary.path.clone(), primary.identity));
            }
            if let Ok(mut pending) = PENDING.lock() {
                *pending = Some(primary);
            }
        }
        Acquire::Unavailable(_reason) => {
            #[cfg(debug_assertions)]
            eprintln!("single-instance unavailable, launching normally: {_reason}");
        }
    }
}

/// Starts delivering secondary launches to `on_launch(args, cwd)`. Call once
/// from Tauri's `setup`; connections made before then wait in the backlog.
pub fn serve<F>(on_launch: F)
where
    F: FnMut(Vec<String>, String) + Send + 'static,
{
    let Some(primary) = PENDING.lock().ok().and_then(|mut p| p.take()) else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("single-instance".into())
        .spawn(move || listen(primary, on_launch));
}

/// Unlinks the socket if it is still the one we bound. Call on RunEvent::Exit.
pub fn cleanup() {
    if let Some((path, ours)) = BOUND.lock().ok().and_then(|mut b| b.take()) {
        remove_if_ours(&path, ours);
    }
}

fn remove_if_ours(path: &Path, ours: (u64, u64)) {
    if identity(path).ok() == Some(ours) {
        let _ = std::fs::remove_file(path);
    }
}

fn listen<F: FnMut(Vec<String>, String)>(mut primary: Primary, mut on_launch: F) {
    if primary.listener.set_nonblocking(true).is_err() {
        return;
    }
    loop {
        let mut pfd = libc::pollfd {
            fd: primary.listener.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut pfd, 1, HEAL_INTERVAL_MS) };
        if ready < 0 {
            if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                std::thread::sleep(Duration::from_secs(1));
            }
            continue;
        }
        if ready == 0 {
            heal(&mut primary);
            continue;
        }
        loop {
            match primary.listener.accept() {
                Ok((stream, _)) => {
                    if let Some((args, cwd)) = receive(stream, current_euid()) {
                        on_launch(args, cwd);
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    // e.g. EMFILE: back off instead of spinning on POLLIN.
                    std::thread::sleep(Duration::from_millis(200));
                    break;
                }
            }
        }
    }
}

/// Re-binds if our socket file disappeared (dirhelper cleans T daily).
/// Returns true if it re-bound. Never replaces a socket someone else made.
fn heal(primary: &mut Primary) -> bool {
    if !matches!(
        classify(&primary.path, current_euid()),
        Ok(Existing::Missing)
    ) {
        return false;
    }
    let Ok(fresh) = bind(&primary.path) else {
        return false;
    };
    if fresh.listener.set_nonblocking(true).is_err() {
        return false;
    }
    if let Ok(mut bound) = BOUND.lock() {
        *bound = Some((fresh.path.clone(), fresh.identity));
    }
    *primary = fresh;
    true
}

fn receive(mut stream: UnixStream, euid: u32) -> Option<(Vec<String>, String)> {
    // Accepted sockets inherit O_NONBLOCK from the listener on macOS.
    stream.set_nonblocking(false).ok()?;
    if peer_uid(&stream).ok()? != euid {
        return None;
    }
    let deadline = Instant::now() + IO_DEADLINE;
    let mut message = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        // macOS fails setsockopt with EINVAL once the peer has shut down;
        // reads then cannot block (buffered data, then EOF), so ignore it.
        let _ = stream.set_read_timeout(Some(left.max(Duration::from_millis(1))));
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                message.extend_from_slice(&chunk[..n]);
                if message.len() > MAX_MESSAGE {
                    return None;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    decode(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn private_dir() -> tempfile::TempDir {
        // tempfile creates directories with mode 0700.
        tempfile::tempdir().unwrap()
    }

    fn euid() -> u32 {
        current_euid()
    }

    fn accept_one(primary: &Primary) -> Option<(Vec<String>, String)> {
        let (stream, _) = primary.listener.accept().unwrap();
        receive(stream, euid())
    }

    #[test]
    fn real_user_temp_dir_is_private_and_short_enough() {
        let dir = user_temp_dir().expect("confstr");
        check_private_dir(&dir, euid()).expect("private");
        socket_path(&dir).expect("fits in sun_path");
    }

    #[test]
    fn first_instance_binds_second_delivers() {
        let dir = private_dir();
        let Acquire::Primary(primary) = acquire_in(dir.path(), b"x", euid()) else {
            panic!("expected primary");
        };
        let mode = std::fs::symlink_metadata(&primary.path).unwrap().mode();
        assert_eq!(mode & 0o077, 0, "socket must be owner-only");

        let args = vec![
            "zitext".to_string(),
            "--wait-lock".into(),
            "/a b/\nc.txt".into(),
        ];
        let payload = encode("/", &args);
        let sender = {
            let dir = dir.path().to_path_buf();
            std::thread::spawn(move || {
                matches!(acquire_in(&dir, &payload, euid()), Acquire::Delivered)
            })
        };
        assert_eq!(accept_one(&primary), Some((args, "/".to_string())));
        assert!(sender.join().unwrap());
    }

    #[test]
    fn stale_socket_is_replaced() {
        let dir = private_dir();
        let path = socket_path(dir.path()).unwrap();
        drop(UnixListener::bind(&path).unwrap()); // std does not unlink on drop
        assert!(matches!(
            acquire_in(dir.path(), b"x", euid()),
            Acquire::Primary(_)
        ));
    }

    #[test]
    fn own_regular_file_or_symlink_is_removed_not_followed() {
        let dir = private_dir();
        let path = socket_path(dir.path()).unwrap();
        std::fs::write(&path, b"junk").unwrap();
        assert!(matches!(
            acquire_in(dir.path(), b"x", euid()),
            Acquire::Primary(_)
        ));

        // A symlink to a live listener elsewhere must not receive anything.
        let dir = private_dir();
        let elsewhere = private_dir();
        let target = elsewhere.path().join("other.sock");
        let decoy = UnixListener::bind(&target).unwrap();
        decoy.set_nonblocking(true).unwrap();
        symlink(&target, socket_path(dir.path()).unwrap()).unwrap();
        assert!(matches!(
            acquire_in(dir.path(), b"secret", euid()),
            Acquire::Primary(_)
        ));
        assert_eq!(
            decoy.accept().unwrap_err().kind(),
            io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn foreign_owned_socket_is_never_contacted() {
        // Simulate "owned by another uid" by checking against a different uid.
        let dir = private_dir();
        let path = socket_path(dir.path()).unwrap();
        let _l = UnixListener::bind(&path).unwrap();
        assert_eq!(classify(&path, euid() + 1).unwrap(), Existing::Foreign);
    }

    #[test]
    fn listener_of_another_uid_gets_nothing() {
        let dir = private_dir();
        let Acquire::Primary(primary) = acquire_in(dir.path(), b"x", euid()) else {
            panic!();
        };
        // Expecting a different uid: peer check must fail before any write.
        assert!(matches!(
            connect_and_send(&primary.path, b"secret", euid() + 1),
            Connect::Failed(_)
        ));
        let (mut stream, _) = primary.listener.accept().unwrap();
        let mut got = Vec::new();
        stream.read_to_end(&mut got).unwrap();
        assert!(got.is_empty());
    }

    #[test]
    fn client_of_another_uid_is_ignored() {
        let (client, server) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&server).unwrap(), euid());
        let mut c = client;
        c.write_all(&encode("/", &["a".into()])).unwrap();
        drop(c);
        assert_eq!(receive(server, euid() + 1), None);
    }

    #[test]
    fn unsafe_dirs_are_refused() {
        let dir = private_dir();
        for mode in [0o777, 0o770, 0o722] {
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(matches!(
                acquire_in(dir.path(), b"x", euid()),
                Acquire::Unavailable(_)
            ));
        }
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(matches!(
            acquire_in(dir.path(), b"x", euid() + 1),
            Acquire::Unavailable(_)
        ));
        // A symlink to a private dir is refused too (lstat, not stat).
        let link_parent = private_dir();
        let link = link_parent.path().join("T");
        symlink(dir.path(), &link).unwrap();
        assert!(matches!(
            acquire_in(&link, b"x", euid()),
            Acquire::Unavailable(_)
        ));
    }

    #[test]
    fn too_long_path_is_refused() {
        let dir = private_dir();
        let deep = dir.path().join("d".repeat(SUN_PATH_LEN));
        std::fs::create_dir(&deep).unwrap();
        assert!(matches!(
            acquire_in(&deep, b"x", euid()),
            Acquire::Unavailable(_)
        ));
    }

    #[test]
    fn oversized_slow_or_malformed_messages_are_dropped() {
        let (mut c, s) = UnixStream::pair().unwrap();
        let big = vec![b'a'; MAX_MESSAGE + 10];
        let w = std::thread::spawn(move || {
            let _ = c.write_all(&big);
        });
        assert_eq!(receive(s, euid()), None);
        w.join().unwrap();

        let (mut c, s) = UnixStream::pair().unwrap();
        c.write_all(b"\xff\xfe\0\0a").unwrap();
        drop(c);
        assert_eq!(receive(s, euid()), None);

        let (mut c, s) = UnixStream::pair().unwrap();
        c.write_all(b"no separator").unwrap();
        drop(c);
        assert_eq!(receive(s, euid()), None);

        // A client that never sends EOF is cut off at the deadline.
        let (_c, s) = UnixStream::pair().unwrap();
        let start = Instant::now();
        assert_eq!(receive(s, euid()), None);
        assert!(start.elapsed() < IO_DEADLINE + Duration::from_secs(1));
    }

    #[test]
    fn heal_rebinds_only_when_missing() {
        let dir = private_dir();
        let Acquire::Primary(mut primary) = acquire_in(dir.path(), b"x", euid()) else {
            panic!();
        };
        assert!(!heal(&mut primary), "still present: nothing to do");
        std::fs::remove_file(&primary.path).unwrap();
        assert!(heal(&mut primary));
        assert!(UnixStream::connect(&primary.path).is_ok());
    }

    #[test]
    fn cleanup_only_removes_our_own_socket() {
        let dir = private_dir();
        let Acquire::Primary(primary) = acquire_in(dir.path(), b"x", euid()) else {
            panic!();
        };
        // Someone else's socket now sits at the path.
        std::fs::remove_file(&primary.path).unwrap();
        let _other = UnixListener::bind(&primary.path).unwrap();
        remove_if_ours(&primary.path, primary.identity);
        assert!(primary.path.exists());

        let dir = private_dir();
        let Acquire::Primary(primary) = acquire_in(dir.path(), b"x", euid()) else {
            panic!();
        };
        remove_if_ours(&primary.path, primary.identity);
        assert!(!primary.path.exists());
    }

    #[test]
    fn serve_delivers_to_callback() {
        let dir = private_dir();
        let Acquire::Primary(primary) = acquire_in(dir.path(), b"x", euid()) else {
            panic!();
        };
        let path = primary.path.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || listen(primary, move |a, c| tx.send((a, c)).unwrap()));
        assert!(matches!(
            connect_and_send(&path, &encode("/w", &["z".into(), "f".into()]), euid()),
            Connect::Delivered
        ));
        let got = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            got,
            (vec!["z".to_string(), "f".to_string()], "/w".to_string())
        );
    }
}
