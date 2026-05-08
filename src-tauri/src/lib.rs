// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sqlx::{Column, Row, SqlitePool};
use sqlx::mysql::MySqlPool;
use sqlx::postgres::PgPool;
use sqlx::types::chrono::{NaiveDateTime, NaiveDate, NaiveTime};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use anyhow::{Result, anyhow};

// ---------------------------------------------------------------------------
// Database connection pool enum
// ---------------------------------------------------------------------------

enum DatabasePool {
    Sqlite(SqlitePool),
    Postgres(PgPool),
    MySQL(MySqlPool),
    None,
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

struct AppState {
    db_pool: Arc<Mutex<DatabasePool>>,
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
pub struct SchemaResponse {
    pub schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryRequest {
    pub sql_query: String,
}

/// A single column descriptor returned in query results and table data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableColumn {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
}

/// The result of an arbitrary SQL query.
///
/// `rows` is a flat list of maps: column-name → string-value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub success: bool,
    pub columns: Option<Vec<TableColumn>>,
    pub rows: Option<Vec<HashMap<String, String>>>,
    pub message: Option<String>,
    pub row_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateSQLRequest {
    pub query: String,
    /// Optionally restrict generation to a subset of tables.
    pub selected_tables: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateSQLResponse {
    pub success: bool,
    pub sql_query: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDataResponse {
    pub columns: Vec<TableColumn>,
    pub rows: Vec<HashMap<String, String>>,
    pub total_rows: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub columns: Vec<TableColumn>,
}

// ---------------------------------------------------------------------------
// Database manager
// ---------------------------------------------------------------------------

struct DatabaseManager;

impl DatabaseManager {
    // -----------------------------------------------------------------------
    // Connection helpers
    // -----------------------------------------------------------------------

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
            "sqlite" => {
                let pool = SqlitePool::connect(&conn_str).await?;
                Ok(DatabasePool::Sqlite(pool))
            }
            "postgresql" | "postgres" => {
                let pool = PgPool::connect(&conn_str).await?;
                Ok(DatabasePool::Postgres(pool))
            }
            "mysql" => {
                let pool = MySqlPool::connect(&conn_str).await?;
                Ok(DatabasePool::MySQL(pool))
            }
            other => Err(anyhow!("Unsupported database type: {}", other)),
        }
    }

    // -----------------------------------------------------------------------
    // Table listing
    // -----------------------------------------------------------------------

    async fn get_tables(pool: &DatabasePool) -> Result<Vec<String>> {
        match pool {
            DatabasePool::Sqlite(p) => {
                let rows = sqlx::query(
                    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                )
                .fetch_all(p)
                .await?;
                Ok(rows.iter().map(|r| r.get::<String, _>("name")).collect())
            }
            DatabasePool::Postgres(p) => {
                let rows = sqlx::query(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
                )
                .fetch_all(p)
                .await?;
                Ok(rows.iter().map(|r| r.get::<String, _>("tablename")).collect())
            }
            DatabasePool::MySQL(p) => {
                let rows = sqlx::query("SHOW TABLES").fetch_all(p).await?;
                // SHOW TABLES returns one column; grab it by index.
                Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect())
            }
            DatabasePool::None => Err(anyhow!("No database connection")),
        }
    }

    // -----------------------------------------------------------------------
    // Schema (human-readable summary)
    // -----------------------------------------------------------------------

    async fn get_schema(pool: &DatabasePool) -> Result<String> {
        let tables = Self::get_tables(pool).await?;
        let mut schema = String::new();

        for table in &tables {
            schema.push_str(&format!("Table: {}\n", table));
            let info = Self::get_table_info(pool, table).await?;
            for col in &info.columns {
                schema.push_str(&format!(
                    "  - {} {} (nullable: {})\n",
                    col.name, col.data_type, col.nullable
                ));
            }
            schema.push('\n');
        }

        Ok(schema)
    }

    // -----------------------------------------------------------------------
    // Column metadata for a single table
    // -----------------------------------------------------------------------

    async fn get_table_info(pool: &DatabasePool, table_name: &str) -> Result<TableInfo> {
        match pool {
            DatabasePool::Sqlite(p) => {
                let rows =
                    sqlx::query(&format!("PRAGMA table_info(\"{}\")", table_name))
                        .fetch_all(p)
                        .await?;

                let columns = rows
                    .iter()
                    .map(|row| {
                        let name: String = row.get("name");
                        let data_type: String = row.get("type");
                        // notnull=1 means NOT NULL, so nullable = notnull == 0
                        let not_null: i64 = row.get("notnull");
                        let default: Option<String> = row.try_get("dflt_value").ok().flatten();
                        TableColumn {
                            name,
                            data_type,
                            nullable: not_null == 0,
                            default,
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
                        let name: String = row.get("column_name");
                        let data_type: String = row.get("data_type");
                        let is_nullable: String = row.get("is_nullable");
                        let default: Option<String> = row.try_get("column_default").ok().flatten();
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
                let rows = sqlx::query(&format!("SHOW FULL COLUMNS FROM `{}`", table_name))
                    .fetch_all(p)
                    .await?;

                let columns = rows
                    .iter()
                    .map(|row| {
                        let name: String = row.get("Field");
                        let data_type: String = row.get("Type");
                        let null_str: String = row.get("Null");
                        let default: Option<String> = row.try_get("Default").ok().flatten();
                        TableColumn {
                            name,
                            data_type,
                            nullable: null_str.eq_ignore_ascii_case("YES"),
                            default,
                        }
                    })
                    .collect();

                Ok(TableInfo { columns })
            }

            DatabasePool::None => Err(anyhow!("No database connection")),
        }
    }

    // -----------------------------------------------------------------------
    // Paginated table data
    // -----------------------------------------------------------------------

    // Validate table name to prevent SQL injection
    fn validate_table_name(table_name: &str) -> Result<()> {
        if table_name.is_empty() {
            return Err(anyhow!("Table name cannot be empty"));
        }
        
        // Only allow alphanumeric characters, underscores, and dashes
        if !table_name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
            return Err(anyhow!("Invalid table name: only alphanumeric characters, underscores, and dashes are allowed"));
        }
        
        // Prevent SQL injection attempts
        if table_name.to_lowercase().contains("drop") || 
           table_name.to_lowercase().contains("delete") ||
           table_name.to_lowercase().contains("insert") ||
           table_name.to_lowercase().contains("update") ||
           table_name.to_lowercase().contains("--") ||
           table_name.to_lowercase().contains(";") ||
           table_name.to_lowercase().contains("'") ||
           table_name.to_lowercase().contains("\"") {
            return Err(anyhow!("Invalid table name: potentially malicious characters detected"));
        }
        
        Ok(())
    }

    async fn get_table_data(
        pool: &DatabasePool,
        table_name: &str,
        limit: i64,
        offset: i64,
    ) -> Result<TableDataResponse> {
        let table_name = table_name.trim();

        // Validate table name to prevent SQL injection
        Self::validate_table_name(table_name)?;

        // Fetch column metadata first so we know the names.
        let info = Self::get_table_info(pool, table_name).await
            .map_err(|e| anyhow!("Failed to get table info for '{}': {}", table_name, e))?;

        match pool {
            DatabasePool::Sqlite(p) => {
                let count: i64 = sqlx::query_scalar(&format!(
                    "SELECT COUNT(*) FROM \"{}\"",
                    table_name
                ))
                .fetch_one(p)
                .await?;

                let rows = sqlx::query(&format!(
                    "SELECT * FROM \"{}\" LIMIT {} OFFSET {}",
                    table_name, limit, offset
                ))
                .fetch_all(p)
                .await?;

                let result_rows = Self::sqlite_rows_to_maps(&rows, &info.columns);

                Ok(TableDataResponse {
                    columns: info.columns,
                    rows: result_rows,
                    total_rows: count,
                    limit,
                    offset,
                })
            }

            DatabasePool::Postgres(p) => {
                let count: i64 = sqlx::query_scalar(&format!(
                    "SELECT COUNT(*) FROM \"{}\"",
                    table_name
                ))
                .fetch_one(p)
                .await?;

                let rows = sqlx::query(&format!(
                    "SELECT * FROM \"{}\" LIMIT {} OFFSET {}",
                    table_name, limit, offset
                ))
                .fetch_all(p)
                .await?;

                let result_rows = Self::pg_rows_to_maps(&rows, &info.columns);

                Ok(TableDataResponse {
                    columns: info.columns,
                    rows: result_rows,
                    total_rows: count,
                    limit,
                    offset,
                })
            }

            DatabasePool::MySQL(p) => {
                let count: i64 = sqlx::query_scalar(&format!(
                    "SELECT COUNT(*) FROM `{}`",
                    table_name
                ))
                .fetch_one(p)
                .await?;

                let rows = sqlx::query(&format!(
                    "SELECT * FROM `{}` LIMIT {} OFFSET {}",
                    table_name, limit, offset
                ))
                .fetch_all(p)
                .await?;

                let result_rows = Self::mysql_rows_to_maps(&rows, &info.columns);

                Ok(TableDataResponse {
                    columns: info.columns,
                    rows: result_rows,
                    total_rows: count,
                    limit,
                    offset,
                })
            }

            DatabasePool::None => Err(anyhow!("No database connection")),
        }
    }

    // -----------------------------------------------------------------------
    // Row → HashMap helpers
    // Each database driver has its own row type, so we need separate helpers.
    // Values are coerced to String; NULL becomes the string "NULL".
    // -----------------------------------------------------------------------

    fn sqlite_rows_to_maps(
        rows: &[sqlx::sqlite::SqliteRow],
        columns: &[TableColumn],
    ) -> Vec<HashMap<String, String>> {
        rows.iter()
            .map(|row| {
                let mut map = HashMap::new();
                for (i, col) in columns.iter().enumerate() {
                    let value: String = row
                        .try_get::<String, _>(i)
                        .or_else(|_| row.try_get::<i64, _>(i).map(|v| v.to_string()))
                        .or_else(|_| row.try_get::<f64, _>(i).map(|v| v.to_string()))
                        .or_else(|_| row.try_get::<bool, _>(i).map(|v| v.to_string()))
                        .unwrap_or_else(|_| "NULL".to_string());
                    map.insert(col.name.clone(), value);
                }
                map
            })
            .collect()
    }

    fn pg_rows_to_maps(
        rows: &[sqlx::postgres::PgRow],
        columns: &[TableColumn],
    ) -> Vec<HashMap<String, String>> {
        rows.iter()
            .map(|row| {
                let mut map = HashMap::new();
                for (i, col) in columns.iter().enumerate() {
                    let value: String = row
                        .try_get::<String, _>(i)
                        .or_else(|_| row.try_get::<i64, _>(i).map(|v| v.to_string()))
                        .or_else(|_| row.try_get::<i32, _>(i).map(|v| v.to_string()))
                        .or_else(|_| row.try_get::<f64, _>(i).map(|v| v.to_string()))
                        .or_else(|_| row.try_get::<bool, _>(i).map(|v| v.to_string()))
                        .unwrap_or_else(|_| "NULL".to_string());
                    map.insert(col.name.clone(), value);
                }
                map
            })
            .collect()
    }

    fn mysql_rows_to_maps(
        rows: &[sqlx::mysql::MySqlRow],
        columns: &[TableColumn],
    ) -> Vec<HashMap<String, String>> {
        rows.iter()
            .enumerate()
            .map(|(row_idx, row)| {
                let mut map = HashMap::new();
                for (col_idx, col) in columns.iter().enumerate() {
                    // Try multiple types with better error handling, including datetime types
                    let value = match row.try_get::<Option<String>, _>(col_idx) {
                        Ok(Some(val)) => val,
                        Ok(None) => "NULL".to_string(),
                        Err(_) => match row.try_get::<Option<i64>, _>(col_idx) {
                            Ok(Some(val)) => val.to_string(),
                            Ok(None) => "NULL".to_string(),
                            Err(_) => match row.try_get::<Option<i32>, _>(col_idx) {
                                Ok(Some(val)) => val.to_string(),
                                Ok(None) => "NULL".to_string(),
                                Err(_) => match row.try_get::<Option<f64>, _>(col_idx) {
                                    Ok(Some(val)) => val.to_string(),
                                    Ok(None) => "NULL".to_string(),
                                    Err(_) => match row.try_get::<Option<bool>, _>(col_idx) {
                                        Ok(Some(val)) => val.to_string(),
                                        Ok(None) => "NULL".to_string(),
                                        Err(_) => match row.try_get::<Option<NaiveDateTime>, _>(col_idx) {
                                            Ok(Some(val)) => val.to_string(),
                                            Ok(None) => "NULL".to_string(),
                                            Err(_) => match row.try_get::<Option<NaiveDate>, _>(col_idx) {
                                                Ok(Some(val)) => val.to_string(),
                                                Ok(None) => "NULL".to_string(),
                                                Err(_) => match row.try_get::<Option<NaiveTime>, _>(col_idx) {
                                                    Ok(Some(val)) => val.to_string(),
                                                    Ok(None) => "NULL".to_string(),
                                                    Err(_) => {
                                                        // Only log for non-datetime columns to reduce noise
                                                        let is_datetime_col = col.data_type.to_lowercase().contains("datetime") ||
                                                                         col.data_type.to_lowercase().contains("timestamp") ||
                                                                         col.data_type.to_lowercase().contains("date") ||
                                                                         col.data_type.to_lowercase().contains("time");
                                                        if !is_datetime_col {
                                                            eprintln!("Warning: Failed to convert value at row {}, column '{}' (index {}), type: {}", row_idx, col.name, col_idx, col.data_type);
                                                        }
                                                        "NULL".to_string()
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    };
                    map.insert(col.name.clone(), value);
                }
                map
            })
            .collect()
    }

    // -----------------------------------------------------------------------
    // Arbitrary SQL execution
    // -----------------------------------------------------------------------

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
                let rows = sqlx::query(sql).fetch_all(p).await.map_err(|e| anyhow!(e))?;
                let count = rows.len() as i64;

                if rows.is_empty() {
                    return Ok(QueryResult {
                        success: true,
                        columns: None,
                        rows: Some(vec![]),
                        message: Some("Query executed successfully, no rows returned".to_string()),
                        row_count: Some(0),
                    });
                }

                // Build column list from the first row.
                let columns: Vec<TableColumn> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| TableColumn {
                        name: c.name().to_string(),
                        data_type: c.type_info().to_string(),
                        nullable: true,
                        default: None,
                    })
                    .collect();

                let result_rows = Self::sqlite_rows_to_maps(&rows, &columns);

                Ok(QueryResult {
                    success: true,
                    columns: Some(columns),
                    rows: Some(result_rows),
                    message: Some("Query executed successfully".to_string()),
                    row_count: Some(count),
                })
            }

            DatabasePool::Postgres(p) => {
                let rows = sqlx::query(sql).fetch_all(p).await.map_err(|e| anyhow!(e))?;
                let count = rows.len() as i64;

                if rows.is_empty() {
                    return Ok(QueryResult {
                        success: true,
                        columns: None,
                        rows: Some(vec![]),
                        message: Some("Query executed successfully, no rows returned".to_string()),
                        row_count: Some(0),
                    });
                }

                let columns: Vec<TableColumn> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| TableColumn {
                        name: c.name().to_string(),
                        data_type: c.type_info().to_string(),
                        nullable: true,
                        default: None,
                    })
                    .collect();

                let result_rows = Self::pg_rows_to_maps(&rows, &columns);

                Ok(QueryResult {
                    success: true,
                    columns: Some(columns),
                    rows: Some(result_rows),
                    message: Some("Query executed successfully".to_string()),
                    row_count: Some(count),
                })
            }

            DatabasePool::MySQL(p) => {
                let rows = sqlx::query(sql).fetch_all(p).await.map_err(|e| anyhow!(e))?;
                let count = rows.len() as i64;

                if rows.is_empty() {
                    return Ok(QueryResult {
                        success: true,
                        columns: None,
                        rows: Some(vec![]),
                        message: Some("Query executed successfully, no rows returned".to_string()),
                        row_count: Some(0),
                    });
                }

                let columns: Vec<TableColumn> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| TableColumn {
                        name: c.name().to_string(),
                        data_type: c.type_info().to_string(),
                        nullable: true,
                        default: None,
                    })
                    .collect();

                let result_rows = Self::mysql_rows_to_maps(&rows, &columns);

                Ok(QueryResult {
                    success: true,
                    columns: Some(columns),
                    rows: Some(result_rows),
                    message: Some("Query executed successfully".to_string()),
                    row_count: Some(count),
                })
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

// ---------------------------------------------------------------------------
// AI SQL generation
// ---------------------------------------------------------------------------

async fn generate_sql_with_ai(request: &GenerateSQLRequest) -> Result<GenerateSQLResponse> {
    // Placeholder — replace with a real LLM API call.
    let sql = match &request.selected_tables {
        Some(tables) if !tables.is_empty() => {
            format!("SELECT * FROM {} LIMIT 100", tables.join(", "))
        }
        _ => "SELECT * FROM information_schema.tables LIMIT 100".to_string(),
    };

    Ok(GenerateSQLResponse {
        success: true,
        sql_query: Some(sql),
        error: None,
    })
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
) -> Result<ConnectionResponse, String> {
    let config = DatabaseConfig {
        db_type,
        host,
        port,
        database,
        username,
        password,
    };

    match DatabaseManager::create_pool(&config).await {
        Ok(pool) => {
            let mut guard = state.db_pool.lock().await;
            *guard = pool;
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
async fn get_database_status(
    state: tauri::State<'_, AppState>,
) -> Result<ConnectionResponse, String> {
    let guard = state.db_pool.lock().await;
    match &*guard {
        DatabasePool::None => Ok(ConnectionResponse {
            success: false,
            message: "No database connection".to_string(),
        }),
        _ => Ok(ConnectionResponse {
            success: true,
            message: "Connected to database".to_string(),
        }),
    }
}

#[tauri::command]
async fn get_tables(state: tauri::State<'_, AppState>) -> Result<TablesResponse, String> {
    let guard = state.db_pool.lock().await;
    DatabaseManager::get_tables(&*guard)
        .await
        .map(|tables| TablesResponse { tables })
        .map_err(|e| format!("Failed to get tables: {}", e))
}

#[tauri::command]
async fn get_schema(state: tauri::State<'_, AppState>) -> Result<SchemaResponse, String> {
    let guard = state.db_pool.lock().await;

    let pool_type = match &*guard {
        DatabasePool::None => "None",
        DatabasePool::Sqlite(_) => "SQLite",
        DatabasePool::Postgres(_) => "PostgreSQL",
        DatabasePool::MySQL(_) => "MySQL",
    };
    println!("DEBUG: get_schema called with pool type: {}", pool_type);

    DatabaseManager::get_schema(&*guard)
        .await
        .map(|schema| {
            println!("DEBUG: Schema retrieved, length: {}", schema.len());
            SchemaResponse { schema }
        })
        .map_err(|e| {
            println!("DEBUG: get_schema error: {}", e);
            format!("Failed to get schema: {}", e)
        })
}

#[tauri::command]
async fn execute_query(
    request: QueryRequest,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResult, String> {
    let guard = state.db_pool.lock().await;
    DatabaseManager::execute_query(&*guard, &request.sql_query)
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
) -> Result<TableDataResponse, String> {
    let guard = state.db_pool.lock().await;

    let pool_type = match &*guard {
        DatabasePool::None => "None",
        DatabasePool::Sqlite(_) => "SQLite",
        DatabasePool::Postgres(_) => "PostgreSQL",
        DatabasePool::MySQL(_) => "MySQL",
    };
    println!(
        "DEBUG: get_table_data called for table: '{}' pool: {}",
        tableName, pool_type
    );

    let limit = limit.unwrap_or(100).max(1).min(10_000);
    let offset = offset.unwrap_or(0).max(0);

    DatabaseManager::get_table_data(&*guard, &tableName, limit, offset)
        .await
        .map_err(|e| format!("Failed to get table data: {}", e))
}

#[tauri::command]
async fn generate_sql(request: GenerateSQLRequest) -> Result<GenerateSQLResponse, String> {
    generate_sql_with_ai(&request).await.map_err(|e| {
        format!("SQL generation failed: {}", e)
    })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState {
        db_pool: Arc::new(Mutex::new(DatabasePool::None)),
    };

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            connect_database,
            get_database_status,
            get_tables,
            get_schema,
            execute_query,
            get_table_data,
            generate_sql,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}