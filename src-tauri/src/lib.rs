// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlPool, MySqlRow};
use sqlx::postgres::{PgPool, PgRow};
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::types::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use chrono::Utc;
use sqlx::{Column, Row};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tauri::Manager;

mod annotations;
mod appdb;
mod sync;

use appdb::ConnectionRecord;

// ---------------------------------------------------------------------------
// Pool enum (Clone is cheap: each variant wraps an Arc internally)
// ---------------------------------------------------------------------------

#[derive(Clone)]
enum DatabasePool {
    Sqlite(SqlitePool),
    Postgres(PgPool),
    MySQL(MySqlPool),
    None,
}

impl DatabasePool {
    fn kind(&self) -> &'static str {
        match self {
            DatabasePool::Sqlite(_) => "sqlite",
            DatabasePool::Postgres(_) => "postgres",
            DatabasePool::MySQL(_) => "mysql",
            DatabasePool::None => "none",
        }
    }
}

// ---------------------------------------------------------------------------
// Cached schema (per-connection)
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct SchemaCache {
    tables: Vec<String>,
    columns_by_table: HashMap<String, Vec<TableColumn>>,
}

impl SchemaCache {
    fn render(&self, filter: Option<&[String]>) -> String {
        let mut out = String::new();
        let include: Box<dyn Fn(&str) -> bool> = match filter {
            Some(list) if !list.is_empty() => {
                let set: std::collections::HashSet<String> =
                    list.iter().map(|s| s.to_lowercase()).collect();
                Box::new(move |t: &str| set.contains(&t.to_lowercase()))
            }
            _ => Box::new(|_| true),
        };
        for table in &self.tables {
            if !include(table) {
                continue;
            }
            out.push_str(&format!("Table: {}\n", table));
            if let Some(cols) = self.columns_by_table.get(table) {
                for col in cols {
                    out.push_str(&format!(
                        "  - {} {} (nullable: {})\n",
                        col.name, col.data_type, col.nullable
                    ));
                }
            }
            out.push('\n');
        }
        out
    }
}

// ---------------------------------------------------------------------------
// AppState
//
// Both the pool and the schema cache live behind RwLock. Reads clone the
// pool (cheap — sqlx pools are Arc-backed) and release the lock immediately
// so concurrent queries don't serialize behind each other.
// ---------------------------------------------------------------------------

struct AppState {
    db_pool: Arc<RwLock<DatabasePool>>,
    schema: Arc<RwLock<Option<SchemaCache>>>,
    /// Local-first app-data store (saved connections + settings). Behind a
    /// RwLock so a R2 restore can close and reopen it (swap the file).
    app_db: Arc<RwLock<sqlx::SqlitePool>>,
    /// Path to the app-data SQLite file (for restore swaps + .bak).
    app_db_path: PathBuf,
}

impl AppState {
    fn new(app_db: sqlx::SqlitePool, app_db_path: PathBuf) -> Self {
        Self {
            db_pool: Arc::new(RwLock::new(DatabasePool::None)),
            schema: Arc::new(RwLock::new(None)),
            app_db: Arc::new(RwLock::new(app_db)),
            app_db_path,
        }
    }

    /// Snapshot the current pool. Returns Err if not connected.
    async fn pool(&self) -> std::result::Result<DatabasePool, String> {
        let snapshot = self.db_pool.read().await.clone();
        match snapshot {
            DatabasePool::None => Err("No database connection".into()),
            other => Ok(other),
        }
    }

    /// Cheap clone of the app-data pool (sqlx pools are Arc-backed).
    async fn app_db(&self) -> sqlx::SqlitePool {
        self.app_db.read().await.clone()
    }
}

// ---------------------------------------------------------------------------
// Public data structures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    pub db_type: String,
    pub host: String,
    pub port: i32,
    pub database: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionResponse {
    pub success: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TablesResponse {
    pub tables: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryRequest {
    pub sql_query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
}

/// Column-aligned result. `rows[i][j]` is the value at row i, column j.
/// SQL NULL is represented as `None` (serializes to JSON `null`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub success: bool,
    pub columns: Option<Vec<TableColumn>>,
    pub rows: Option<Vec<Vec<Option<String>>>>,
    pub message: Option<String>,
    pub row_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDataResponse {
    pub columns: Vec<TableColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    pub total_rows: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub columns: Vec<TableColumn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaResponse {
    pub schema: String,
    pub tables: Vec<String>,
}

// ---------------------------------------------------------------------------
// Cell decoders
// ---------------------------------------------------------------------------

/// Try each candidate Rust type until one matches the SQL column type.
/// Returns `None` for SQL NULL or if no candidate could decode.
macro_rules! try_cell {
    ($row:expr, $idx:expr, $($t:ty),+ $(,)?) => {{
        let mut result: Option<Option<String>> = None;
        $(
            if result.is_none() {
                if let Ok(v) = $row.try_get::<Option<$t>, _>($idx) {
                    result = Some(v.map(|x| x.to_string()));
                }
            }
        )+
        result.unwrap_or(None)
    }};
}

fn blob_to_hex(bytes: &[u8]) -> String {
    // Truncate huge blobs in the on-screen string to keep payloads sane.
    const MAX: usize = 256;
    let slice = &bytes[..bytes.len().min(MAX)];
    let mut s = String::with_capacity(2 + slice.len() * 2);
    s.push_str("0x");
    for b in slice {
        s.push_str(&format!("{:02x}", b));
    }
    if bytes.len() > MAX {
        s.push_str("...");
    }
    s
}

fn try_blob<R, DB>(row: &R, idx: usize) -> Option<Option<String>>
where
    R: Row<Database = DB>,
    DB: sqlx::Database,
    usize: sqlx::ColumnIndex<R>,
    for<'r> Vec<u8>: sqlx::Decode<'r, DB> + sqlx::Type<DB>,
{
    row.try_get::<Option<Vec<u8>>, _>(idx)
        .ok()
        .map(|opt| opt.map(|b| blob_to_hex(&b)))
}

fn sqlite_cell(row: &SqliteRow, idx: usize) -> Option<String> {
    if let Some(v) = try_blob::<_, sqlx::Sqlite>(row, idx) {
        if v.is_some() {
            return v;
        }
    }
    try_cell!(row, idx, String, i64, f64, bool)
}

fn pg_cell(row: &PgRow, idx: usize) -> Option<String> {
    let v = try_cell!(
        row,
        idx,
        String,
        i64,
        i32,
        i16,
        f64,
        f32,
        bool,
        NaiveDateTime,
        NaiveDate,
        NaiveTime,
        uuid::Uuid,
    );
    if v.is_some() {
        return v;
    }
    try_blob::<_, sqlx::Postgres>(row, idx).unwrap_or(None)
}

fn mysql_cell(row: &MySqlRow, idx: usize) -> Option<String> {
    let v = try_cell!(
        row,
        idx,
        String,
        i64,
        i32,
        u64,
        u32,
        f64,
        f32,
        bool,
        NaiveDateTime,
        NaiveDate,
        NaiveTime,
    );
    if v.is_some() {
        return v;
    }
    try_blob::<_, sqlx::MySql>(row, idx).unwrap_or(None)
}

fn columns_from_sqlite_row(row: &SqliteRow) -> Vec<TableColumn> {
    row.columns()
        .iter()
        .map(|c| TableColumn {
            name: c.name().to_string(),
            data_type: c.type_info().to_string(),
            nullable: true,
            default: None,
        })
        .collect()
}

fn columns_from_pg_row(row: &PgRow) -> Vec<TableColumn> {
    row.columns()
        .iter()
        .map(|c| TableColumn {
            name: c.name().to_string(),
            data_type: c.type_info().to_string(),
            nullable: true,
            default: None,
        })
        .collect()
}

fn columns_from_mysql_row(row: &MySqlRow) -> Vec<TableColumn> {
    row.columns()
        .iter()
        .map(|c| TableColumn {
            name: c.name().to_string(),
            data_type: c.type_info().to_string(),
            nullable: true,
            default: None,
        })
        .collect()
}

fn sqlite_rows_to_values(rows: &[SqliteRow], n_cols: usize) -> Vec<Vec<Option<String>>> {
    rows.iter()
        .map(|row| (0..n_cols).map(|i| sqlite_cell(row, i)).collect())
        .collect()
}

fn pg_rows_to_values(rows: &[PgRow], n_cols: usize) -> Vec<Vec<Option<String>>> {
    rows.iter()
        .map(|row| (0..n_cols).map(|i| pg_cell(row, i)).collect())
        .collect()
}

fn mysql_rows_to_values(rows: &[MySqlRow], n_cols: usize) -> Vec<Vec<Option<String>>> {
    rows.iter()
        .map(|row| (0..n_cols).map(|i| mysql_cell(row, i)).collect())
        .collect()
}

// ---------------------------------------------------------------------------
// Database manager
// ---------------------------------------------------------------------------

struct DatabaseManager;

impl DatabaseManager {
    fn build_connection_string(config: &DatabaseConfig) -> Result<String> {
        match config.db_type.as_str() {
            "sqlite" => Ok(config.database.clone()),
            "postgresql" | "postgres" => Ok(format!(
                "postgres://{}:{}@{}:{}/{}",
                config.username, config.password, config.host, config.port, config.database
            )),
            "mysql" => Ok(format!(
                "mysql://{}:{}@{}:{}/{}",
                config.username, config.password, config.host, config.port, config.database
            )),
            other => Err(anyhow!("Unsupported database type: {}", other)),
        }
    }

    async fn create_pool(config: &DatabaseConfig) -> Result<DatabasePool> {
        let conn_str = Self::build_connection_string(config)?;
        match config.db_type.as_str() {
            "sqlite" => Ok(DatabasePool::Sqlite(SqlitePool::connect(&conn_str).await?)),
            "postgresql" | "postgres" => {
                Ok(DatabasePool::Postgres(PgPool::connect(&conn_str).await?))
            }
            "mysql" => Ok(DatabasePool::MySQL(MySqlPool::connect(&conn_str).await?)),
            other => Err(anyhow!("Unsupported database type: {}", other)),
        }
    }

    async fn list_tables(pool: &DatabasePool) -> Result<Vec<String>> {
        match pool {
            DatabasePool::Sqlite(p) => {
                let rows = sqlx::query(
                    "SELECT name FROM sqlite_master WHERE type='table' \
                     AND name NOT LIKE 'sqlite_%' ORDER BY name",
                )
                .fetch_all(p)
                .await?;
                Ok(rows.iter().map(|r| r.get::<String, _>("name")).collect())
            }
            DatabasePool::Postgres(p) => {
                let rows = sqlx::query(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' \
                     ORDER BY tablename",
                )
                .fetch_all(p)
                .await?;
                Ok(rows
                    .iter()
                    .map(|r| r.get::<String, _>("tablename"))
                    .collect())
            }
            DatabasePool::MySQL(p) => {
                let rows = sqlx::query(
                    "SELECT table_name FROM information_schema.tables \
                     WHERE table_schema = DATABASE() ORDER BY table_name",
                )
                .fetch_all(p)
                .await?;
                Ok(rows
                    .iter()
                    .filter_map(|r| r.try_get::<String, _>(0).ok())
                    .collect())
            }
            DatabasePool::None => Err(anyhow!("No database connection")),
        }
    }

    /// Build the entire schema in **one** query for Postgres/MySQL.
    /// SQLite still needs PRAGMA per table (no information_schema), but those
    /// queries hit a local file and are cheap.
    async fn build_schema_cache(pool: &DatabasePool) -> Result<SchemaCache> {
        match pool {
            DatabasePool::Sqlite(p) => {
                let tables = Self::list_tables(pool).await?;
                let mut columns_by_table: HashMap<String, Vec<TableColumn>> = HashMap::new();
                for table in &tables {
                    let rows = sqlx::query(&format!("PRAGMA table_info(\"{}\")", table))
                        .fetch_all(p)
                        .await?;
                    let cols = rows
                        .iter()
                        .map(|row| {
                            let not_null: i64 = row.get("notnull");
                            TableColumn {
                                name: row.get("name"),
                                data_type: row.get("type"),
                                nullable: not_null == 0,
                                default: row.try_get("dflt_value").ok().flatten(),
                            }
                        })
                        .collect();
                    columns_by_table.insert(table.clone(), cols);
                }
                Ok(SchemaCache { tables, columns_by_table })
            }
            DatabasePool::Postgres(p) => {
                // Positional access avoids server-side column-name casing surprises
                // (MySQL 8 and some Postgres setups return identifiers in unexpected case).
                let rows = sqlx::query(
                    "SELECT table_name, column_name, data_type, is_nullable, column_default \
                     FROM information_schema.columns \
                     WHERE table_schema = 'public' \
                     ORDER BY table_name, ordinal_position",
                )
                .fetch_all(p)
                .await?;

                let mut columns_by_table: HashMap<String, Vec<TableColumn>> = HashMap::new();
                let mut table_order: Vec<String> = Vec::new();

                for row in &rows {
                    let table: String = row
                        .try_get(0)
                        .map_err(|e| anyhow!("schema row missing table_name: {}", e))?;
                    let column_name: String = row
                        .try_get(1)
                        .map_err(|e| anyhow!("schema row missing column_name: {}", e))?;
                    let data_type: String = row.try_get(2).unwrap_or_default();
                    let is_nullable: String = row.try_get(3).unwrap_or_default();
                    let default: Option<String> = row.try_get(4).ok().flatten();

                    let col = TableColumn {
                        name: column_name,
                        data_type,
                        nullable: is_nullable.eq_ignore_ascii_case("YES"),
                        default,
                    };
                    if !columns_by_table.contains_key(&table) {
                        table_order.push(table.clone());
                    }
                    columns_by_table.entry(table).or_default().push(col);
                }
                Ok(SchemaCache { tables: table_order, columns_by_table })
            }
            DatabasePool::MySQL(p) => {
                let rows = sqlx::query(
                    "SELECT table_name, column_name, column_type, is_nullable, column_default \
                     FROM information_schema.columns \
                     WHERE table_schema = DATABASE() \
                     ORDER BY table_name, ordinal_position",
                )
                .fetch_all(p)
                .await?;

                let mut columns_by_table: HashMap<String, Vec<TableColumn>> = HashMap::new();
                let mut table_order: Vec<String> = Vec::new();

                for row in &rows {
                    let table: String = row
                        .try_get(0)
                        .map_err(|e| anyhow!("schema row missing table_name: {}", e))?;
                    let column_name: String = row
                        .try_get(1)
                        .map_err(|e| anyhow!("schema row missing column_name: {}", e))?;
                    let column_type: String = row.try_get(2).unwrap_or_default();
                    let is_nullable: String = row.try_get(3).unwrap_or_default();
                    // column_default in MySQL is often returned as BLOB; try string first, fall back gracefully.
                    let default: Option<String> = row
                        .try_get::<Option<String>, _>(4)
                        .ok()
                        .flatten()
                        .or_else(|| {
                            row.try_get::<Option<Vec<u8>>, _>(4)
                                .ok()
                                .flatten()
                                .map(|b| String::from_utf8_lossy(&b).to_string())
                        });

                    let col = TableColumn {
                        name: column_name,
                        data_type: column_type,
                        nullable: is_nullable.eq_ignore_ascii_case("YES"),
                        default,
                    };
                    if !columns_by_table.contains_key(&table) {
                        table_order.push(table.clone());
                    }
                    columns_by_table.entry(table).or_default().push(col);
                }
                Ok(SchemaCache { tables: table_order, columns_by_table })
            }
            DatabasePool::None => Err(anyhow!("No database connection")),
        }
    }

    fn validate_table_name(table_name: &str) -> Result<()> {
        if table_name.is_empty() {
            return Err(anyhow!("Table name cannot be empty"));
        }
        // Only allow alphanumerics, underscore, dash. No quotes/semicolons/etc.
        if !table_name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        {
            return Err(anyhow!(
                "Invalid table name: only alphanumerics, underscores, and dashes allowed"
            ));
        }
        Ok(())
    }

    /// Build the column list from the actual fetched rows when possible; fall
    /// back to a metadata query only for empty tables (so the UI can still
    /// show headers).
    async fn get_table_data(
        pool: &DatabasePool,
        table_name: &str,
        limit: i64,
        offset: i64,
    ) -> Result<TableDataResponse> {
        let table_name = table_name.trim();
        Self::validate_table_name(table_name)?;

        match pool {
            DatabasePool::Sqlite(p) => {
                let count: i64 = sqlx::query_scalar(&format!(
                    "SELECT COUNT(*) FROM \"{}\"",
                    table_name
                ))
                .fetch_one(p)
                .await?;
                let rows = sqlx::query(&format!(
                    "SELECT * FROM \"{}\" LIMIT ? OFFSET ?",
                    table_name
                ))
                .bind(limit)
                .bind(offset)
                .fetch_all(p)
                .await?;
                let columns = if let Some(first) = rows.first() {
                    columns_from_sqlite_row(first)
                } else {
                    Self::single_table_columns(pool, table_name).await?.columns
                };
                let values = sqlite_rows_to_values(&rows, columns.len());
                Ok(TableDataResponse { columns, rows: values, total_rows: count, limit, offset })
            }
            DatabasePool::Postgres(p) => {
                let count: i64 = sqlx::query_scalar(&format!(
                    "SELECT COUNT(*) FROM \"{}\"",
                    table_name
                ))
                .fetch_one(p)
                .await?;
                let rows = sqlx::query(&format!(
                    "SELECT * FROM \"{}\" LIMIT $1 OFFSET $2",
                    table_name
                ))
                .bind(limit)
                .bind(offset)
                .fetch_all(p)
                .await?;
                let columns = if let Some(first) = rows.first() {
                    columns_from_pg_row(first)
                } else {
                    Self::single_table_columns(pool, table_name).await?.columns
                };
                let values = pg_rows_to_values(&rows, columns.len());
                Ok(TableDataResponse { columns, rows: values, total_rows: count, limit, offset })
            }
            DatabasePool::MySQL(p) => {
                let count: i64 = sqlx::query_scalar(&format!(
                    "SELECT COUNT(*) FROM `{}`",
                    table_name
                ))
                .fetch_one(p)
                .await?;
                let rows = sqlx::query(&format!(
                    "SELECT * FROM `{}` LIMIT ? OFFSET ?",
                    table_name
                ))
                .bind(limit)
                .bind(offset)
                .fetch_all(p)
                .await?;
                let columns = if let Some(first) = rows.first() {
                    columns_from_mysql_row(first)
                } else {
                    Self::single_table_columns(pool, table_name).await?.columns
                };
                let values = mysql_rows_to_values(&rows, columns.len());
                Ok(TableDataResponse { columns, rows: values, total_rows: count, limit, offset })
            }
            DatabasePool::None => Err(anyhow!("No database connection")),
        }
    }

    /// Fallback: fetch column metadata for a single table when the cache is empty.
    async fn single_table_columns(pool: &DatabasePool, table_name: &str) -> Result<TableInfo> {
        match pool {
            DatabasePool::Sqlite(p) => {
                let rows = sqlx::query(&format!("PRAGMA table_info(\"{}\")", table_name))
                    .fetch_all(p)
                    .await?;
                let columns = rows
                    .iter()
                    .map(|row| {
                        let not_null: i64 = row.get("notnull");
                        TableColumn {
                            name: row.get("name"),
                            data_type: row.get("type"),
                            nullable: not_null == 0,
                            default: row.try_get("dflt_value").ok().flatten(),
                        }
                    })
                    .collect();
                Ok(TableInfo { columns })
            }
            DatabasePool::Postgres(p) => {
                let rows = sqlx::query(
                    "SELECT column_name, data_type, is_nullable, column_default \
                     FROM information_schema.columns \
                     WHERE table_schema = 'public' AND table_name = $1 \
                     ORDER BY ordinal_position",
                )
                .bind(table_name)
                .fetch_all(p)
                .await?;
                let columns = rows
                    .iter()
                    .map(|row| {
                        let name: String = row.try_get(0).unwrap_or_default();
                        let data_type: String = row.try_get(1).unwrap_or_default();
                        let is_nullable: String = row.try_get(2).unwrap_or_default();
                        let default: Option<String> = row.try_get(3).ok().flatten();
                        TableColumn {
                            name,
                            data_type,
                            nullable: is_nullable.eq_ignore_ascii_case("YES"),
                            default,
                        }
                    })
                    .collect();
                Ok(TableInfo { columns })
            }
            DatabasePool::MySQL(p) => {
                let rows = sqlx::query(
                    "SELECT column_name, column_type, is_nullable, column_default \
                     FROM information_schema.columns \
                     WHERE table_schema = DATABASE() AND table_name = ? \
                     ORDER BY ordinal_position",
                )
                .bind(table_name)
                .fetch_all(p)
                .await?;
                let columns = rows
                    .iter()
                    .map(|row| {
                        let name: String = row.try_get(0).unwrap_or_default();
                        let data_type: String = row.try_get(1).unwrap_or_default();
                        let is_nullable: String = row.try_get(2).unwrap_or_default();
                        let default: Option<String> = row
                            .try_get::<Option<String>, _>(3)
                            .ok()
                            .flatten()
                            .or_else(|| {
                                row.try_get::<Option<Vec<u8>>, _>(3)
                                    .ok()
                                    .flatten()
                                    .map(|b| String::from_utf8_lossy(&b).to_string())
                            });
                        TableColumn {
                            name,
                            data_type,
                            nullable: is_nullable.eq_ignore_ascii_case("YES"),
                            default,
                        }
                    })
                    .collect();
                Ok(TableInfo { columns })
            }
            DatabasePool::None => Err(anyhow!("No database connection")),
        }
    }

    async fn execute_query(pool: &DatabasePool, sql: &str) -> Result<QueryResult> {
        let sql = sql.trim();
        if sql.is_empty() {
            return Ok(QueryResult {
                success: false,
                columns: None,
                rows: None,
                message: Some("Query is empty".to_string()),
                row_count: Some(0),
            });
        }

        match pool {
            DatabasePool::Sqlite(p) => {
                let rows = sqlx::query(sql).fetch_all(p).await?;
                let columns = rows.first().map(columns_from_sqlite_row).unwrap_or_default();
                let values = sqlite_rows_to_values(&rows, columns.len());
                Ok(query_result_ok(columns, values))
            }
            DatabasePool::Postgres(p) => {
                let rows = sqlx::query(sql).fetch_all(p).await?;
                let columns = rows.first().map(columns_from_pg_row).unwrap_or_default();
                let values = pg_rows_to_values(&rows, columns.len());
                Ok(query_result_ok(columns, values))
            }
            DatabasePool::MySQL(p) => {
                let rows = sqlx::query(sql).fetch_all(p).await?;
                let columns = rows.first().map(columns_from_mysql_row).unwrap_or_default();
                let values = mysql_rows_to_values(&rows, columns.len());
                Ok(query_result_ok(columns, values))
            }
            DatabasePool::None => Ok(QueryResult {
                success: false,
                columns: None,
                rows: None,
                message: Some("No database connection".to_string()),
                row_count: Some(0),
            }),
        }
    }
}

fn query_result_ok(columns: Vec<TableColumn>, values: Vec<Vec<Option<String>>>) -> QueryResult {
    QueryResult {
        success: true,
        row_count: Some(values.len() as i64),
        columns: Some(columns),
        rows: Some(values),
        message: Some("Query executed successfully".to_string()),
    }
}

// ---------------------------------------------------------------------------
// Secure credential storage (OS keychain)
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "intelquery";

pub(crate) fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn connect_database(
    db_type: String,
    host: String,
    port: i32,
    database: String,
    username: String,
    password: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ConnectionResponse, String> {
    let config = DatabaseConfig { db_type, host, port, database, username, password };

    match DatabaseManager::create_pool(&config).await {
        Ok(pool) => {
            // Try to warm the schema cache, but don't fail the connection if the
            // cache build errors — the user can still query, and the cache will
            // be rebuilt lazily on the next get_schema call.
            let cache = match DatabaseManager::build_schema_cache(&pool).await {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("Schema cache build failed (will retry lazily): {}", e);
                    None
                }
            };
            *state.db_pool.write().await = pool;
            *state.schema.write().await = cache;
            Ok(ConnectionResponse {
                success: true,
                message: "Connected successfully".to_string(),
            })
        }
        Err(e) => Ok(ConnectionResponse {
            success: false,
            message: format!("Connection failed: {}", e),
        }),
    }
}

#[tauri::command]
async fn disconnect_database(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ConnectionResponse, String> {
    *state.db_pool.write().await = DatabasePool::None;
    *state.schema.write().await = None;
    Ok(ConnectionResponse {
        success: true,
        message: "Disconnected".to_string(),
    })
}

#[tauri::command]
async fn get_database_status(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ConnectionResponse, String> {
    let kind = state.db_pool.read().await.kind();
    if kind == "none" {
        Ok(ConnectionResponse { success: false, message: "No database connection".to_string() })
    } else {
        Ok(ConnectionResponse { success: true, message: format!("Connected ({})", kind) })
    }
}

#[tauri::command]
async fn get_tables(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<TablesResponse, String> {
    if let Some(cache) = state.schema.read().await.as_ref() {
        return Ok(TablesResponse { tables: cache.tables.clone() });
    }
    let pool = state.pool().await?;
    let tables = DatabaseManager::list_tables(&pool)
        .await
        .map_err(|e| format!("Failed to list tables: {}", e))?;
    Ok(TablesResponse { tables })
}

#[tauri::command]
async fn get_schema(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<SchemaResponse, String> {
    if let Some(cache) = state.schema.read().await.as_ref() {
        return Ok(SchemaResponse {
            schema: cache.render(None),
            tables: cache.tables.clone(),
        });
    }
    let pool = state.pool().await?;
    let cache = DatabaseManager::build_schema_cache(&pool)
        .await
        .map_err(|e| format!("Failed to load schema: {}", e))?;
    let response = SchemaResponse {
        schema: cache.render(None),
        tables: cache.tables.clone(),
    };
    *state.schema.write().await = Some(cache);
    Ok(response)
}

#[tauri::command]
async fn get_filtered_schema(
    tables: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<String, String> {
    if let Some(cache) = state.schema.read().await.as_ref() {
        return Ok(cache.render(Some(&tables)));
    }
    let pool = state.pool().await?;
    let cache = DatabaseManager::build_schema_cache(&pool)
        .await
        .map_err(|e| format!("Failed to load schema: {}", e))?;
    let rendered = cache.render(Some(&tables));
    *state.schema.write().await = Some(cache);
    Ok(rendered)
}

#[tauri::command]
async fn refresh_schema(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<SchemaResponse, String> {
    let pool = state.pool().await?;
    let cache = DatabaseManager::build_schema_cache(&pool)
        .await
        .map_err(|e| format!("Failed to refresh schema: {}", e))?;
    let response = SchemaResponse {
        schema: cache.render(None),
        tables: cache.tables.clone(),
    };
    *state.schema.write().await = Some(cache);
    Ok(response)
}

#[tauri::command]
async fn execute_query(
    request: QueryRequest,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<QueryResult, String> {
    let pool = match state.pool().await {
        Ok(p) => p,
        Err(msg) => {
            return Ok(QueryResult {
                success: false,
                columns: None,
                rows: None,
                message: Some(msg),
                row_count: Some(0),
            });
        }
    };
    DatabaseManager::execute_query(&pool, &request.sql_query)
        .await
        .map_err(|e| format!("Query execution failed: {}", e))
}

#[tauri::command]
#[allow(non_snake_case)]
async fn get_table_data(
    tableName: String,
    limit: Option<i64>,
    offset: Option<i64>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<TableDataResponse, String> {
    let pool = state.pool().await?;
    let limit = limit.unwrap_or(100).clamp(1, 10_000);
    let offset = offset.unwrap_or(0).max(0);

    DatabaseManager::get_table_data(&pool, &tableName, limit, offset)
        .await
        .map_err(|e| format!("Failed to get table data: {}", e))
}

// -------- Secure credential commands -------- //

#[tauri::command]
fn credential_set(account: String, secret: String) -> std::result::Result<(), String> {
    keyring_entry(&account)?
        .set_password(&secret)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn credential_get(account: String) -> std::result::Result<Option<String>, String> {
    match keyring_entry(&account)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn credential_delete(account: String) -> std::result::Result<(), String> {
    match keyring_entry(&account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// -------- Local app-data store (connections + settings) -------- //

#[tauri::command]
async fn appdb_list_connections(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<ConnectionRecord>, String> {
    let pool = state.app_db().await;
    appdb::list_connections(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn appdb_save_connection(
    record: ConnectionRecord,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let pool = state.app_db().await;
    appdb::save_connection(&pool, &record)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn appdb_delete_connection(
    id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let pool = state.app_db().await;
    // Cascade: remove all annotations scoped to this connection first.
    annotations::delete_annotations_for_connection(&pool, &id)
        .await
        .map_err(|e| e.to_string())?;
    appdb::delete_connection(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn appdb_get_setting(
    key: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<String>, String> {
    let pool = state.app_db().await;
    appdb::get_setting(&pool, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn appdb_set_setting(
    key: String,
    value: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let pool = state.app_db().await;
    appdb::set_setting(&pool, &key, &value)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn appdb_get_settings(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<HashMap<String, String>, String> {
    let pool = state.app_db().await;
    appdb::get_settings(&pool).await.map_err(|e| e.to_string())
}

// -------- Annotations -------- //

#[tauri::command]
async fn annotation_save(
    record: annotations::AnnotationRecord,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let pool = state.app_db().await;
    annotations::save_annotation(&pool, &record)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn annotation_get_all(
    connection_id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<annotations::AnnotationRecord>, String> {
    let pool = state.app_db().await;
    annotations::get_annotations(&pool, &connection_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn annotation_delete(
    id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let pool = state.app_db().await;
    annotations::delete_annotation(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn annotation_export(
    connection_id: String,
    format: String,
    db_type: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<String, String> {
    let pool = state.app_db().await;
    let records = annotations::get_annotations(&pool, &connection_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(annotations::export_annotations(&records, &format, &db_type))
}

/// Writes a COMMENT directly to the connected target database.
/// Only called when the user explicitly chooses "Native COMMENT" mode.
#[tauri::command]
async fn annotation_apply_native(
    record: annotations::AnnotationRecord,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    // Validate names to prevent SQL injection via table/column name fields.
    DatabaseManager::validate_table_name(&record.table_name)
        .map_err(|e| e.to_string())?;
    if let Some(col) = &record.column_name {
        DatabaseManager::validate_table_name(col).map_err(|e| e.to_string())?;
    }

    let pool = state.pool().await?;
    let body = record.body.replace('\'', "''");

    match &pool {
        DatabasePool::Postgres(p) => {
            let sql = if record.scope == "table" {
                format!("COMMENT ON TABLE \"{}\" IS '{}'", record.table_name, body)
            } else if let Some(col) = &record.column_name {
                format!(
                    "COMMENT ON COLUMN \"{}\".\"{}\" IS '{}'",
                    record.table_name, col, body
                )
            } else {
                return Err("Column name is required for column-scope annotation".to_string());
            };
            sqlx::query(&sql).execute(p).await.map_err(|e| e.to_string())?;
        }
        DatabasePool::MySQL(p) => {
            if record.scope == "table" {
                let sql = format!("ALTER TABLE `{}` COMMENT = '{}'", record.table_name, body);
                sqlx::query(&sql).execute(p).await.map_err(|e| e.to_string())?;
            } else {
                return Err(
                    "MySQL column COMMENT requires ALTER TABLE MODIFY COLUMN with the full \
                     column definition, which is not yet supported. Use virtual mode for \
                     column annotations on MySQL."
                        .to_string(),
                );
            }
        }
        DatabasePool::Sqlite(_) => {
            return Err(
                "SQLite does not support native COMMENT syntax. Use virtual mode.".to_string(),
            );
        }
        DatabasePool::None => {
            return Err("No database connection".to_string());
        }
    }
    Ok(())
}

/// Reads existing COMMENT values from the connected target database and returns
/// them as AnnotationRecords so the frontend can import them into the local store.
#[tauri::command]
async fn annotation_fetch_native(
    connection_id: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Vec<annotations::AnnotationRecord>, String> {
    let pool = state.pool().await?;
    let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let mut result: Vec<annotations::AnnotationRecord> = Vec::new();

    match &pool {
        DatabasePool::Postgres(p) => {
            // Table comments
            let rows = sqlx::query(
                "SELECT c.relname, obj_description(c.oid, 'pg_class') \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.relkind = 'r' AND n.nspname = 'public' \
                 AND obj_description(c.oid, 'pg_class') IS NOT NULL",
            )
            .fetch_all(p)
            .await
            .map_err(|e| e.to_string())?;

            for row in &rows {
                let table: String = row.try_get(0).map_err(|e| e.to_string())?;
                let comment: String = row.try_get(1).map_err(|e| e.to_string())?;
                result.push(annotations::AnnotationRecord {
                    id: annotations::make_id(&connection_id, &table, None, "table"),
                    connection_id: connection_id.clone(),
                    scope: "table".to_string(),
                    table_name: table,
                    column_name: None,
                    body: comment,
                    mode: "native".to_string(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                });
            }

            // Column comments
            let col_rows = sqlx::query(
                "SELECT c.relname, a.attname, col_description(c.oid, a.attnum) \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_attribute a ON a.attrelid = c.oid \
                 WHERE c.relkind = 'r' AND n.nspname = 'public' \
                 AND a.attnum > 0 AND NOT a.attisdropped \
                 AND col_description(c.oid, a.attnum) IS NOT NULL",
            )
            .fetch_all(p)
            .await
            .map_err(|e| e.to_string())?;

            for row in &col_rows {
                let table: String = row.try_get(0).map_err(|e| e.to_string())?;
                let col: String = row.try_get(1).map_err(|e| e.to_string())?;
                let comment: String = row.try_get(2).map_err(|e| e.to_string())?;
                result.push(annotations::AnnotationRecord {
                    id: annotations::make_id(&connection_id, &table, Some(&col), "column"),
                    connection_id: connection_id.clone(),
                    scope: "column".to_string(),
                    table_name: table,
                    column_name: Some(col),
                    body: comment,
                    mode: "native".to_string(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                });
            }
        }
        DatabasePool::MySQL(p) => {
            // Table comments
            let rows = sqlx::query(
                "SELECT table_name, table_comment \
                 FROM information_schema.tables \
                 WHERE table_schema = DATABASE() \
                 AND table_comment IS NOT NULL AND table_comment != ''",
            )
            .fetch_all(p)
            .await
            .map_err(|e| e.to_string())?;

            for row in &rows {
                let table: String = row.try_get(0).map_err(|e| e.to_string())?;
                let comment: String = row.try_get(1).map_err(|e| e.to_string())?;
                result.push(annotations::AnnotationRecord {
                    id: annotations::make_id(&connection_id, &table, None, "table"),
                    connection_id: connection_id.clone(),
                    scope: "table".to_string(),
                    table_name: table,
                    column_name: None,
                    body: comment,
                    mode: "native".to_string(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                });
            }

            // Column comments
            let col_rows = sqlx::query(
                "SELECT table_name, column_name, column_comment \
                 FROM information_schema.columns \
                 WHERE table_schema = DATABASE() \
                 AND column_comment IS NOT NULL AND column_comment != '' \
                 ORDER BY table_name, ordinal_position",
            )
            .fetch_all(p)
            .await
            .map_err(|e| e.to_string())?;

            for row in &col_rows {
                let table: String = row.try_get(0).map_err(|e| e.to_string())?;
                let col: String = row.try_get(1).map_err(|e| e.to_string())?;
                let comment: String = row.try_get(2).map_err(|e| e.to_string())?;
                result.push(annotations::AnnotationRecord {
                    id: annotations::make_id(&connection_id, &table, Some(&col), "column"),
                    connection_id: connection_id.clone(),
                    scope: "column".to_string(),
                    table_name: table,
                    column_name: Some(col),
                    body: comment,
                    mode: "native".to_string(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                });
            }
        }
        _ => {} // SQLite: no native COMMENT support
    }

    Ok(result)
}

// -------- Cloudflare R2 backup / restore -------- //

#[tauri::command]
async fn r2_save_config(
    account_id: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
    endpoint: Option<String>,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let pool = state.app_db().await;
    sync::save_config(&pool, &account_id, &bucket, &access_key_id, &secret_access_key, endpoint)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn r2_get_config(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<sync::R2Config>, String> {
    let pool = state.app_db().await;
    sync::get_config(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn r2_clear_config(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let pool = state.app_db().await;
    sync::clear_config(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn r2_test_connection(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let pool = state.app_db().await;
    sync::test_connection(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn r2_backup(
    passphrase: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<sync::BackupResult, String> {
    sync::backup(&state, &passphrase).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn r2_restore(
    passphrase: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    sync::restore(&state, &passphrase).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> std::result::Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Resolve the OS app-data dir and open (creating if needed) the
            // local-first SQLite store before any command can run.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("intelquery.db");
            let pool = tauri::async_runtime::block_on(appdb::init_pool(&db_path))
                .map_err(|e| format!("failed to open app database: {}", e))?;
            app.manage(AppState::new(pool, db_path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect_database,
            disconnect_database,
            get_database_status,
            get_tables,
            get_schema,
            get_filtered_schema,
            refresh_schema,
            execute_query,
            get_table_data,
            credential_set,
            credential_get,
            credential_delete,
            appdb_list_connections,
            appdb_save_connection,
            appdb_delete_connection,
            appdb_get_setting,
            appdb_set_setting,
            appdb_get_settings,
            r2_save_config,
            r2_get_config,
            r2_clear_config,
            r2_test_connection,
            r2_backup,
            r2_restore,
            annotation_save,
            annotation_get_all,
            annotation_delete,
            annotation_export,
            annotation_apply_native,
            annotation_fetch_native,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
