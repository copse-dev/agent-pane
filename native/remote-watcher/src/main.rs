//! Streaming file watcher Copse runs on an SSH workspace host.
//!
//! Speaks NDJSON on stdio: one JSON command per stdin line, one JSON event per
//! stdout line. The protocol is documented in README.md next to this crate and
//! mirrored by `remote-native-watcher.ts` on the client.
//!
//! Lifetime contract: **this process exits the moment stdin reaches EOF.** The
//! client spawns it without `setsid` but sshd still detaches sessions in ways
//! that can outlive a dropped connection, so stdin EOF — which a closed SSH
//! channel always delivers — is the one signal guaranteed to arrive. Nothing
//! here may block that exit.
//!
//! Watch strategy: for a plain (non-recursive) subscription to a file, the
//! watcher registers on the file's **parent directory** and filters events to
//! subscribed paths. Editors overwhelmingly save via write-temp-then-rename;
//! watching the file's inode directly goes quiet after the first rename, while
//! the parent directory sees every replacement. Directories are registered
//! once and shared by all subscriptions inside them, keeping the inotify
//! watch budget proportional to distinct parent dirs, not files.
//!
//! Backend strategy: the platform-native watcher (inotify / FSEvents /
//! kqueue) is tried first; if registration fails — `max_user_watches`
//! exhaustion, an NFS mount that never delivers events cannot be detected
//! here, but outright registration errors can — the path falls back to a
//! polling watcher inside this same process. Only when both fail does the
//! client hear `watch-failed` and take over with its own remote polling.

use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::json;

const PROTOCOL: u32 = 1;
const POLL_FALLBACK_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
struct Command {
    op: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    recursive: bool,
}

/// Paths the client asked about, shared with watcher callback threads so
/// events can be filtered before they cost a stdout line.
#[derive(Default)]
struct Subscriptions {
    files: HashSet<PathBuf>,
    recursive_roots: Vec<PathBuf>,
}

impl Subscriptions {
    fn matches(&self, path: &Path) -> bool {
        self.files.contains(path) || self.recursive_roots.iter().any(|root| path.starts_with(root))
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Backend {
    Native,
    Poll,
}

impl Backend {
    fn label(self) -> &'static str {
        match self {
            Backend::Native => "native",
            Backend::Poll => "poll",
        }
    }
}

fn kind_label(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        _ => "other",
    }
}

fn make_handler(
    out: Sender<String>,
    subs: Arc<Mutex<Subscriptions>>,
) -> impl FnMut(notify::Result<Event>) + Send + 'static {
    move |res| match res {
        Ok(event) => {
            // Access events are pure noise for edit detection and on some
            // platforms fire for every read the poller itself performs.
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let kind = kind_label(&event.kind);
            let subs = match subs.lock() {
                Ok(subs) => subs,
                Err(_) => return,
            };
            for path in &event.paths {
                if !subs.matches(path) {
                    continue;
                }
                let size = std::fs::metadata(path)
                    .ok()
                    .filter(|meta| meta.is_file())
                    .map(|meta| meta.len());
                let _ = out.send(
                    json!({
                        "event": "change",
                        "path": path.to_string_lossy(),
                        "kind": kind,
                        "size": size,
                    })
                    .to_string(),
                );
            }
        }
        Err(err) => {
            let _ = out.send(
                json!({ "event": "error", "message": err.to_string() }).to_string(),
            );
        }
    }
}

struct App {
    out: Sender<String>,
    subs: Arc<Mutex<Subscriptions>>,
    native: Option<RecommendedWatcher>,
    poll: Option<PollWatcher>,
    /// Watched directory -> (backend holding it, subscribed children inside it).
    dirs: HashMap<PathBuf, (Backend, HashSet<PathBuf>)>,
    /// Recursive roots -> backend holding them.
    roots: HashMap<PathBuf, Backend>,
}

impl App {
    fn new(out: Sender<String>, subs: Arc<Mutex<Subscriptions>>) -> Self {
        // A host where inotify init itself fails (fd exhaustion) still gets
        // the in-process polling backend rather than nothing.
        let native = notify::recommended_watcher(make_handler(out.clone(), subs.clone())).ok();
        App {
            out,
            subs,
            native,
            poll: None,
            dirs: HashMap::new(),
            roots: HashMap::new(),
        }
    }

    fn send(&self, value: serde_json::Value) {
        let _ = self.out.send(value.to_string());
    }

    /// Register `path` with the native backend, falling back to polling.
    fn register(&mut self, path: &Path, mode: RecursiveMode) -> Option<Backend> {
        if let Some(native) = self.native.as_mut() {
            if native.watch(path, mode).is_ok() {
                return Some(Backend::Native);
            }
        }
        if self.poll.is_none() {
            let handler = make_handler(self.out.clone(), self.subs.clone());
            let config = Config::default().with_poll_interval(POLL_FALLBACK_INTERVAL);
            self.poll = PollWatcher::new(handler, config).ok();
        }
        let poll = self.poll.as_mut()?;
        poll.watch(path, mode).ok().map(|_| Backend::Poll)
    }

    fn unregister(&mut self, path: &Path, backend: Backend) {
        let result = match backend {
            Backend::Native => self.native.as_mut().map(|w| w.unwatch(path)),
            Backend::Poll => self.poll.as_mut().map(|w| w.unwatch(path)),
        };
        // A failed unwatch (already-deleted dir) leaks one dead registration,
        // never correctness; not worth surfacing to the client.
        drop(result);
    }

    fn watch(&mut self, path: PathBuf, recursive: bool) {
        if recursive {
            if self.roots.contains_key(&path) {
                return;
            }
            match self.register(&path, RecursiveMode::Recursive) {
                Some(backend) => {
                    if let Ok(mut subs) = self.subs.lock() {
                        subs.recursive_roots.push(path.clone());
                    }
                    self.roots.insert(path.clone(), backend);
                    self.send(json!({
                        "event": "watching",
                        "path": path.to_string_lossy(),
                        "backend": backend.label(),
                    }));
                }
                None => self.send(json!({
                    "event": "watch-failed",
                    "path": path.to_string_lossy(),
                })),
            }
            return;
        }

        if let Ok(subs) = self.subs.lock() {
            if subs.files.contains(&path) {
                return;
            }
        }
        // Watch the parent so rename-style saves keep reporting; fall back to
        // the path itself at filesystem roots.
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone());
        if let Some((backend, children)) = self.dirs.get_mut(&dir) {
            children.insert(path.clone());
            let backend = *backend;
            if let Ok(mut subs) = self.subs.lock() {
                subs.files.insert(path.clone());
            }
            self.send(json!({
                "event": "watching",
                "path": path.to_string_lossy(),
                "backend": backend.label(),
            }));
            return;
        }
        match self.register(&dir, RecursiveMode::NonRecursive) {
            Some(backend) => {
                let mut children = HashSet::new();
                children.insert(path.clone());
                self.dirs.insert(dir, (backend, children));
                if let Ok(mut subs) = self.subs.lock() {
                    subs.files.insert(path.clone());
                }
                self.send(json!({
                    "event": "watching",
                    "path": path.to_string_lossy(),
                    "backend": backend.label(),
                }));
            }
            None => self.send(json!({
                "event": "watch-failed",
                "path": path.to_string_lossy(),
            })),
        }
    }

    fn unwatch(&mut self, path: PathBuf) {
        if let Some(backend) = self.roots.remove(&path) {
            if let Ok(mut subs) = self.subs.lock() {
                subs.recursive_roots.retain(|root| root != &path);
            }
            self.unregister(&path, backend);
            return;
        }
        if let Ok(mut subs) = self.subs.lock() {
            if !subs.files.remove(&path) {
                return;
            }
        }
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone());
        let emptied = match self.dirs.get_mut(&dir) {
            Some((_, children)) => {
                children.remove(&path);
                children.is_empty()
            }
            None => false,
        };
        if emptied {
            if let Some((backend, _)) = self.dirs.remove(&dir) {
                self.unregister(&dir, backend);
            }
        }
    }

    fn handle(&mut self, cmd: Command) {
        match (cmd.op.as_str(), cmd.path) {
            ("watch", Some(path)) => self.watch(PathBuf::from(path), cmd.recursive),
            ("unwatch", Some(path)) => self.unwatch(PathBuf::from(path)),
            ("ping", _) => self.send(json!({ "event": "pong" })),
            (op, _) => self.send(json!({
                "event": "error",
                "message": format!("unknown or malformed command: {op}"),
            })),
        }
    }
}

fn main() {
    if std::env::args().any(|arg| arg == "--version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let (out, rx) = mpsc::channel::<String>();
    // Single writer thread: watcher callbacks arrive on backend threads and
    // commands are acked from the main thread; serializing through one channel
    // keeps NDJSON lines whole. A write error means the SSH channel is gone —
    // the same terminal condition as stdin EOF.
    thread::spawn(move || {
        let stdout = io::stdout();
        let mut stdout = stdout.lock();
        for line in rx {
            if writeln!(stdout, "{line}").is_err() || stdout.flush().is_err() {
                std::process::exit(0);
            }
        }
    });

    let subs = Arc::new(Mutex::new(Subscriptions::default()));
    let mut app = App::new(out.clone(), subs);
    let _ = out.send(
        json!({
            "event": "ready",
            "protocol": PROTOCOL,
            "version": env!("CARGO_PKG_VERSION"),
        })
        .to_string(),
    );

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(line) {
            Ok(cmd) => app.handle(cmd),
            Err(err) => {
                let _ = out
                    .send(json!({ "event": "error", "message": err.to_string() }).to_string());
            }
        }
    }

    // stdin EOF: the connection (or the client) is gone. Exit immediately —
    // this is the orphan-prevention contract, see module docs.
    std::process::exit(0);
}
