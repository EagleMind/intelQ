import React, { useEffect, useState } from 'react';
import { Cloud, CloudOff, ExternalLink, UploadCloud, DownloadCloud, ShieldCheck } from 'lucide-react';
import { sync, type R2Config } from '../services/sync';

interface Props {
  onClose: () => void;
}

// Deep-link into the user's Cloudflare dashboard R2 API-tokens page. `:account`
// resolves to the signed-in account.
const R2_TOKEN_URL = 'https://dash.cloudflare.com/?to=/:account/r2/api-tokens';

const formatWhen = (iso: string | null): string => {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

const SyncSettings: React.FC<Props> = ({ onClose }) => {
  const [config, setConfig] = useState<R2Config | null>(null);
  const [editing, setEditing] = useState(false);

  // Connection form
  const [accountId, setAccountId] = useState('');
  const [bucket, setBucket] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [endpoint, setEndpoint] = useState('');

  // Backup
  const [passphrase, setPassphrase] = useState('');

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadConfig = async () => {
    try {
      const cfg = await sync.r2GetConfig();
      setConfig(cfg);
      if (cfg) {
        setAccountId(cfg.account_id);
        setBucket(cfg.bucket);
        setAccessKeyId(cfg.access_key_id);
        setEndpoint(cfg.endpoint);
        setEditing(false);
      } else {
        setEditing(true);
      }
    } catch (e) {
      setError(`Failed to load R2 config: ${e}`);
      setEditing(true);
    }
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const connected = !!config?.connected;

  const flash = (msg: string) => {
    setError(null);
    setMessage(msg);
  };
  const fail = (msg: string) => {
    setMessage(null);
    setError(msg);
  };

  const openTokenPage = async () => {
    try {
      await sync.openExternalUrl(R2_TOKEN_URL);
    } catch (e) {
      fail(`Could not open browser: ${e}`);
    }
  };

  const saveAndTest = async () => {
    setError(null);
    setMessage(null);
    if (!accountId.trim() || !bucket.trim() || !accessKeyId.trim() || !secretAccessKey.trim()) {
      fail('Account ID, bucket, Access Key ID and Secret Access Key are all required.');
      return;
    }
    setBusy(true);
    try {
      await sync.r2SaveConfig({
        accountId: accountId.trim(),
        bucket: bucket.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        endpoint: endpoint.trim() || undefined,
      });
      await sync.r2TestConnection();
      setSecretAccessKey('');
      await loadConfig();
      flash('Connected to Cloudflare R2 — the bucket is reachable.');
    } catch (e) {
      fail(`Could not reach the bucket: ${e}. The token was saved — fix the details and test again.`);
      await loadConfig();
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect R2? Your local data stays; only the saved R2 token is removed.')) {
      return;
    }
    setBusy(true);
    try {
      await sync.r2ClearConfig();
      setConfig(null);
      setSecretAccessKey('');
      setEditing(true);
      flash('R2 disconnected.');
    } catch (e) {
      fail(`Failed to disconnect: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const backup = async () => {
    setError(null);
    setMessage(null);
    if (!passphrase.trim()) {
      fail('Enter a passphrase. It encrypts the backup before upload — keep it safe; without it the backup cannot be restored.');
      return;
    }
    setBusy(true);
    try {
      const res = await sync.r2Backup(passphrase);
      await loadConfig();
      flash(`Backed up ${(res.bytes / 1024).toFixed(1)} KB to R2.`);
    } catch (e) {
      fail(`Backup failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setError(null);
    setMessage(null);
    if (!passphrase.trim()) {
      fail('Enter the passphrase you used when creating the backup.');
      return;
    }
    if (
      !window.confirm(
        'Restore from R2? This OVERWRITES your local connections and settings with the backup. ' +
          'A copy of the current data is kept as intelquery.db.bak. The app will reload afterwards.'
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await sync.r2Restore(passphrase);
      flash('Restore complete — reloading…');
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      fail(`Restore failed: ${e}`);
      setBusy(false);
    }
  };

  return (
    <div className="connections-manager">
      <div className="connections-header">
        <div>
          <h3>Cloudflare R2 Sync</h3>
          <p className="connections-subtitle">
            Your data lives locally in SQLite. Back it up to your own R2 bucket — encrypted with a
            passphrase. Passwords/API keys stay in your OS keychain and are never uploaded.
          </p>
        </div>
        {connected && !editing && (
          <span className="connection-type-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Cloud size={14} /> {config?.bucket}
          </span>
        )}
      </div>

      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
      {message && (
        <div style={{ color: 'var(--success)', marginBottom: 12, fontSize: 14 }}>{message}</div>
      )}

      {/* ---- Connection ---- */}
      {(!connected || editing) ? (
        <div className="form-section">
          <div className="form-section-title">Connect your Cloudflare R2</div>
          <ol style={{ fontSize: 13, color: 'var(--muted-foreground)', paddingLeft: 18, marginBottom: 12, lineHeight: 1.7 }}>
            <li>
              Open the R2 API-tokens page and create a token with{' '}
              <strong>Object Read &amp; Write</strong> for your bucket.
            </li>
            <li>Copy the <strong>Access Key ID</strong> and <strong>Secret Access Key</strong> it shows.</li>
            <li>Find your <strong>Account ID</strong> on the R2 overview page; create a bucket if you don't have one.</li>
            <li>Paste everything below and click <strong>Save &amp; Test</strong>.</li>
          </ol>
          <button className="btn btn-secondary btn-sm" onClick={openTokenPage} disabled={busy}>
            <ExternalLink size={14} style={{ marginRight: 6 }} /> Open Cloudflare token page
          </button>

          <div className="form-group" style={{ marginTop: 14 }}>
            <label>Account ID *</label>
            <input className="form-input" value={accountId} onChange={e => setAccountId(e.target.value)}
              placeholder="e.g. 1a2b3c4d5e6f..." />
          </div>
          <div className="form-group">
            <label>Bucket name *</label>
            <input className="form-input" value={bucket} onChange={e => setBucket(e.target.value)}
              placeholder="intelquery-backups" />
          </div>
          <div className="form-group">
            <label>Access Key ID *</label>
            <input className="form-input" value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Secret Access Key *</label>
            <input type="password" className="form-input" value={secretAccessKey}
              onChange={e => setSecretAccessKey(e.target.value)}
              placeholder={connected ? '•••••••• (stored — re-enter to change)' : ''} />
          </div>
          <div className="form-group">
            <label>Custom endpoint (optional)</label>
            <input className="form-input" value={endpoint} onChange={e => setEndpoint(e.target.value)}
              placeholder="https://<account>.r2.cloudflarestorage.com" />
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={saveAndTest} disabled={busy}>
              {busy ? 'Testing…' : 'Save & Test'}
            </button>
            {connected && (
              <button className="btn btn-secondary" onClick={() => { setEditing(false); loadConfig(); }} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="form-section">
          <div className="form-section-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldCheck size={16} color="var(--success)" /> Connected
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted-foreground)', lineHeight: 1.7 }}>
            <div>Bucket: <strong>{config?.bucket}</strong></div>
            <div>Endpoint: <span style={{ wordBreak: 'break-all' }}>{config?.endpoint}</span></div>
            <div>Last backup: <strong>{formatWhen(config?.last_backup_at ?? null)}</strong></div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)} disabled={busy}>
              Edit token
            </button>
            <button className="btn btn-danger btn-sm" onClick={disconnect} disabled={busy}>
              <CloudOff size={14} style={{ marginRight: 6 }} /> Disconnect
            </button>
          </div>
        </div>
      )}

      {/* ---- Backup / restore ---- */}
      <div className="form-section">
        <div className="form-section-title">Backup &amp; restore</div>
        <div className="form-group">
          <label>Encryption passphrase</label>
          <input type="password" className="form-input" value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            placeholder="Used to encrypt/decrypt the backup" />
          <span style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 4 }}>
            Keep this safe — if you lose it, an existing backup cannot be restored.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={backup} disabled={busy || !connected}>
            <UploadCloud size={15} style={{ marginRight: 6 }} /> Back up now
          </button>
          <button className="btn btn-secondary" onClick={restore} disabled={busy || !connected}>
            <DownloadCloud size={15} style={{ marginRight: 6 }} /> Restore from R2
          </button>
        </div>
        {!connected && (
          <span style={{ fontSize: 12, color: 'var(--muted-foreground)', marginTop: 8, display: 'block' }}>
            Connect R2 above to enable backup and restore.
          </span>
        )}
      </div>

      <div className="modal-footer">
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
    </div>
  );
};

export default SyncSettings;
