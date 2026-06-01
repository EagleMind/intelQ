# IntelQuery

**A desktop database client that lets you query your database in plain English.**

Connect to MySQL, PostgreSQL, or SQLite, describe what you want to know in natural language, and let an AI generate the SQL for you. Review the query, execute it, and see the results — all in a single desktop app that runs locally.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Status](https://img.shields.io/badge/status-active-success.svg)](https://github.com/EagleMind/intelQ) 
---

## What it does

Most people who need to pull data from a database don't write SQL fluently. They know what question they want answered — *"how many orders did we ship last week to customers in Germany?"* — but translating that into a `JOIN ... WHERE ...` is the hard part.

IntelQuery sits between you and your database:

1. You type the question in English.
2. An AI model (running locally or via OpenRouter) generates the SQL.
3. You see the generated SQL **before** anything runs.
4. You click Execute and the results come back as a table.

You stay in control. The SQL is always shown, the query is gated by a read-only lock by default, and credentials never leave your machine.

## Who it's for

- **Analysts and PMs** who need to answer ad-hoc data questions without filing a ticket with engineering.
- **Engineers** who want a quick scratchpad against staging or local databases without firing up DBeaver.
- **Anyone** maintaining a database who wants a safer alternative to a raw SQL terminal — the read-only mode blocks accidental writes.

## Why this approach

- **Local-first.** Connections, schemas, and results stay on your machine. The only outbound network call is to your AI provider (and even that can be a local LM Studio instance with zero internet).
- **Transparent.** Every query is shown as SQL before execution. No black-box "the AI did something."
- **Safe by default.** Read-only mode is on out of the box. Any generated `INSERT`/`UPDATE`/`DELETE`/`DROP` is intercepted with an explicit confirmation step.
- **Credentials in the OS keychain.** Database passwords and API keys are stored in Windows Credential Manager, macOS Keychain, or Linux Secret Service — never in plaintext files.

---

## Features

### Natural language queries
- Plain-English → SQL using LM Studio (local) or OpenRouter (cloud).
- `@tablename` tag syntax to focus the AI on specific tables — only those tables' schema is included in the prompt, keeping token cost low on large databases.
- Auto-complete suggestions as you type `@`.
- Live timing: generation time and execution time are shown next to each result.

### Data exploration
- Sidebar list of tables, refreshed from a cached schema.
- One-click table browser with pagination, in-page search, and CSV export.
- Result sets paginated at 100 rows per page on the UI so multi-thousand-row queries stay responsive.

### Database safety
- **Read-only lock** (on by default) blocks any write or DDL statement. Disabling it requires an explicit confirmation showing exactly what the query will do.
- SQL safety analyzer flags injection patterns and multi-statement queries.
- All database identifiers used internally are validated to prevent injection through table names.

### Connection management
- Save multiple connections per database type (MySQL, PostgreSQL, SQLite).
- Auto-connect after editing/saving.
- Passwords stored in OS keychain — never written to disk in plaintext.
- One-click disconnect from the header.

### AI providers
- **LM Studio** for fully local inference.
- **OpenRouter** for cloud models.
- Per-provider endpoint and API-key settings, with the key stored in the OS keychain.

---

## Quick start

### Prerequisites
- Node.js 18+ and npm
- Rust toolchain (stable)
- On Windows: Visual Studio Build Tools (for the Tauri Rust compiler)

### Run in development
```bash
git clone <repository-url>
cd intelquery
npm install
npm run tauri dev
```

The app launches as a desktop window.

### Build a release binary

```bash
npm run tauri build
```

Output (Windows): `src-tauri/target/release/intelquery_0.1.0_x64-setup.exe`

---

## How to use

### 1. Connect to a database
Click **Manage Connections** in the header → **Add Connection**. Enter the database details (the password goes straight to your OS keychain) and click **Save & Connect**. Once connected, the schema is loaded once and reused across the session.

### 2. Choose an AI provider
Click the gear icon in the NLQ panel.
- **LM Studio**: start the app, load a model, set the endpoint (default `http://localhost:1234/api/v1/chat`).
- **OpenRouter**: paste your API key. It's stored in your OS keychain.

### 3. Ask a question
Type a question in plain English. Use `@tablename` to tell the AI which tables matter — for example *"Show me top 10 @orders by @customer revenue this quarter"*. The AI receives only those tables' schema, which keeps prompts small and answers focused.

### 4. Review and execute
The generated SQL is shown with timing and approach metadata. Click **Execute Query** to run it. Results appear in a paginated table you can search, page through, and export to CSV.

### 5. Working with writes
If you ask the AI for something that produces `INSERT`/`UPDATE`/`DELETE`/`DROP`/etc. while read-only mode is on, you'll get a confirmation modal listing the dangerous operations. You can cancel, or explicitly disable the lock and run.

---

## Technical overview

### Tech stack
| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 (Rust) |
| Frontend | React 19 + TypeScript + Vite 7 |
| Styling | Tailwind CSS 4 |
| Database | sqlx 0.7 (MySQL, PostgreSQL, SQLite) |
| Credential storage | `keyring` crate (OS-native) |
| Icons | lucide-react |
| AI | LM Studio / OpenRouter HTTP APIs |

### Architecture at a glance

```
┌──────────────────────────────────────────────────────────────┐
│ React (renderer)                                             │
│                                                              │
│   DbProvider (shared store: status, tables, schema, lock)   │
│       ├── DataExplorer  ── api.getTableData()               │
│       ├── NLQInterface  ── llm.generateSql()                │
│       │                    api.execute()                     │
│       │                    SQLSafetyAnalyzer (gate writes)   │
│       └── ConnectionsManager ── api.credential* + connect()  │
│                                                              │
│   services/api.ts  ── typed safeInvoke wrappers              │
│   services/llm.ts  ── provider-agnostic SQL generation       │
└──────────────────────────────────────────────────────────────┘
                          │ Tauri IPC
┌──────────────────────────────────────────────────────────────┐
│ Rust (Tauri commands, src-tauri/src/lib.rs)                  │
│                                                              │
│   AppState                                                   │
│     ├── db_pool: RwLock<DatabasePool>     (Sqlite/PG/MySQL)  │
│     └── schema:  RwLock<Option<SchemaCache>>                 │
│                                                              │
│   DatabaseManager                                            │
│     ├── create_pool / list_tables                            │
│     ├── build_schema_cache (single info_schema query)        │
│     ├── execute_query                                        │
│     └── get_table_data                                       │
│                                                              │
│   keyring entries (credential_set/get/delete)                │
└──────────────────────────────────────────────────────────────┘
                          │
                  ┌───────┴────────┐
              MySQL/PG/SQLite     OS Keychain
```

### Performance and data-flow choices
- **Pool snapshot, not mutex held across `await`.** Commands clone the `DatabasePool` (sqlx pools are `Arc`-backed and cheap to clone) under a short read lock and release the lock before issuing the query. Queries run concurrently instead of serializing through one mutex.
- **Column-aligned row payload.** Rows are serialized as `Vec<Vec<Option<String>>>` rather than `Vec<HashMap<String, String>>`. This roughly halves the JSON payload on wide tables and removes per-row column-name string copies. SQL `NULL` is represented as JSON `null`.
- **Single-query schema build.** On Postgres/MySQL the whole schema is read in one `information_schema.columns` query (not 1 + N per-table calls). The result is cached in `AppState` and invalidated on connect.
- **Schema filtering for AI prompts.** When the user `@tags` tables, the backend renders only those tables into the prompt string via `get_filtered_schema`, drastically reducing token usage on large schemas.
- **Positional row decoding.** All `information_schema` decoding uses `row.try_get(0)`, `try_get(1)`, ... rather than name-based access — robust against MySQL 8's casing differences for catalog columns.
- **Frontend pagination.** The results table renders only 100 DOM rows at a time, so 10k-row query results don't freeze the renderer.
- **Live timing.** `performance.now()` brackets both the LLM call and the `execute_query` IPC so users see real generation + execution latency.

### Project structure
```
intelquery/
├── src/
│   ├── components/
│   │   ├── DataExplorer.tsx        # table browser
│   │   ├── NLQInterface.tsx        # NL → SQL panel, results, settings
│   │   └── ConnectionsManager.tsx  # saved connections + keyring
│   ├── services/
│   │   ├── api.ts                  # typed wrappers over Tauri invoke
│   │   └── llm.ts                  # provider-agnostic SQL generation
│   ├── store/
│   │   └── DbContext.tsx           # shared db/state/loading context
│   ├── types/
│   │   ├── api.ts                  # response shapes (mirrors Rust)
│   │   └── tauri.d.ts              # window.__TAURI__ typings
│   ├── utils/
│   │   ├── tauri.ts                # safeInvoke
│   │   └── sqlSafetyAnalyzer.ts    # destructive-op detection
│   └── App.tsx                     # shell + provider mounting
├── src-tauri/
│   ├── src/lib.rs                  # all Tauri commands + db logic
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json
```

### Tauri commands (Rust → frontend API)
| Command | Purpose |
|---|---|
| `connect_database` | Open a pool, warm the schema cache (best-effort). |
| `disconnect_database` | Drop the pool and cache. |
| `get_database_status` | Is a pool active? |
| `get_tables` | Cached table names. |
| `get_schema` | Cached full schema as a rendered string. |
| `get_filtered_schema(tables)` | Schema rendered for a subset of tables (for AI prompts). |
| `refresh_schema` | Rebuild the cache. |
| `execute_query({sql_query})` | Run arbitrary SQL, return column-aligned rows. |
| `get_table_data({tableName, limit, offset})` | Paginated table dump. |
| `credential_set/get/delete` | OS keychain interface for secrets. |

### Security
- Database passwords and API keys are stored via the OS-native credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service) — never in `localStorage` or on disk in plaintext. Legacy plaintext entries are automatically migrated into the keychain on first launch after upgrade.
- Read-only mode is enforced **before** queries are sent to the backend, using a client-side SQL safety analyzer. Bypassing it requires an explicit user action.
- Table-name parameters used in internal queries (e.g. `get_table_data`) are validated against `[A-Za-z0-9_-]+` to prevent injection through identifier interpolation.
- The only outbound network call is to your chosen AI provider; database traffic is direct from the app to your DB host.

---

## Development

### Recommended IDE setup
- [VS Code](https://code.visualstudio.com/)
- [Tauri extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

### Common commands
```bash
npm run tauri dev      # dev with HMR + Rust watcher
npm run tauri build    # production build
npx tsc --noEmit       # type-check the frontend
cargo check            # (in src-tauri/) type-check the backend
```

### Build requirements
- Windows 10+ / macOS 11+ / a modern Linux desktop
- Rust stable toolchain
- 2–3 GB free disk for the Cargo build cache

---

## License

Proprietary.

## Version history

### 0.1.0
- Initial release
- Natural-language SQL generation (LM Studio, OpenRouter)
- MySQL / PostgreSQL / SQLite support
- Read-only enforcement with safety analyzer
- OS-keychain credential storage
- Paginated results, CSV export
- Live generation + execution timing
