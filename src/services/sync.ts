import { safeInvoke } from '../utils/tauri';

// Mirrors the Rust `appdb::ConnectionRecord` (no password — that lives in the keychain).
export interface ConnectionRecord {
  id: string;
  name: string;
  db_type: string;
  host: string;
  port: number;
  database: string;
  username: string;
}

// Mirrors the Rust `sync::R2Config` (deliberately excludes the secret).
export interface R2Config {
  account_id: string;
  bucket: string;
  access_key_id: string;
  endpoint: string;
  connected: boolean;
  last_backup_at: string | null;
}

export interface BackupResult {
  bytes: number;
  last_backup_at: string;
}

export interface R2SaveArgs {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
}

export const sync = {
  // --- local app-data store ---
  listConnections: () => safeInvoke<ConnectionRecord[]>('appdb_list_connections'),
  saveConnection: (record: ConnectionRecord) =>
    safeInvoke<void>('appdb_save_connection', { record }),
  deleteConnection: (id: string) => safeInvoke<void>('appdb_delete_connection', { id }),

  getSetting: (key: string) => safeInvoke<string | null>('appdb_get_setting', { key }),
  setSetting: (key: string, value: string) =>
    safeInvoke<void>('appdb_set_setting', { key, value }),
  getSettings: () => safeInvoke<Record<string, string>>('appdb_get_settings'),

  // --- Cloudflare R2 ---
  r2GetConfig: () => safeInvoke<R2Config | null>('r2_get_config'),
  r2SaveConfig: (args: R2SaveArgs) =>
    safeInvoke<void>('r2_save_config', {
      accountId: args.accountId,
      bucket: args.bucket,
      accessKeyId: args.accessKeyId,
      secretAccessKey: args.secretAccessKey,
      endpoint: args.endpoint && args.endpoint.trim() ? args.endpoint.trim() : null,
    }),
  r2ClearConfig: () => safeInvoke<void>('r2_clear_config'),
  r2TestConnection: () => safeInvoke<void>('r2_test_connection'),
  r2Backup: (passphrase: string) => safeInvoke<BackupResult>('r2_backup', { passphrase }),
  r2Restore: (passphrase: string) => safeInvoke<void>('r2_restore', { passphrase }),

  openExternalUrl: (url: string) => safeInvoke<void>('open_external_url', { url }),
};
