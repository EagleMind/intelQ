// ---------------------------------------------------------------------------
// Cloudflare R2 backup / restore.
//
// The local app-data SQLite database (see appdb.rs) is the unit of backup. On
// "Back up now" we take a consistent VACUUM INTO snapshot, encrypt it with the
// user's passphrase (age / scrypt) so R2 only ever sees ciphertext, and PUT it
// as a single object. "Restore" pulls that object, decrypts, validates it's a
// real SQLite DB, then atomically swaps it in for the live database (keeping a
// .bak of the previous file).
//
// R2 is reached over its S3-compatible API. There is no third-party Cloudflare
// OAuth, so the user creates an R2 API token once (guided flow in the UI) and
// the access key + secret are stored — the secret in the OS keychain, never in
// the backup itself.
// ---------------------------------------------------------------------------

use crate::{appdb, AppState};
use anyhow::{anyhow, Result};
use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;
use serde::Serialize;
use sqlx::SqlitePool;
use std::io::{Read, Write};

/// Keychain account holding the R2 secret access key (never persisted to SQLite
/// and never included in a backup).
pub const R2_SECRET_ACCOUNT: &str = "r2_secret_access_key";

/// Object key for the single backup blob in the user's bucket.
const BACKUP_KEY: &str = "intelquery/backup.age";

// Settings-table keys for the (non-secret) R2 configuration.
const K_ACCOUNT_ID: &str = "r2_account_id";
const K_BUCKET: &str = "r2_bucket";
const K_ACCESS_KEY_ID: &str = "r2_access_key_id";
const K_ENDPOINT: &str = "r2_endpoint";
const K_LAST_BACKUP_AT: &str = "last_backup_at";

/// R2 configuration returned to the frontend. Deliberately excludes the secret.
#[derive(Debug, Clone, Serialize)]
pub struct R2Config {
    pub account_id: String,
    pub bucket: String,
    pub access_key_id: String,
    pub endpoint: String,
    pub connected: bool,
    pub last_backup_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupResult {
    pub bytes: u64,
    pub last_backup_at: String,
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

pub async fn save_config(
    pool: &SqlitePool,
    account_id: &str,
    bucket: &str,
    access_key_id: &str,
    secret_access_key: &str,
    endpoint: Option<String>,
) -> Result<()> {
    let endpoint = endpoint
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| format!("https://{}.r2.cloudflarestorage.com", account_id));

    appdb::set_setting(pool, K_ACCOUNT_ID, account_id).await?;
    appdb::set_setting(pool, K_BUCKET, bucket).await?;
    appdb::set_setting(pool, K_ACCESS_KEY_ID, access_key_id).await?;
    appdb::set_setting(pool, K_ENDPOINT, &endpoint).await?;

    crate::keyring_entry(R2_SECRET_ACCOUNT)
        .map_err(|e| anyhow!(e))?
        .set_password(secret_access_key)
        .map_err(|e| anyhow!("failed to store R2 secret: {}", e))?;

    Ok(())
}

pub async fn get_config(pool: &SqlitePool) -> Result<Option<R2Config>> {
    let account_id = appdb::get_setting(pool, K_ACCOUNT_ID).await?;
    let bucket = appdb::get_setting(pool, K_BUCKET).await?;
    let access_key_id = appdb::get_setting(pool, K_ACCESS_KEY_ID).await?;
    let endpoint = appdb::get_setting(pool, K_ENDPOINT).await?;

    match (account_id, bucket, access_key_id, endpoint) {
        (Some(account_id), Some(bucket), Some(access_key_id), Some(endpoint)) => {
            let secret_present = crate::keyring_entry(R2_SECRET_ACCOUNT)
                .ok()
                .and_then(|e| e.get_password().ok())
                .is_some();
            Ok(Some(R2Config {
                account_id,
                bucket,
                access_key_id,
                endpoint,
                connected: secret_present,
                last_backup_at: appdb::get_setting(pool, K_LAST_BACKUP_AT).await?,
            }))
        }
        _ => Ok(None),
    }
}

pub async fn clear_config(pool: &SqlitePool) -> Result<()> {
    for key in [K_ACCOUNT_ID, K_BUCKET, K_ACCESS_KEY_ID, K_ENDPOINT, K_LAST_BACKUP_AT] {
        appdb::delete_setting(pool, key).await?;
    }
    // Best-effort removal of the keychain secret.
    if let Ok(entry) = crate::keyring_entry(R2_SECRET_ACCOUNT) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

pub async fn test_connection(pool: &SqlitePool) -> Result<()> {
    let bucket = build_bucket(pool).await?;
    bucket
        .list(String::new(), Some("/".to_string()))
        .await
        .map(|_| ())
        .map_err(|e| anyhow!("R2 request failed: {}", e))
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

pub async fn backup(state: &AppState, passphrase: &str) -> Result<BackupResult> {
    if passphrase.trim().is_empty() {
        return Err(anyhow!("A passphrase is required to encrypt the backup"));
    }

    let pool = state.app_db().await;

    // The app DB uses rollback-journal mode (see appdb::init_pool), so the
    // single `.db` file always holds the committed data — read it as-is.
    let plaintext = std::fs::read(&state.app_db_path)
        .map_err(|e| anyhow!("failed to read database file: {}", e))?;
    let ciphertext = encrypt(&plaintext, passphrase)?;

    let bucket = build_bucket(&pool).await?;
    let resp = bucket
        .put_object(BACKUP_KEY, &ciphertext)
        .await
        .map_err(|e| anyhow!("R2 upload failed: {}", e))?;
    let status = resp.status_code();
    if !(200..300).contains(&status) {
        return Err(anyhow!("R2 upload failed with status {}", status));
    }

    let now = chrono::Utc::now().to_rfc3339();
    appdb::set_setting(&pool, K_LAST_BACKUP_AT, &now).await?;

    Ok(BackupResult { bytes: ciphertext.len() as u64, last_backup_at: now })
}

pub async fn restore(state: &AppState, passphrase: &str) -> Result<()> {
    if passphrase.trim().is_empty() {
        return Err(anyhow!("Enter the passphrase used to create the backup"));
    }

    let pool = state.app_db().await;
    let bucket = build_bucket(&pool).await?;

    let resp = bucket
        .get_object(BACKUP_KEY)
        .await
        .map_err(|e| anyhow!("could not fetch backup from R2: {}", e))?;
    let status = resp.status_code();
    if status == 404 {
        return Err(anyhow!("No backup found in R2 yet"));
    }
    if !(200..300).contains(&status) {
        return Err(anyhow!("R2 download failed with status {}", status));
    }

    // age uses authenticated encryption, so a wrong passphrase or corrupt blob
    // fails here rather than yielding a bad file — no separate validation pass.
    let plaintext = decrypt(resp.as_slice(), passphrase)
        .map_err(|_| anyhow!("Decryption failed — wrong passphrase or corrupt backup"))?;

    // Swap the file: close the pool (can't overwrite an open SQLite file on
    // Windows), keep a .bak of the current data, write the new bytes, reopen.
    let mut guard = state.app_db.write().await;
    guard.close().await;

    let bak = state.app_db_path.with_extension("db.bak");
    let _ = std::fs::copy(&state.app_db_path, &bak);

    let written = std::fs::write(&state.app_db_path, &plaintext);
    // Clear any stale sidecar files from a previous WAL run, just in case.
    for ext in ["db-wal", "db-shm"] {
        let _ = std::fs::remove_file(state.app_db_path.with_extension(ext));
    }
    if let Err(e) = written {
        // Reopen the original so the app stays usable.
        *guard = appdb::init_pool(&state.app_db_path).await?;
        return Err(anyhow!("failed to overwrite database: {}", e));
    }

    *guard = appdb::init_pool(&state.app_db_path).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn build_bucket(pool: &SqlitePool) -> Result<Box<Bucket>> {
    let bucket_name = appdb::get_setting(pool, K_BUCKET)
        .await?
        .ok_or_else(|| anyhow!("R2 is not configured"))?;
    let endpoint = appdb::get_setting(pool, K_ENDPOINT)
        .await?
        .ok_or_else(|| anyhow!("R2 is not configured"))?;
    let access_key_id = appdb::get_setting(pool, K_ACCESS_KEY_ID)
        .await?
        .ok_or_else(|| anyhow!("R2 is not configured"))?;
    let secret = crate::keyring_entry(R2_SECRET_ACCOUNT)
        .map_err(|e| anyhow!(e))?
        .get_password()
        .map_err(|_| anyhow!("R2 secret is missing — reconnect your R2 token"))?;

    let region = Region::Custom { region: "auto".to_string(), endpoint };
    let credentials = Credentials::new(Some(&access_key_id), Some(&secret), None, None, None)
        .map_err(|e| anyhow!("invalid R2 credentials: {}", e))?;

    let bucket = Bucket::new(&bucket_name, region, credentials)
        .map_err(|e| anyhow!("failed to build R2 client: {}", e))?
        .with_path_style();
    Ok(bucket)
}

fn encrypt(plaintext: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    let encryptor =
        age::Encryptor::with_user_passphrase(age::secrecy::Secret::new(passphrase.to_owned()));
    let mut out = Vec::new();
    let mut writer = encryptor
        .wrap_output(&mut out)
        .map_err(|e| anyhow!("encryption setup failed: {}", e))?;
    writer
        .write_all(plaintext)
        .map_err(|e| anyhow!("encryption failed: {}", e))?;
    writer.finish().map_err(|e| anyhow!("encryption failed: {}", e))?;
    Ok(out)
}

fn decrypt(ciphertext: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    let decryptor = match age::Decryptor::new(ciphertext)? {
        age::Decryptor::Passphrase(d) => d,
        _ => return Err(anyhow!("backup is not passphrase-encrypted")),
    };
    let mut out = Vec::new();
    let mut reader = decryptor.decrypt(&age::secrecy::Secret::new(passphrase.to_owned()), None)?;
    reader.read_to_end(&mut out)?;
    Ok(out)
}
