// ---------------------------------------------------------------------------
// Saved questions — local-first, per connection.
//
// An AI answer is a draft; once the user saves it, it becomes a saved question
// that re-runs the exact same SQL without calling the AI. A question may also be
// saved before it has SQL (`sql = ''`); the SQL is filled in on a later save.
//
// Tables live in the app-data SQLite file (see appdb.rs), so the whole-file
// R2 backup carries them automatically. Schema changes are `IF NOT EXISTS`
// only, so restoring a backup made before this module existed still works.
//
// `question_events` is a tiny append-only log powering the reuse metric
// ("answers from saved questions" vs "new AI drafts").
// ---------------------------------------------------------------------------

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePool, FromRow};

/// Upper bound on stored alternative phrasings per question.
const MAX_ALIASES: usize = 20;

/// What the frontend sees. `aliases` is decoded from its JSON column.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SavedQuestion {
    pub id: String,
    pub connection_id: String,
    pub question: String,
    pub aliases: Vec<String>,
    pub sql: String,
    pub source: String,
    pub run_count: i64,
    pub last_run_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Payload for create/update. `id: None` creates a new question.
/// `aliases: None` keeps the stored aliases on update.
#[derive(Debug, Clone, Deserialize)]
pub struct SavedQuestionInput {
    pub id: Option<String>,
    pub connection_id: String,
    pub question: String,
    pub sql: String,
    pub source: String,
    pub aliases: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuestionStats {
    pub ai_drafts: i64,
    pub saved_runs: i64,
}

#[derive(FromRow)]
struct Row {
    id: String,
    connection_id: String,
    question: String,
    aliases: String,
    sql: String,
    source: String,
    run_count: i64,
    last_run_at: Option<String>,
    created_at: String,
    updated_at: String,
}

impl From<Row> for SavedQuestion {
    fn from(r: Row) -> Self {
        SavedQuestion {
            id: r.id,
            connection_id: r.connection_id,
            question: r.question,
            aliases: decode_aliases(&r.aliases),
            sql: r.sql,
            source: r.source,
            run_count: r.run_count,
            last_run_at: r.last_run_at,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const SOURCES: [&str; 3] = ["ai", "edited", "manual"];
const EVENT_KINDS: [&str; 2] = ["ai_draft", "saved_run"];

fn decode_aliases(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn same_phrase(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// Drop blanks, duplicates (case-insensitive) and phrasings equal to the
/// question itself; keep insertion order and cap the list.
fn clean_aliases(question: &str, aliases: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for a in aliases {
        let t = a.trim();
        if t.is_empty() || same_phrase(t, question) || out.iter().any(|o| same_phrase(o, t)) {
            continue;
        }
        out.push(t.to_string());
    }
    if out.len() > MAX_ALIASES {
        out.drain(0..out.len() - MAX_ALIASES);
    }
    out
}

// ---------------------------------------------------------------------------
// Schema (called from appdb::init_schema)
// ---------------------------------------------------------------------------

pub async fn init_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS saved_questions (\
            id            TEXT PRIMARY KEY, \
            connection_id TEXT NOT NULL, \
            question      TEXT NOT NULL, \
            aliases       TEXT NOT NULL DEFAULT '[]', \
            sql           TEXT NOT NULL, \
            source        TEXT NOT NULL DEFAULT 'ai', \
            run_count     INTEGER NOT NULL DEFAULT 0, \
            last_run_at   TEXT, \
            created_at    TEXT NOT NULL DEFAULT (datetime('now')), \
            updated_at    TEXT NOT NULL DEFAULT (datetime('now'))\
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_saved_questions_conn \
         ON saved_questions (connection_id)",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS question_events (\
            id                INTEGER PRIMARY KEY AUTOINCREMENT, \
            connection_id     TEXT NOT NULL, \
            kind              TEXT NOT NULL, \
            saved_question_id TEXT, \
            at                TEXT NOT NULL DEFAULT (datetime('now'))\
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_question_events_conn_at \
         ON question_events (connection_id, at)",
    )
    .execute(pool)
    .await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const SELECT_COLS: &str = "id, connection_id, question, aliases, sql, source, \
                           run_count, last_run_at, created_at, updated_at";

pub async fn list(pool: &SqlitePool, connection_id: &str) -> Result<Vec<SavedQuestion>> {
    let rows = sqlx::query_as::<_, Row>(&format!(
        "SELECT {SELECT_COLS} FROM saved_questions \
         WHERE connection_id = ?1 \
         ORDER BY COALESCE(last_run_at, created_at) DESC, question"
    ))
    .bind(connection_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(SavedQuestion::from).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<SavedQuestion>> {
    let row = sqlx::query_as::<_, Row>(&format!(
        "SELECT {SELECT_COLS} FROM saved_questions WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(SavedQuestion::from))
}

/// Create (id = None) or update a saved question; returns the stored row.
pub async fn save(pool: &SqlitePool, input: &SavedQuestionInput) -> Result<SavedQuestion> {
    let question = input.question.trim();
    let sql = input.sql.trim();
    if question.is_empty() {
        return Err(anyhow!("Question name is required"));
    }
    if !SOURCES.contains(&input.source.as_str()) {
        return Err(anyhow!("Unknown source '{}'", input.source));
    }

    let id = input
        .id
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let aliases_json = input
        .aliases
        .as_ref()
        .map(|a| serde_json::to_string(&clean_aliases(question, a)))
        .transpose()?;

    sqlx::query(
        "INSERT INTO saved_questions \
            (id, connection_id, question, aliases, sql, source, updated_at) \
         VALUES (?1, ?2, ?3, COALESCE(?4, '[]'), ?5, ?6, datetime('now')) \
         ON CONFLICT(id) DO UPDATE SET \
            question   = excluded.question, \
            aliases    = COALESCE(?4, saved_questions.aliases), \
            sql        = excluded.sql, \
            source     = excluded.source, \
            updated_at = datetime('now')",
    )
    .bind(&id)
    .bind(&input.connection_id)
    .bind(question)
    .bind(aliases_json)
    .bind(sql)
    .bind(&input.source)
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| anyhow!("Saved question vanished after save"))
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM saved_questions WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Bump the run count, remember a new phrasing (if any) and log a
/// `saved_run` event — all in one transaction. Returns the updated row.
pub async fn record_run(
    pool: &SqlitePool,
    id: &str,
    alias: Option<&str>,
) -> Result<SavedQuestion> {
    let mut tx = pool.begin().await?;

    let row = sqlx::query_as::<_, Row>(&format!(
        "SELECT {SELECT_COLS} FROM saved_questions WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("Saved question not found"))?;

    let mut aliases = decode_aliases(&row.aliases);
    if let Some(a) = alias {
        aliases.push(a.to_string());
    }
    let aliases_json = serde_json::to_string(&clean_aliases(&row.question, &aliases))?;

    sqlx::query(
        "UPDATE saved_questions SET \
            run_count   = run_count + 1, \
            last_run_at = datetime('now'), \
            aliases     = ?2 \
         WHERE id = ?1",
    )
    .bind(id)
    .bind(&aliases_json)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO question_events (connection_id, kind, saved_question_id) \
         VALUES (?1, 'saved_run', ?2)",
    )
    .bind(&row.connection_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get(pool, id)
        .await?
        .ok_or_else(|| anyhow!("Saved question not found"))
}

pub async fn log_event(pool: &SqlitePool, connection_id: &str, kind: &str) -> Result<()> {
    if !EVENT_KINDS.contains(&kind) {
        return Err(anyhow!("Unknown event kind '{}'", kind));
    }
    sqlx::query("INSERT INTO question_events (connection_id, kind) VALUES (?1, ?2)")
        .bind(connection_id)
        .bind(kind)
        .execute(pool)
        .await?;
    Ok(())
}

/// Counts over the last `days` days (clamped to 1..=3650).
pub async fn stats(pool: &SqlitePool, connection_id: &str, days: i64) -> Result<QuestionStats> {
    let modifier = format!("-{} days", days.clamp(1, 3650));
    let (ai_drafts, saved_runs): (i64, i64) = sqlx::query_as(
        "SELECT \
            COALESCE(SUM(CASE WHEN kind = 'ai_draft'  THEN 1 ELSE 0 END), 0), \
            COALESCE(SUM(CASE WHEN kind = 'saved_run' THEN 1 ELSE 0 END), 0) \
         FROM question_events \
         WHERE connection_id = ?1 AND at >= datetime('now', ?2)",
    )
    .bind(connection_id)
    .bind(modifier)
    .fetch_one(pool)
    .await?;
    Ok(QuestionStats { ai_drafts, saved_runs })
}

/// Cascade used by `appdb_delete_connection`.
pub async fn delete_for_connection(pool: &SqlitePool, connection_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM saved_questions WHERE connection_id = ?1")
        .bind(connection_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM question_events WHERE connection_id = ?1")
        .bind(connection_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        // One connection: every `:memory:` connection is its own database.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_schema(&pool).await.unwrap();
        pool
    }

    fn input(conn: &str, q: &str) -> SavedQuestionInput {
        SavedQuestionInput {
            id: None,
            connection_id: conn.into(),
            question: q.into(),
            sql: "SELECT 1".into(),
            source: "ai".into(),
            aliases: None,
        }
    }

    #[tokio::test]
    async fn init_schema_is_idempotent() {
        let p = pool().await;
        init_schema(&p).await.unwrap();
    }

    #[tokio::test]
    async fn save_then_list_scoped_by_connection() {
        let p = pool().await;
        let a = save(&p, &input("c1", "  Orders last week ")).await.unwrap();
        save(&p, &input("c2", "Other DB")).await.unwrap();

        assert_eq!(a.question, "Orders last week");
        assert_eq!(a.run_count, 0);
        assert!(a.aliases.is_empty());
        assert_eq!(uuid::Uuid::parse_str(&a.id).unwrap().get_version_num(), 4);

        let list_c1 = list(&p, "c1").await.unwrap();
        assert_eq!(list_c1, vec![a]);
    }

    #[tokio::test]
    async fn update_keeps_aliases_and_counts_when_not_given() {
        let p = pool().await;
        let a = save(&p, &input("c1", "Orders")).await.unwrap();
        record_run(&p, &a.id, Some("orders please")).await.unwrap();

        let mut upd = input("c1", "Orders renamed");
        upd.id = Some(a.id.clone());
        upd.sql = "SELECT 2".into();
        upd.source = "edited".into();
        let b = save(&p, &upd).await.unwrap();

        assert_eq!(b.id, a.id);
        assert_eq!(b.question, "Orders renamed");
        assert_eq!(b.sql, "SELECT 2");
        assert_eq!(b.source, "edited");
        assert_eq!(b.run_count, 1);
        assert_eq!(b.aliases, vec!["orders please".to_string()]);
    }

    #[tokio::test]
    async fn save_rejects_bad_input() {
        let p = pool().await;
        assert!(save(&p, &input("c1", "  ")).await.is_err());
        let mut bad = input("c1", "x");
        bad.source = "verified".into();
        assert!(save(&p, &bad).await.is_err());
    }

    #[tokio::test]
    async fn question_can_be_saved_without_sql() {
        let p = pool().await;
        let mut q = input("c1", "Orders by status");
        q.sql = "  ".into();
        let saved = save(&p, &q).await.unwrap();
        assert_eq!(saved.sql, "");

        // Later the SQL is filled in on the same question.
        let mut filled = input("c1", "Orders by status");
        filled.id = Some(saved.id.clone());
        filled.sql = "SELECT status, COUNT(*) FROM orders GROUP BY status".into();
        assert_eq!(save(&p, &filled).await.unwrap().sql, filled.sql);
    }

    #[tokio::test]
    async fn record_run_counts_and_dedupes_aliases() {
        let p = pool().await;
        let a = save(&p, &input("c1", "Orders last week")).await.unwrap();

        record_run(&p, &a.id, Some("weekly orders")).await.unwrap();
        record_run(&p, &a.id, Some("  WEEKLY orders ")).await.unwrap();
        record_run(&p, &a.id, Some("orders last week")).await.unwrap();
        let r = record_run(&p, &a.id, None).await.unwrap();

        assert_eq!(r.run_count, 4);
        assert!(r.last_run_at.is_some());
        assert_eq!(r.aliases, vec!["weekly orders".to_string()]);

        let s = stats(&p, "c1", 30).await.unwrap();
        assert_eq!(s, QuestionStats { ai_drafts: 0, saved_runs: 4 });
    }

    #[tokio::test]
    async fn record_run_missing_id_errors() {
        let p = pool().await;
        assert!(record_run(&p, "nope", None).await.is_err());
    }

    #[tokio::test]
    async fn stats_respect_window_and_connection() {
        let p = pool().await;
        log_event(&p, "c1", "ai_draft").await.unwrap();
        log_event(&p, "c1", "ai_draft").await.unwrap();
        log_event(&p, "c2", "ai_draft").await.unwrap();
        sqlx::query(
            "INSERT INTO question_events (connection_id, kind, at) \
             VALUES ('c1', 'saved_run', datetime('now', '-40 days'))",
        )
        .execute(&p)
        .await
        .unwrap();
        assert!(log_event(&p, "c1", "bogus").await.is_err());

        assert_eq!(
            stats(&p, "c1", 30).await.unwrap(),
            QuestionStats { ai_drafts: 2, saved_runs: 0 }
        );
        assert_eq!(
            stats(&p, "c1", 60).await.unwrap(),
            QuestionStats { ai_drafts: 2, saved_runs: 1 }
        );
    }

    #[tokio::test]
    async fn delete_for_connection_removes_questions_and_events() {
        let p = pool().await;
        let a = save(&p, &input("c1", "A")).await.unwrap();
        save(&p, &input("c2", "B")).await.unwrap();
        record_run(&p, &a.id, None).await.unwrap();
        log_event(&p, "c1", "ai_draft").await.unwrap();

        delete_for_connection(&p, "c1").await.unwrap();

        assert!(list(&p, "c1").await.unwrap().is_empty());
        assert_eq!(list(&p, "c2").await.unwrap().len(), 1);
        assert_eq!(
            stats(&p, "c1", 30).await.unwrap(),
            QuestionStats { ai_drafts: 0, saved_runs: 0 }
        );
    }

    #[tokio::test]
    async fn delete_single_question() {
        let p = pool().await;
        let a = save(&p, &input("c1", "A")).await.unwrap();
        delete(&p, &a.id).await.unwrap();
        assert!(get(&p, &a.id).await.unwrap().is_none());
    }

    #[test]
    fn clean_aliases_caps_length() {
        let many: Vec<String> = (0..30).map(|i| format!("phrase {i}")).collect();
        let out = clean_aliases("q", &many);
        assert_eq!(out.len(), MAX_ALIASES);
        assert_eq!(out.last().unwrap(), "phrase 29");
    }
}
