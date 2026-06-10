// ---------------------------------------------------------------------------
// Annotation module — standalone, local-first.
//
// Two modes:
//   "virtual" — stored only in app-data.db, keyed by connection_id.
//   "native"  — same as virtual, but the caller also fires a COMMENT SQL on
//               the target DB (handled in lib.rs so it has access to AppState).
//
// IDs are deterministic: "{connection_id}:{table}:{col_or_empty}:{scope}",
// which makes upserts trivial (ON CONFLICT(id)).
// ---------------------------------------------------------------------------

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePool, FromRow};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AnnotationRecord {
    pub id: String,
    pub connection_id: String,
    pub scope: String,
    pub table_name: String,
    pub column_name: Option<String>,
    pub body: String,
    pub mode: String,
    pub created_at: String,
    pub updated_at: String,
}

pub fn make_id(connection_id: &str, table_name: &str, column_name: Option<&str>, scope: &str) -> String {
    format!("{}:{}:{}:{}", connection_id, table_name, column_name.unwrap_or(""), scope)
}

// ---------------------------------------------------------------------------
// Schema migration (called from appdb::init_schema)
// ---------------------------------------------------------------------------

pub async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS annotations (\
            id           TEXT PRIMARY KEY, \
            connection_id TEXT NOT NULL, \
            scope        TEXT NOT NULL DEFAULT 'table', \
            table_name   TEXT NOT NULL, \
            column_name  TEXT, \
            body         TEXT NOT NULL DEFAULT '', \
            mode         TEXT NOT NULL DEFAULT 'virtual', \
            created_at   TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at   TEXT NOT NULL DEFAULT (datetime('now'))\
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

pub async fn save_annotation(pool: &SqlitePool, rec: &AnnotationRecord) -> Result<()> {
    sqlx::query(
        "INSERT INTO annotations \
            (id, connection_id, scope, table_name, column_name, body, mode, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now')) \
         ON CONFLICT(id) DO UPDATE SET \
            body       = excluded.body, \
            mode       = excluded.mode, \
            updated_at = datetime('now')",
    )
    .bind(&rec.id)
    .bind(&rec.connection_id)
    .bind(&rec.scope)
    .bind(&rec.table_name)
    .bind(rec.column_name.as_deref())
    .bind(&rec.body)
    .bind(&rec.mode)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_annotations(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Vec<AnnotationRecord>> {
    let rows = sqlx::query_as::<_, AnnotationRecord>(
        "SELECT id, connection_id, scope, table_name, column_name, \
                body, mode, created_at, updated_at \
         FROM annotations \
         WHERE connection_id = ?1 \
         ORDER BY table_name, scope DESC, column_name",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_annotation(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM annotations WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_annotations_for_connection(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<()> {
    sqlx::query("DELETE FROM annotations WHERE connection_id = ?1")
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

pub fn export_annotations(annotations: &[AnnotationRecord], format: &str, db_type: &str) -> String {
    match format {
        "sql" => export_sql(annotations, db_type),
        "markdown" => export_markdown(annotations),
        "csv" => export_csv(annotations),
        _ => export_json(annotations),
    }
}

fn export_json(annotations: &[AnnotationRecord]) -> String {
    serde_json::to_string_pretty(annotations).unwrap_or_else(|e| format!("{{\"error\":\"{}\"}}", e))
}

fn escape_sql_string(s: &str) -> String {
    s.replace('\'', "''")
}

fn export_sql(annotations: &[AnnotationRecord], db_type: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!("-- Annotations export ({} syntax)\n\n", db_type));

    match db_type {
        "postgresql" | "postgres" => {
            for ann in annotations {
                let body = escape_sql_string(&ann.body);
                if ann.scope == "table" {
                    out.push_str(&format!(
                        "COMMENT ON TABLE \"{}\" IS '{}';\n",
                        ann.table_name, body
                    ));
                } else if let Some(col) = &ann.column_name {
                    out.push_str(&format!(
                        "COMMENT ON COLUMN \"{}\".\"{}\" IS '{}';\n",
                        ann.table_name, col, body
                    ));
                }
            }
        }
        "mysql" => {
            for ann in annotations {
                if ann.scope == "table" {
                    let body = escape_sql_string(&ann.body);
                    out.push_str(&format!(
                        "ALTER TABLE `{}` COMMENT = '{}';\n",
                        ann.table_name, body
                    ));
                } else {
                    out.push_str(&format!(
                        "-- Skipped column annotation for `{}`.`{}` (MySQL column COMMENT requires full ALTER TABLE MODIFY COLUMN)\n",
                        ann.table_name,
                        ann.column_name.as_deref().unwrap_or("?")
                    ));
                }
            }
        }
        _ => {
            out.push_str("-- This database type does not support native COMMENT syntax.\n");
            out.push_str("-- Use the JSON export to preserve annotations.\n");
        }
    }
    out
}

fn export_markdown(annotations: &[AnnotationRecord]) -> String {
    let mut out = String::new();
    out.push_str("# Database Annotations\n\n");

    let mut by_table: HashMap<&str, Vec<&AnnotationRecord>> = HashMap::new();
    for ann in annotations {
        by_table.entry(ann.table_name.as_str()).or_default().push(ann);
    }

    let mut tables: Vec<&str> = by_table.keys().copied().collect();
    tables.sort_unstable();

    for table in tables {
        out.push_str(&format!("## `{}`\n\n", table));
        let anns = &by_table[table];

        if let Some(tbl) = anns.iter().find(|a| a.scope == "table") {
            out.push_str(&tbl.body);
            out.push_str("\n\n");
        }

        let cols: Vec<&&AnnotationRecord> = anns.iter().filter(|a| a.scope == "column").collect();
        if !cols.is_empty() {
            out.push_str("| Column | Description |\n");
            out.push_str("|--------|-------------|\n");
            for ann in cols {
                if let Some(col) = &ann.column_name {
                    out.push_str(&format!("| `{}` | {} |\n", col, ann.body.replace('|', "\\|")));
                }
            }
            out.push('\n');
        }
    }
    out
}

fn export_csv(annotations: &[AnnotationRecord]) -> String {
    let mut out = String::new();
    out.push_str("connection_id,table_name,column_name,scope,description,mode\n");
    for ann in annotations {
        out.push_str(&format!(
            "{},{},{},{},{},{}\n",
            csv_field(&ann.connection_id),
            csv_field(&ann.table_name),
            csv_field(ann.column_name.as_deref().unwrap_or("")),
            csv_field(&ann.scope),
            csv_field(&ann.body),
            csv_field(&ann.mode),
        ));
    }
    out
}

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}
