// ---------------------------------------------------------------------------
// Local-first application data store.
//
// IntelQuery's own data (saved connection definitions + UI/AI settings) lives
// in a single SQLite file in the OS app-data directory. This is the unit that
// gets backed up to / restored from Cloudflare R2 (see sync.rs). Secrets (DB
// passwords, API keys, the R2 secret) are NOT stored here — they stay in the OS
// keychain and are excluded from backups.
// ---------------------------------------------------------------------------

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::FromRow;
use std::collections::HashMap;
use std::path::Path;

/// A saved connection definition. Mirrors the frontend `ConnectionRecord`.
/// The password is never stored here — it lives in the OS keychain.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ConnectionRecord {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: i64,
    pub database: String,
    pub username: String,
}

/// Open (creating if absent) the app-data SQLite database and ensure the schema.
pub async fn init_pool(path: &Path) -> Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        // Rollback-journal (not WAL) so the single `.db` file is always the
        // authoritative copy — required for the raw-file R2 backup/restore.
        .journal_mode(SqliteJournalMode::Delete);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
    init_schema(&pool).await?;
    Ok(pool)
}

async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS connections (\
            id TEXT PRIMARY KEY, \
            name TEXT NOT NULL, \
            db_type TEXT NOT NULL, \
            host TEXT NOT NULL DEFAULT '', \
            port INTEGER NOT NULL DEFAULT 0, \
            database TEXT NOT NULL DEFAULT '', \
            username TEXT NOT NULL DEFAULT '', \
            sort_order INTEGER NOT NULL DEFAULT 0, \
            created_at TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))\
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS settings (\
            key TEXT PRIMARY KEY, \
            value TEXT\
        )",
    )
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn list_connections(pool: &SqlitePool) -> Result<Vec<ConnectionRecord>> {
    let rows = sqlx::query_as::<_, ConnectionRecord>(
        "SELECT id, name, db_type, host, port, database, username \
         FROM connections ORDER BY sort_order, created_at",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn save_connection(pool: &SqlitePool, rec: &ConnectionRecord) -> Result<()> {
    sqlx::query(
        "INSERT INTO connections \
            (id, name, db_type, host, port, database, username, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now')) \
         ON CONFLICT(id) DO UPDATE SET \
            name = excluded.name, \
            db_type = excluded.db_type, \
            host = excluded.host, \
            port = excluded.port, \
            database = excluded.database, \
            username = excluded.username, \
            updated_at = datetime('now')",
    )
    .bind(&rec.id)
    .bind(&rec.name)
    .bind(&rec.db_type)
    .bind(&rec.host)
    .bind(rec.port)
    .bind(&rec.database)
    .bind(&rec.username)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_connection(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM connections WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_setting(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT value FROM settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(v,)| v))
}

pub async fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_setting(pool: &SqlitePool, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM settings WHERE key = ?1")
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_settings(pool: &SqlitePool) -> Result<HashMap<String, String>> {
    let rows = sqlx::query_as::<_, (String, Option<String>)>("SELECT key, value FROM settings")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(k, v)| v.map(|val| (k, val)))
        .collect())
}
