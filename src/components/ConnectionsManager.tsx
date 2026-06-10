import React, { useEffect, useState } from 'react';
import { Database, Server, HardDrive, User, Plus } from 'lucide-react';
import { api } from '../services/api';
import { sync } from '../services/sync';
import { useDb } from '../store/DbContext';

interface ConnectionRecord {
  id: string;
  name: string;
  db_type: string;
  host: string;
  port: number;
  database: string;
  username: string;
}

interface FormState extends ConnectionRecord {
  password: string;
}

interface Props {
  onClose: () => void;
}

const STORAGE_KEY = 'intelquery_connections';
const credentialAccount = (id: string) => `conn_${id}_password`;

const defaultForm: FormState = {
  id: '',
  name: '',
  db_type: 'postgresql',
  host: '',
  port: 5432,
  database: '',
  username: '',
  password: '',
};

const ConnectionsManager: React.FC<Props> = ({ onClose }) => {
  const { markConnected, setStatusMessage } = useDb();

  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [formData, setFormData] = useState<FormState>(defaultForm);

  // One-time migration of any legacy localStorage connections into the local
  // SQLite store (plaintext passwords are pushed into the OS keychain), then
  // load from SQLite. Once migrated the localStorage key is removed.
  useEffect(() => {
    (async () => {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        let parsed: any[] = [];
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = [];
        }
        for (const c of parsed) {
          if (c && typeof c === 'object' && c.id) {
            if (typeof c.password === 'string' && c.password.length > 0) {
              try {
                await api.credentialSet(credentialAccount(c.id), c.password);
              } catch (e) {
                console.warn('Keyring migration failed for', c.id, e);
              }
            }
            const { password, ...rest } = c;
            try {
              await sync.saveConnection(rest as ConnectionRecord);
            } catch (e) {
              console.warn('Failed to migrate connection', c.id, e);
            }
          }
        }
        localStorage.removeItem(STORAGE_KEY);
      }
      await reload();
    })();
  }, []);

  const reload = async () => {
    try {
      setConnections(await sync.listConnections());
    } catch (e) {
      console.warn('Failed to load connections', e);
    }
  };

  const resetForm = () => {
    setFormData(defaultForm);
    setEditingId(null);
    setFormErrors({});
  };

  const openCreate = () => {
    resetForm();
    setShowModal(true);
  };

  const openEdit = async (conn: ConnectionRecord) => {
    let password = '';
    try {
      password = (await api.credentialGet(credentialAccount(conn.id))) ?? '';
    } catch (e) {
      console.warn('Could not load password from keyring', e);
    }
    setFormData({ ...conn, password });
    setEditingId(conn.id);
    setFormErrors({});
    setShowModal(true);
  };

  const deleteConnection = async (id: string) => {
    try {
      await api.credentialDelete(credentialAccount(id));
    } catch (e) {
      console.warn('Failed to delete keyring entry', e);
    }
    try {
      await sync.deleteConnection(id);
    } catch (e) {
      console.warn('Failed to delete connection', e);
    }
    await reload();
  };

  const validateForm = (): boolean => {
    const errors: Partial<Record<keyof FormState, string>> = {};
    if (!formData.name.trim()) errors.name = 'Connection name is required';
    if (!formData.database.trim()) errors.database = 'Database name is required';
    if (formData.db_type !== 'sqlite') {
      if (!formData.host.trim()) errors.host = 'Host is required';
      if (!formData.username.trim()) errors.username = 'Username is required';
      if (!formData.port || formData.port <= 0 || formData.port > 65535) {
        errors.port = 'Invalid port';
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const connectAndStore = async (record: ConnectionRecord, password: string) => {
    const resp = await api.connect({
      dbType: record.db_type,
      host: record.host,
      port: record.port,
      database: record.database,
      username: record.username,
      password,
    });
    return resp;
  };

  const saveConnection = async () => {
    if (!validateForm()) {
      setStatusMessage('Please fix the form errors');
      return;
    }
    const id = editingId ?? Date.now().toString();
    setConnectingId(id);
    try {
      const record: ConnectionRecord = {
        id,
        name: formData.name,
        db_type: formData.db_type,
        host: formData.host,
        port: formData.port,
        database: formData.database,
        username: formData.username,
      };

      // Store password in OS keychain (or remove if blank).
      try {
        if (formData.password) {
          await api.credentialSet(credentialAccount(id), formData.password);
        } else {
          await api.credentialDelete(credentialAccount(id));
        }
      } catch (e) {
        setStatusMessage(`Failed to store credential: ${e}`);
        setConnectingId(null);
        return;
      }

      // Persist to the local SQLite store and refresh the list.
      await sync.saveConnection(record);
      await reload();

      // Auto-connect.
      setStatusMessage('Connecting...');
      const resp = await connectAndStore(record, formData.password);
      if (resp.success) {
        setStatusMessage('Connected');
        await markConnected(record.name, record.id, record.db_type);
        setShowModal(false);
        resetForm();
        onClose();
      } else {
        setStatusMessage(`Connection failed: ${resp.message}`);
      }
    } catch (e) {
      setStatusMessage(`Failed to save: ${e}`);
    } finally {
      setConnectingId(null);
    }
  };

  const testAndConnect = async (record: ConnectionRecord) => {
    setConnectingId(record.id);
    try {
      const password = (await api.credentialGet(credentialAccount(record.id))) ?? '';
      setStatusMessage('Connecting...');
      const resp = await connectAndStore(record, password);
      if (resp.success) {
        setStatusMessage('Connected');
        await markConnected(record.name, record.id, record.db_type);
        onClose();
      } else {
        setStatusMessage(`Connection failed: ${resp.message}`);
      }
    } catch (e) {
      setStatusMessage(`Error: ${e}`);
    } finally {
      setConnectingId(null);
    }
  };

  return (
    <div className="connections-manager">
      <div className="connections-header">
        <div>
          <h3>Saved Connections</h3>
          <p className="connections-subtitle">
            Credentials are stored in your OS keychain.
          </p>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" />
          Add Connection
        </button>
      </div>

      <div className="connections-list">
        {connections.length === 0 ? (
          <div className="no-connections">
            <Database className="no-connections-icon" size={48} />
            <h4>No saved connections</h4>
            <p>Click "Add Connection" to create your first database connection</p>
          </div>
        ) : (
          connections.map(connection => (
            <div key={connection.id} className="connection-item">
              <div className="connection-info">
                <div className="connection-header-row">
                  <div className="connection-name">{connection.name}</div>
                  <div className="connection-type-badge">{connection.db_type}</div>
                </div>
                <div className="connection-details">
                  {connection.db_type !== 'sqlite' && (
                    <span className="connection-detail-item">
                      <Server className="detail-icon" size={16} />
                      {connection.host}:{connection.port}
                    </span>
                  )}
                  <span className="connection-detail-item">
                    <HardDrive className="detail-icon" size={16} />
                    {connection.database}
                  </span>
                  {connection.db_type !== 'sqlite' && (
                    <span className="connection-detail-item">
                      <User className="detail-icon" size={16} />
                      {connection.username}
                    </span>
                  )}
                </div>
              </div>
              <div className="connection-actions">
                <button
                  className="btn btn-success btn-sm"
                  onClick={() => testAndConnect(connection)}
                  disabled={connectingId === connection.id}
                >
                  Connect
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => openEdit(connection)}
                >
                  Edit
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => deleteConnection(connection.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingId ? 'Edit Connection' : 'Add Connection'}</h3>
              <button
                className="modal-close"
                onClick={() => {
                  setShowModal(false);
                  resetForm();
                }}
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="form-section">
                <div className="form-section-title">Basic Information</div>
                <div className="form-group">
                  <label>Connection Name *</label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.name}
                    onChange={e => {
                      setFormData(prev => ({ ...prev, name: e.target.value }));
                      setFormErrors(prev => ({ ...prev, name: '' }));
                    }}
                    placeholder="My Database Connection"
                  />
                  {formErrors.name && <span className="form-error">{formErrors.name}</span>}
                </div>

                <div className="form-group">
                  <label>Database Type</label>
                  <select
                    className="form-input"
                    value={formData.db_type}
                    onChange={e => {
                      const next = e.target.value;
                      setFormData(prev => ({
                        ...prev,
                        db_type: next,
                        port:
                          next === 'postgresql' ? 5432 : next === 'mysql' ? 3306 : prev.port,
                      }));
                    }}
                  >
                    <option value="postgresql">PostgreSQL</option>
                    <option value="mysql">MySQL</option>
                    <option value="sqlite">SQLite</option>
                  </select>
                </div>
              </div>

              {formData.db_type !== 'sqlite' && (
                <div className="form-section">
                  <div className="form-section-title">Server Details</div>
                  <div className="form-row flex gap-3">
                    <div className="form-group flex-1">
                      <label>Host *</label>
                      <input
                        type="text"
                        className="form-input"
                        value={formData.host}
                        onChange={e => {
                          setFormData(prev => ({ ...prev, host: e.target.value }));
                          setFormErrors(prev => ({ ...prev, host: '' }));
                        }}
                        placeholder="localhost"
                      />
                      {formErrors.host && <span className="form-error">{formErrors.host}</span>}
                    </div>
                    <div className="form-group" style={{ maxWidth: 120 }}>
                      <label>Port *</label>
                      <input
                        type="number"
                        className="form-input"
                        value={formData.port}
                        onChange={e => {
                          setFormData(prev => ({
                            ...prev,
                            port: parseInt(e.target.value) || 0,
                          }));
                          setFormErrors(prev => ({ ...prev, port: '' }));
                        }}
                      />
                      {formErrors.port && <span className="form-error">{formErrors.port}</span>}
                    </div>
                  </div>
                </div>
              )}

              <div className="form-section">
                <div className="form-section-title">Credentials</div>
                <div className="form-group">
                  <label>Database Name *</label>
                  <input
                    type="text"
                    className="form-input"
                    value={formData.database}
                    onChange={e => {
                      setFormData(prev => ({ ...prev, database: e.target.value }));
                      setFormErrors(prev => ({ ...prev, database: '' }));
                    }}
                    placeholder={formData.db_type === 'sqlite' ? '/path/to/file.db' : 'mydatabase'}
                  />
                  {formErrors.database && (
                    <span className="form-error">{formErrors.database}</span>
                  )}
                </div>

                {formData.db_type !== 'sqlite' && (
                  <div className="form-row flex gap-3">
                    <div className="form-group flex-1">
                      <label>Username *</label>
                      <input
                        type="text"
                        className="form-input"
                        value={formData.username}
                        onChange={e => {
                          setFormData(prev => ({ ...prev, username: e.target.value }));
                          setFormErrors(prev => ({ ...prev, username: '' }));
                        }}
                      />
                      {formErrors.username && (
                        <span className="form-error">{formErrors.username}</span>
                      )}
                    </div>
                    <div className="form-group flex-1">
                      <label>Password</label>
                      <input
                        type="password"
                        className="form-input"
                        value={formData.password}
                        onChange={e =>
                          setFormData(prev => ({ ...prev, password: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowModal(false);
                  resetForm();
                }}
                disabled={connectingId !== null}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={saveConnection}
                disabled={connectingId !== null}
              >
                {connectingId !== null
                  ? 'Connecting...'
                  : editingId
                  ? 'Update & Connect'
                  : 'Save & Connect'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConnectionsManager;
