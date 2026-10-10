// ---------------------------------------------------------------------------
// MCP server: how a Claude Code run sees the database.
//
// Claude is the client here and IntelQuery the server, the same way round as
// pressroom. The app never calls an API: it spawns the Claude Code CLI (see
// claude.rs), which runs on the user's own subscription and talks back to this
// server over stdio. That is the entire reason no API key is needed.
//
// The server is this same binary started as `intelquery mcp <context.json>`. It
// does not open the database. The GUI process owns the live pool, and a second
// connection made from here would need the password out of the keychain for
// nothing — so the GUI writes the schema it already has cached to a file, and
// this serves that file. The run cannot read a row of data, only its shape.
//
// Hand-rolled stdio JSON-RPC rather than an SDK: four tools, one file, and no
// async — a dependency would be the largest part of it.
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// What one run is allowed to know. Written by the GUI, read only here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunContext {
    pub dialect: String,
    /// Tables the user @-tagged. A hint, not a limit.
    pub focus: Vec<String>,
    pub tables: Vec<ContextTable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextTable {
    pub name: String,
    pub columns: Vec<ContextColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
}

/// What the run hands back. Written here, read by the GUI once the CLI exits.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    Sql(String),
    Refuse(String),
}

pub const ANSWER_FILE: &str = "answer.json";

/// The tool names a run is allowed, as `--allowedTools` spells them.
pub const TOOL_NAMES: [&str; 4] = ["list_tables", "describe_tables", "submit_sql", "refuse"];

/// Kept in step with REFUSAL_REASONS in src/services/llm.ts, minus `malformed`,
/// which is the frontend's verdict on output and never something to choose.
const REFUSAL_REASONS: [&str; 7] = [
    "greeting",
    "off_topic",
    "prompt_injection",
    "abusive",
    "out_of_schema",
    "ambiguous",
    "non_sql_task",
];

const READ_PREFIXES: [&str; 7] = ["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "PRAGMA"];

fn tools() -> Value {
    json!([
        {
            "name": "list_tables",
            "description": "Every table in the connected database, with the SQL dialect and how many columns each has. \
                            Call this first. `focus` lists tables the person tagged in their question; start there.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "describe_tables",
            "description": "The columns of the named tables: name, type and whether it is nullable. \
                            Check every column you use here rather than guessing a name.",
            "inputSchema": {
                "type": "object",
                "properties": { "tables": { "type": "array", "items": { "type": "string" } } },
                "required": ["tables"]
            }
        },
        {
            "name": "submit_sql",
            "description": "Hand back the answer: exactly one read-only query (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN or PRAGMA) \
                            in the database's dialect. The person reviews it before anything runs. Call this once, then stop.",
            "inputSchema": {
                "type": "object",
                "properties": { "sql": { "type": "string" } },
                "required": ["sql"]
            }
        },
        {
            "name": "refuse",
            "description": "Hand back a refusal instead of SQL, when the question is not a data question this schema can answer. \
                            Call this once, then stop.",
            "inputSchema": {
                "type": "object",
                "properties": { "reason": { "type": "string", "enum": REFUSAL_REASONS } },
                "required": ["reason"]
            }
        }
    ])
}

struct Server {
    ctx: RunContext,
    answer_path: PathBuf,
}

impl Server {
    fn call(&self, name: &str, args: &Value) -> Result<Value, String> {
        match name {
            "list_tables" => Ok(json!({
                "dialect": self.ctx.dialect,
                "focus": self.ctx.focus,
                "tables": self.ctx.tables.iter()
                    .map(|t| json!({ "name": t.name, "columns": t.columns.len() }))
                    .collect::<Vec<_>>(),
            })),
            "describe_tables" => {
                let wanted: Vec<String> = args
                    .get("tables")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let mut found = Vec::new();
                let mut unknown = Vec::new();
                for w in &wanted {
                    match self.ctx.tables.iter().find(|t| t.name.eq_ignore_ascii_case(w)) {
                        Some(t) => found.push(t),
                        None => unknown.push(w.clone()),
                    }
                }
                Ok(json!({ "tables": found, "unknown": unknown }))
            }
            "submit_sql" => {
                let sql = args.get("sql").and_then(Value::as_str).unwrap_or("").trim();
                let head = sql.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
                // Checked here so the model can correct itself within the run. The
                // frontend's safety analyzer still gates execution regardless.
                if !READ_PREFIXES.contains(&head.as_str()) {
                    return Err("that is not a read query. Submit one SELECT/WITH/SHOW/DESCRIBE/EXPLAIN/PRAGMA statement, or refuse.".into());
                }
                self.write(&Answer::Sql(sql.to_string()))?;
                Ok(json!({ "ok": true, "note": "Received. You are done; reply with one word and stop." }))
            }
            "refuse" => {
                let reason = args.get("reason").and_then(Value::as_str).unwrap_or("");
                if !REFUSAL_REASONS.contains(&reason) {
                    return Err(format!("reason must be one of: {}", REFUSAL_REASONS.join(", ")));
                }
                self.write(&Answer::Refuse(reason.to_string()))?;
                Ok(json!({ "ok": true, "note": "Received. You are done; reply with one word and stop." }))
            }
            other => Err(format!("no tool {}", other)),
        }
    }

    fn write(&self, answer: &Answer) -> Result<(), String> {
        let body = serde_json::to_vec(answer).map_err(|e| e.to_string())?;
        std::fs::write(&self.answer_path, body).map_err(|e| format!("could not record the answer: {}", e))
    }

    fn handle(&self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let result = match method {
            "initialize" => json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "intelquery", "version": env!("CARGO_PKG_VERSION") }
            }),
            "tools/list" => json!({ "tools": tools() }),
            "tools/call" => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                // A tool error is a result the model should read and act on,
                // not a transport fault.
                match self.call(name, &args) {
                    Ok(out) => json!({ "content": [{ "type": "text", "text": out.to_string() }] }),
                    Err(e) => json!({ "content": [{ "type": "text", "text": format!("error: {}", e) }], "isError": true }),
                }
            }
            "ping" => json!({}),
            _ => {
                // Notifications (no id) get no reply at all.
                return id.map(|id| json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32601, "message": format!("no method {}", method) }
                }));
            }
        };
        id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }
}

/// Run until stdin closes. Called from main.rs before Tauri starts.
pub fn serve(context_path: &Path) -> Result<(), String> {
    let raw = std::fs::read(context_path)
        .map_err(|e| format!("could not read {}: {}", context_path.display(), e))?;
    let ctx: RunContext = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let answer_path = context_path
        .parent()
        .ok_or("context file has no folder")?
        .join(ANSWER_FILE);
    let server = Server { ctx, answer_path };

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(reply) = server.handle(&msg) {
            writeln!(stdout, "{}", reply).map_err(|e| e.to_string())?;
            stdout.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
