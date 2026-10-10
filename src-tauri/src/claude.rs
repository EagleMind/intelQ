// ---------------------------------------------------------------------------
// Running the Claude Code CLI, so SQL generation can use a Claude subscription
// instead of an OpenRouter key.
//
// Ported from pressroom's src/core/claude.js; the reasons below were learned
// there and still apply.
//
// The CLI runs in print mode against IntelQuery's own MCP server (mcp.rs). Two
// things it deliberately does not do:
//
//   - No API key. If somebody is signed in to Claude Code this works; if not,
//     it says so rather than asking for a key.
//   - No open-ended permissions. Built-in tools are switched off with `--tools ""`
//     and only the four intelquery tools are allowed. The question is typed by a
//     person, but the schema it is answered against is not theirs to vouch for —
//     a column comment is enough to carry an instruction — so nothing in a run
//     can reach the filesystem or a shell.
// ---------------------------------------------------------------------------

use crate::mcp::{Answer, RunContext, ANSWER_FILE, TOOL_NAMES};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::oneshot;

const RUN_TIMEOUT: Duration = Duration::from_secs(180);
const STATUS_TIMEOUT: Duration = Duration::from_secs(15);

const NOT_FOUND: &str = "Could not find the Claude Code CLI. Install Claude Code, \
    or set its full path in AI settings under 'Claude command'.";

#[cfg(windows)]
const EXE: &str = "claude.exe";
#[cfg(not(windows))]
const EXE: &str = "claude";

// ---------------------------------------------------------------------------
// Finding the CLI
// ---------------------------------------------------------------------------

/// The copy the desktop app ships with, newest version first.
///
/// It is usually not on PATH even when Claude Code is plainly installed. It lives
/// in a folder named after its version and, from about 2.1.28x, one level further
/// down in a folder named after a hash next to a `.verified` marker; missing that
/// extra level is what "not found" meant on a machine with two copies installed.
fn desktop_bundled() -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("Claude").join("claude-code"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        // The Store install keeps it under its package folder instead.
        let packages = PathBuf::from(local).join("Packages");
        for entry in std::fs::read_dir(&packages).into_iter().flatten().flatten() {
            if entry.file_name().to_string_lossy().starts_with("Claude") {
                roots.push(entry.path().join("LocalCache").join("Roaming").join("Claude").join("claude-code"));
            }
        }
    }
    if let Some(home) = home_dir() {
        roots.push(home.join("Library").join("Application Support").join("Claude").join("claude-code"));
    }

    let mut found: Vec<(Vec<u64>, PathBuf)> = Vec::new();
    for versions in roots {
        for v in std::fs::read_dir(&versions).into_iter().flatten().flatten() {
            let dir = v.path();
            let version: Vec<u64> = v
                .file_name()
                .to_string_lossy()
                .split('.')
                .map(|p| p.parse().unwrap_or(0))
                .collect();
            let direct = dir.join(EXE);
            if direct.is_file() {
                found.push((version, direct));
                continue;
            }
            // A hash folder without `.verified` may be a download still in progress.
            let hashed: Vec<PathBuf> = std::fs::read_dir(&dir)
                .into_iter()
                .flatten()
                .flatten()
                .map(|h| h.path())
                .filter(|h| h.join(EXE).is_file())
                .collect();
            let pick = hashed
                .iter()
                .find(|h| h.join(".verified").exists())
                .or_else(|| hashed.first());
            if let Some(h) = pick {
                found.push((version, h.join(EXE)));
            }
        }
    }
    // Numeric, not lexical: 2.1.9 is older than 2.1.10.
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().next().map(|(_, p)| p)
}

/// PATH, searched directly rather than through `where`/`which`: a GUI app on
/// macOS does not get the shell's PATH anyway, and on Windows `where` lists the
/// npm shim's extensionless shell script first, which cannot be executed.
fn on_path() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

fn usual_places() -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        c.push(home.join(".claude").join("local").join(EXE));
        c.push(home.join(".local").join("bin").join(EXE));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        c.push(PathBuf::from(local).join("Programs").join("claude").join("claude.exe"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        c.push(PathBuf::from(appdata).join("npm").join("claude.cmd"));
    }
    c.push("/usr/local/bin/claude".into());
    c.push("/opt/homebrew/bin/claude".into());
    c.into_iter().find(|p| p.is_file())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// A configured path wins, then PATH, then the desktop app's copy, then the
/// usual places. Not cached: a miss cached for the process lifetime meant
/// installing the CLI changed nothing until a restart, which nobody would guess.
pub fn find_claude(configured: Option<&str>) -> Option<PathBuf> {
    if let Some(c) = configured.map(str::trim).filter(|c| !c.is_empty()) {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    on_path().or_else(desktop_bundled).or_else(usual_places)
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/// Variables that would outrank the CLI's own sign-in. When IntelQuery is started
/// from inside a desktop-app session (e.g. `tauri dev` from a Claude Code
/// terminal) it inherits that session's proxied base URL and host-refreshed
/// sign-in, and the CLI would follow those. A stray `ANTHROPIC_API_KEY` is also
/// how a subscription run silently becomes a metered one.
const INHERITED_AUTH: [&str; 17] = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH", "CLAUDE_CODE_ACCOUNT_UUID", "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_USER_EMAIL", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_PID",
];

fn command(cli: &Path) -> Command {
    let mut cmd = Command::new(cli);
    for k in INHERITED_AUTH {
        cmd.env_remove(k);
    }
    // Only the desktop app's own plumbing is dropped; a base URL or config folder
    // somebody set themselves is theirs.
    if std::env::var_os("CLAUDE_CODE_DESKTOP_APP_VERSION").is_some() {
        cmd.env_remove("ANTHROPIC_BASE_URL");
        cmd.env_remove("CLAUDE_CONFIG_DIR");
        cmd.env_remove("CLAUDE_CODE_DESKTOP_APP_VERSION");
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: no console flashing up behind the app on every query.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub found: bool,
    pub path: Option<String>,
    pub signed_in: bool,
    pub email: Option<String>,
    pub org: Option<String>,
    pub plan: Option<String>,
    pub error: Option<String>,
}

/// Who the CLI is signed in as, asked of the CLI itself. Reading its credentials
/// file would say a token exists, not whose it is or whether it still works.
/// `auth status` exits non-zero when nobody is signed in, with the same JSON.
pub async fn status(configured: Option<&str>) -> ClaudeStatus {
    let Some(cli) = find_claude(configured) else {
        return ClaudeStatus { error: Some(NOT_FOUND.into()), ..Default::default() };
    };
    let mut s = ClaudeStatus { found: true, path: Some(cli.display().to_string()), ..Default::default() };
    let mut cmd = command(&cli);
    cmd.args(["auth", "status", "--json"]);
    let out = match tokio::time::timeout(STATUS_TIMEOUT, cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            s.error = Some(format!("Could not start Claude Code: {}", e));
            return s;
        }
        Err(_) => {
            s.error = Some("Claude Code did not answer within 15 seconds.".into());
            return s;
        }
    };
    match serde_json::from_slice::<serde_json::Value>(&out.stdout) {
        Ok(v) => {
            let text = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
            s.signed_in = v.get("loggedIn").and_then(|x| x.as_bool()).unwrap_or(false);
            s.email = text("email");
            s.org = text("orgName");
            s.plan = text("subscriptionType");
            if !s.signed_in {
                s.error = Some(sign_in_message());
            }
        }
        Err(_) => s.error = Some("Claude Code did not report its sign-in status.".into()),
    }
    s
}

/// Separate from the desktop app's sign-in: the CLI keeps its own session, and
/// when it lapses a run fails with "Failed to authenticate".
fn sign_in_message() -> String {
    "Claude Code is not signed in. Its sign-in is separate from the desktop app: open a terminal, \
     run `claude auth login` (or `claude` and then /login), complete it once, then try again."
        .into()
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

pub struct RunRequest {
    pub prompt: String,
    pub model: Option<String>,
    pub cli_path: Option<String>,
}

/// Answer one question. Returns SQL, or a `REFUSE: <reason>` line — the same
/// shape the HTTP providers return, so the frontend's `classifyResponse` treats
/// every provider alike.
pub async fn generate(
    ctx: RunContext,
    req: RunRequest,
    cancel: oneshot::Receiver<()>,
) -> Result<String, String> {
    let cli = find_claude(req.cli_path.as_deref()).ok_or(NOT_FOUND)?;

    // One folder per run: the context, the MCP config and the answer. The CLI's
    // working directory too, so it does not pick up a CLAUDE.md or project
    // settings from wherever IntelQuery happened to be launched.
    let dir = std::env::temp_dir().join("intelquery-claude").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create a run folder: {}", e))?;
    let result = run_in(&cli, &dir, ctx, req, cancel).await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

async fn run_in(
    cli: &Path,
    dir: &Path,
    ctx: RunContext,
    req: RunRequest,
    cancel: oneshot::Receiver<()>,
) -> Result<String, String> {
    let context_path = dir.join("context.json");
    std::fs::write(&context_path, serde_json::to_vec(&ctx).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Could not write the run context: {}", e))?;

    // The server is handed over explicitly with --strict-mcp-config, so whatever
    // else the user has registered stays out of a run that has no use for it.
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let mcp_config = serde_json::json!({
        "mcpServers": { "intelquery": {
            "command": me.display().to_string(),
            "args": ["mcp", context_path.display().to_string()],
        } }
    });
    let mcp_path = dir.join("mcp.json");
    std::fs::write(&mcp_path, mcp_config.to_string())
        .map_err(|e| format!("Could not write the MCP config: {}", e))?;

    let allowed = TOOL_NAMES
        .iter()
        .map(|t| format!("mcp__intelquery__{}", t))
        .collect::<Vec<_>>()
        .join(",");

    let mut cmd = command(cli);
    // The prompt goes in on stdin, never as an argument: through cmd.exe (the npm
    // shim is a .cmd) a multi-line argument is cut at the first newline, and
    // pressroom lost --allowedTools to exactly that, silently.
    cmd.current_dir(dir).stdin(Stdio::piped()).args([
        "-p",
        "--tools", "",
        "--allowedTools", &allowed,
        "--mcp-config", &mcp_path.display().to_string(),
        "--strict-mcp-config",
        "--no-session-persistence",
        "--output-format", "text",
    ]);
    if let Some(m) = req.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        cmd.args(["--model", m]);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Could not start Claude Code: {}", e))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    stdin.write_all(req.prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);

    // Drained concurrently: a child blocked on a full pipe never exits.
    let mut out = child.stdout.take().ok_or("no stdout")?;
    let mut err = child.stderr.take().ok_or("no stderr")?;
    let out_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s).await;
        s
    });
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s).await;
        s
    });

    let exit = tokio::select! {
        status = child.wait() => Some(status.map_err(|e| e.to_string())?),
        _ = cancel => None,
        _ = tokio::time::sleep(RUN_TIMEOUT) => {
            let _ = child.kill().await;
            return Err(format!("Claude ran for {} seconds without answering, so it was stopped.", RUN_TIMEOUT.as_secs()));
        }
    };
    let Some(exit) = exit else {
        let _ = child.kill().await;
        return Err("Cancelled: a newer question replaced this one.".into());
    };

    let stdout = out_task.await.unwrap_or_default();
    let stderr = err_task.await.unwrap_or_default();

    // The tool call is the answer. Stdout is only the fallback, for a model that
    // wrote the query out instead of submitting it.
    if let Ok(raw) = std::fs::read(dir.join(ANSWER_FILE)) {
        if let Ok(answer) = serde_json::from_slice::<Answer>(&raw) {
            return Ok(match answer {
                Answer::Sql(sql) => sql,
                Answer::Refuse(reason) => format!("REFUSE: {}", reason),
            });
        }
    }

    let log = format!("{}\n{}", stdout.trim(), stderr.trim());
    if exit.success() && !stdout.trim().is_empty() {
        return Ok(stdout.trim().to_string());
    }
    let lower = log.to_lowercase();
    if ["not logged in", "unauthorized", "authenticate", "oauth", "/login"].iter().any(|k| lower.contains(k)) {
        return Err(sign_in_message());
    }
    let tail: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(3)..].join(" ");
    Err(format!(
        "Claude Code exited ({}) without an answer.{}",
        exit.code().map(|c| format!("code {}", c)).unwrap_or_else(|| "killed".into()),
        if tail.is_empty() { String::new() } else { format!(" Last output: {}", tail) }
    ))
}
