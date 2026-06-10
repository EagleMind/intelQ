# Database Annotations Module — CONTEXT.md

## Overview

The **Annotations Module** lets users add plain-language descriptions to database tables and columns. These annotations help teams understand their data: what tables store, what columns mean, business rules, data types, allowed values, and deprecation notes.

The module is **completely standalone** and integrates cleanly into the main app via:
- A React Context (`AnnotationContext`) for state management
- Tauri IPC commands for backend operations
- A modal panel (`AnnotationPanel`) for the UI
- Small integration points in `App.tsx`, `DataExplorer.tsx`, and `DbContext.tsx`

### Two Modes

**Local Annotations** (default)
- Stored only in IntelQuery's local SQLite database (`app-data.db`)
- Never modifies the target database
- Safe for read-only connections and SQLite
- Scoped to a connection — annotations follow that saved connection

**Write to Database** (native mode)
- Writes annotations directly into the target database as native COMMENT metadata
- PostgreSQL: supports both table and column comments via `COMMENT ON TABLE` and `COMMENT ON COLUMN`
- MySQL: supports table comments only via `ALTER TABLE ... COMMENT`
- SQLite: not supported (no native COMMENT syntax)
- Shows a prominent warning when enabled: "This will modify your database directly"
- Requires write access to the target database

---

## Architecture

### Layers

```
┌─────────────────────────────────────────────────────────┐
│ Frontend (React / TypeScript)                            │
├─────────────────────────────────────────────────────────┤
│ AnnotationPanel.tsx (UI)                                │
│   ├─ ExportPanel (inlined)                              │
│   ├─ ColumnRow (editable column list)                   │
│   └─ Mode selector (Local vs. Write to Database)        │
│                                                          │
│ AnnotationEditor.tsx (textarea + save/discard)          │
│ AnnotationBadge.tsx (blue dot on annotated tables)      │
│                                                          │
│ AnnotationContext.tsx (React Context — cache, CRUD)     │
│ annotations.ts (Tauri IPC wrappers)                     │
├─────────────────────────────────────────────────────────┤
│ Backend (Tauri + Rust)                                  │
├─────────────────────────────────────────────────────────┤
│ 6 Tauri commands (lib.rs):                              │
│   • annotation_save — upsert into local store           │
│   • annotation_get_all — load all for a connection      │
│   • annotation_delete — remove one                      │
│   • annotation_export — generate JSON/SQL/MD/CSV        │
│   • annotation_apply_native — write COMMENT to DB       │
│   • annotation_fetch_native — read COMMENTS from DB     │
│                                                          │
│ annotations.rs module:                                  │
│   • Schema migration (create annotations table)         │
│   • CRUD helpers (save, get, delete, delete_by_conn)   │
│   • Export formatters (4 formats)                       │
├─────────────────────────────────────────────────────────┤
│ Storage                                                 │
├─────────────────────────────────────────────────────────┤
│ app-data.db (local SQLite):                             │
│   annotations table — all annotations for all conns     │
│                                                          │
│ Target DB (PostgreSQL / MySQL only):                    │
│   COMMENT metadata — written when "Write to DB" active  │
└─────────────────────────────────────────────────────────┘
```

---

## Key Files

### Backend (Rust)

**`src-tauri/src/annotations.rs`** (150 lines)
- Annotation record type (`AnnotationRecord`)
- SQLite schema creation (`init_schema`)
- CRUD: `save_annotation`, `get_annotations`, `delete_annotation`, `delete_annotations_for_connection`
- ID generation: `make_id(conn_id, table, col?, scope)` — deterministic so upserts work
- Export logic: `export_annotations(format)` → JSON/SQL/Markdown/CSV
- Format helpers: `export_sql`, `export_markdown`, `export_csv`, `export_json`

**`src-tauri/src/lib.rs`** (6 Tauri commands)
- `annotation_save` — insert/update into app-data.db; if native mode, also fires SQL at target DB
- `annotation_get_all` — fetch all annotations for a connection
- `annotation_delete` — remove from local store
- `annotation_export` — serialize to requested format
- `annotation_apply_native` — execute `COMMENT ON` / `ALTER TABLE` SQL on connected DB
- `annotation_fetch_native` — read existing COMMENTs from the connected DB into memory
- **Cascade delete**: when a connection is deleted, all its annotations are removed too

**`src-tauri/src/appdb.rs`** (modified)
- `init_schema` is now public so `lib.rs` can call `annotations::init_schema` during app startup

### Frontend (React / TypeScript)

**`src/store/AnnotationContext.tsx`** (250 lines)
- React Context that holds all annotation state and operations
- **State**: `annotations` (Map keyed by ID), `mode` ("virtual" | "native"), `saving` flag, panel open/close
- **Helpers**: `tableAnnotation()`, `columnAnnotation()`, `annotationsForTable()`, `tablesWithAnnotations` Set
- **Operations**: `save(table, scope, body, col?)`, `remove(id)`, `exportAnnotations(format)`, `fetchNative()`, `refresh()`
- **Auto-load**: when `connectionId` changes (via `DbContext`), automatically loads all annotations for that connection
- **Mode validation**: `nativeUnsupportedReason` returns a user-friendly message if the mode can't be used (no connection, SQLite, etc.)
- **Panel state**: `isPanelOpen`, `panelTable`, `openPanel()`, `closePanel()`

**`src/services/annotations.ts`** (20 lines)
- Thin typed wrappers around all 6 Tauri commands
- Exported as `annotationApi` singleton — use instead of raw `safeInvoke()`

**`src/types/api.ts`** (modified)
- `Annotation` interface with all fields (connection_id, scope, table_name, column_name, body, mode, timestamps)
- `makeAnnotationId()` helper — deterministic ID generation to match the Rust backend

**`src/components/annotations/AnnotationBadge.tsx`** (25 lines)
- Small blue dot that appears on table rows that have annotations
- Shows count and scope in the title tooltip
- Used in `DataExplorer.tsx`

**`src/components/annotations/AnnotationEditor.tsx`** (70 lines)
- Textarea component with real-time character counter (max 500 chars)
- Tracks dirty state — only shows Save/Discard when text has changed
- Auto-syncs from store when annotation is updated externally (e.g., after `fetchNative`)
- Handles both save and delete (empty text + existing = delete)

**`src/components/annotations/AnnotationPanel.tsx`** (370 lines)
- Full modal panel — the main UI
- **Left sidebar**: table list with search, blue dots for annotated tables
- **Right panel**: table annotation editor + expandable column list
- **Export dialog** (inlined): 4 formats, live preview, download/copy buttons
- **Mode selector**: two card-style options (Local vs. Write to Database) with warning banner
- **"Fetch from DB" button**: reads existing COMMENTs and imports them into local store
- **Helper function**: `parseColumnsFromSchema()` — extracts column names from the cached schema text

### Integration Points

**`src/store/DbContext.tsx`** (modified)
- Added `connectionId` and `connectionDbType` to `DbStatus`
- Updated `markConnected()` to accept and store these values
- `AnnotationContext` reads these via `useDb()` to auto-load annotations when connection changes

**`src/components/ConnectionsManager.tsx`** (modified)
- Passes `record.id` and `record.db_type` to `markConnected()` calls (two places)

**`src/components/DataExplorer.tsx`** (modified)
- Imports `AnnotationBadge` and `useAnnotations`
- Adds "Annotate" button in the header
- Each table row now shows a badge dot + a hover-visible pencil icon to open the panel for that table
- Calls `openPanel(tableName)` to jump directly to a table

**`src/App.tsx`** (modified)
- Wraps the app with `<AnnotationProvider>` (must be inside `DbProvider` and `AiSettingsProvider`)
- Renders `<AnnotationPanel />` at the Shell level (self-manages visibility via context)
- Adds "Annotate" button to the header (only shown when connected)

---

## Data Model

### SQLite Schema (app-data.db)

```sql
CREATE TABLE annotations (
  id           TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT 'table',  -- 'table' or 'column'
  table_name   TEXT NOT NULL,
  column_name  TEXT,                           -- NULL if table scope
  body         TEXT NOT NULL DEFAULT '',       -- the annotation text
  mode         TEXT NOT NULL DEFAULT 'virtual',-- 'virtual' or 'native'
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX ann_scope_idx ON annotations(connection_id, table_name, column_name, scope);
```

**Key properties:**
- ID is deterministic: `"{connection_id}:{table_name}:{column_name}:{scope}"`
- Upsert-safe: `ON CONFLICT(id) DO UPDATE SET ...` prevents duplicates
- Foreign key: `connection_id` references `connections.id` with `ON DELETE CASCADE`
- Deletion of a connection automatically removes all its annotations

### Annotation Record (TypeScript / Rust)

```typescript
interface Annotation {
  id: string;
  connection_id: string;
  scope: 'table' | 'column';
  table_name: string;
  column_name?: string | null;  // null for table scope
  body: string;
  mode: 'virtual' | 'native';
  created_at: string;
  updated_at: string;
}
```

---

## User-Facing Features

### Local Annotations
- Stored only in IntelQuery
- Safe for read-only databases
- Works with SQLite
- No impact on the actual database

### Write to Database
- Persists annotations to the database itself
- PostgreSQL: full support (table + column)
- MySQL: table only (column requires `ALTER TABLE MODIFY COLUMN`, not yet implemented)
- SQLite: disabled with clear explanation
- Shows a warning when active: *"This will modify your database directly. When you save an annotation here, it writes a description field into your database schema. This is a permanent change that requires write access to the database, and will be visible to anyone connected to it."*

### Export Formats
- **JSON**: full backup, re-importable (preserves mode, timestamps)
- **SQL**: `COMMENT ON TABLE/COLUMN` statements ready to run on target DB
- **Markdown**: human-readable docs with tables for columns
- **CSV**: spreadsheet-friendly flat list (table, column, scope, description, mode)

### Import from Database
- "Fetch from DB" button reads existing COMMENTs from PostgreSQL/MySQL
- Imports them into local store as "native" mode annotations
- Only shown if the connection supports it

---

## Design Decisions

### Why deterministic IDs?
Using `{connection_id}:{table}:{col}:{scope}` as the ID allows:
- Safe upserts without needing a separate "exists" check
- Predictable IDs for idempotent operations
- No hidden auto-increment complexity

### Why store mode in the database?
The `mode` field tracks whether an annotation was created locally or fetched from the DB. This helps:
- Distinguish user-created annotations from imported ones
- Support hybrid workflows (some local, some native)
- Export faithfully (include the source mode in JSON)

### Why is cascade delete needed?
When a user deletes a saved connection, all its annotations become orphaned. Cascading prevents:
- Growing "junk" annotations for deleted connections
- Confusion about which connection an annotation belongs to

### Why two export formats for SQL?
- **JSON export**: preserves all metadata, can be re-imported to rebuild the exact state
- **SQL export**: focuses on the `COMMENT` statements so users can apply them to a fresh DB

### Why is native mode disabled for SQLite?
SQLite has no native COMMENT syntax. The PRAGMA and metadata queries return column info, but there's no standard place to store descriptions in the schema itself. Users can always use local annotations.

### Why is MySQL column comments not implemented yet?
MySQL `COMMENT` on a column requires a full `ALTER TABLE MODIFY COLUMN` statement with the complete column definition. This is error-prone and complex. Table comments are safe and useful, so that's what we support for now.

---

## Extension Points

### Adding a new export format
1. Add the format to `FORMATS` in `AnnotationPanel.tsx`
2. Implement the formatter function in `src-tauri/src/annotations.rs`
3. Wire it into `export_annotations()`

Example: adding XML
```rust
"xml" => {
  let mut out = String::from("<?xml version=\"1.0\"?>\n<annotations>\n");
  for ann in annotations {
    out.push_str(&format!("  <annotation table=\"{}\" ...", ann.table_name));
    // ...
  }
  out.push_str("</annotations>");
  out
}
```

### Adding column comment support for MySQL
1. In `annotation_apply_native()`, implement the MySQL column case
2. Build the full `ALTER TABLE ... MODIFY COLUMN` statement from the current schema
3. Handle type preservation and nullable flags carefully
4. Update the UI to show this is now available

### Injecting annotations into the LLM prompt
Currently, annotations are stored but not used by the NLQ (natural language query) system. To integrate:
1. In `services/llm.ts`, after fetching the schema, also fetch annotations for the selected tables
2. Append them to the schema prompt: `"Table: orders — stores customer orders. Columns: status (pending/shipped/cancelled), ..."`
3. This helps the LLM generate more accurate SQL

---

## Common Tasks

### Load annotations for a connection
```typescript
const annotations = await annotationApi.getAll(connectionId);
```
(Also happens automatically when `AnnotationProvider` detects a new `connectionId`)

### Save an annotation
```typescript
await annotationApi.save({
  id: makeAnnotationId(connId, 'orders', 'status', 'column'),
  connection_id: connId,
  scope: 'column',
  table_name: 'orders',
  column_name: 'status',
  body: 'Values: pending, shipped, cancelled',
  mode: 'virtual',
  created_at: '',
  updated_at: '',
});
```
(Also handles native COMMENT write if mode is 'native')

### Export and download
```typescript
const text = await annotationApi.export(connId, 'markdown', dbType);
const blob = new Blob([text], { type: 'text/plain' });
// download blob...
```

### Check if a table has annotations
```typescript
const hasAnnotations = annotations.tablesWithAnnotations.has('orders');
```

### Get all annotations for a table
```typescript
const tableAnnotations = annotations.annotationsForTable('orders');
```

---

## Testing Notes

- **Unit test candidates**: ID generation, export formatters, schema parsing
- **Integration test candidates**: save → fetch → export → import round-trip
- **Manual test checklist**:
  - Create annotation, switch connections, return to original — annotation is still there
  - Toggle between Local and Write to Database modes
  - Export in all 4 formats, verify structure
  - Delete a connection, verify annotations are cleaned up
  - Try saving a very long annotation (>500 chars) — should truncate
  - On PostgreSQL: save, fetch from DB, verify it's visible in `SELECT`
  - On MySQL: save table comment, verify in `SHOW CREATE TABLE`
  - On SQLite: verify "Write to Database" is disabled with clear message

---

## Debugging Tips

- **Check if annotations loaded**: `useAnnotations().annotations.size > 0`
- **Check current mode**: `useAnnotations().mode`
- **Check unsupported reason**: `useAnnotations().nativeUnsupportedReason`
- **Manual DB inspect**: `SELECT * FROM annotations WHERE connection_id = ?` in app-data.db
- **Export preview**: click Export and inspect the text before downloading

---

## Related Systems

- **DbContext**: provides `connectionId` and `connectionDbType` via `useDb()`
- **ConnectionsManager**: manages saved connections; deleting a connection triggers cascade delete of annotations
- **DataExplorer**: shows annotation badges; clicking table or "Annotate" button opens the panel
- **NLQInterface** (future): could inject annotations into the LLM prompt to improve SQL generation
- **Sync / R2 Backup**: currently does not include annotations in backup (could be added in future)

