import React, { useState, useEffect } from 'react';
import { safeInvoke } from '../utils/tauri';
import { Database, Server, HardDrive, User, Plus } from 'lucide-react';
import '../App.css';

interface ConnectionConfig {
  id: string;
  name: string;
  db_type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

interface ConnectionsManagerProps {
  onConnectionSelect: (connection: ConnectionConfig) => void;
  onStatusUpdate: (message: string) => void;
  onConnectionChange?: (connected: boolean, connectionName?: string) => void;
  onCancel?: () => void;
}

const ConnectionsManager: React.FC<ConnectionsManagerProps> = ({
  onConnectionSelect,
  onStatusUpdate,
  onConnectionChange,
  onCancel
}) => {
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof ConnectionConfig, string>>>({});
  const [formData, setFormData] = useState<ConnectionConfig>({
    id: '',
    name: '',
    db_type: 'postgresql',
    host: '',
    port: 5432,
    database: '',
    username: '',
    password: ''
  });

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      // Load saved connections from local storage
      const saved = localStorage.getItem('intelquery_connections');
      if (saved) {
        setConnections(JSON.parse(saved));
      }
    } catch (error) {
      console.error('Failed to load connections:', error);
    }
  };

  const saveConnections = async (connectionsList: ConnectionConfig[]) => {
    try {
      localStorage.setItem('intelquery_connections', JSON.stringify(connectionsList));
      setConnections(connectionsList);
      onStatusUpdate('Connections saved successfully');
    } catch (error) {
      onStatusUpdate(`Failed to save connections: ${error}`);
    }
  };

  const testConnection = async (connection: ConnectionConfig) => {
    try {
      onStatusUpdate('Testing connection...');
      const response = await safeInvoke('connect_database', {
        dbType: connection.db_type,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
        password: connection.password
      });
      
      const result = response as { success: boolean; message: string };
      if (result.success) {
        onStatusUpdate('Connection test successful');
        onConnectionSelect(connection);
        // Auto-update status after successful connection
        if (onConnectionChange) {
          onConnectionChange(true, connection.name);
        }
      } else {
        onStatusUpdate(`Connection test failed: ${result.message}`);
      }
    } catch (error) {
      onStatusUpdate(`Connection test error: ${error}`);
    }
  };

  const deleteConnection = async (id: string) => {
    const updatedConnections = connections.filter(conn => conn.id !== id);
    await saveConnections(updatedConnections);
  };

  const validateForm = (): boolean => {
    const errors: Partial<Record<keyof ConnectionConfig, string>> = {};
    
    if (!formData.name?.trim()) {
      errors.name = 'Connection name is required';
    }
    
    if (!formData.database?.trim()) {
      errors.database = 'Database name is required';
    }
    
    if (formData.db_type !== 'sqlite') {
      if (!formData.host?.trim()) {
        errors.host = 'Host is required';
      }
      if (!formData.username?.trim()) {
        errors.username = 'Username is required';
      }
      if (!formData.port || formData.port <= 0 || formData.port > 65535) {
        errors.port = 'Invalid port number';
      }
    }
    
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const saveConnection = async () => {
    console.log('Save connection clicked', formData);
    
    if (!validateForm()) {
      onStatusUpdate('Please fix the form errors before saving');
      return;
    }

    setIsConnecting(true);
    
    try {
      let connectionToSave: ConnectionConfig;
      
      if (editingConnection) {
        // Update existing connection
        connectionToSave = { ...formData, id: editingConnection.id };
        const updatedConnections = connections.map(conn => 
          conn.id === editingConnection.id ? connectionToSave : conn
        );
        await saveConnections(updatedConnections);
      } else {
        // Add new connection
        connectionToSave = { ...formData, id: Date.now().toString() };
        await saveConnections([...connections, connectionToSave]);
      }

      // Auto-connect after saving
      onStatusUpdate('Connecting to database...');
      const response = await safeInvoke('connect_database', {
        dbType: connectionToSave.db_type,
        host: connectionToSave.host,
        port: connectionToSave.port,
        database: connectionToSave.database,
        username: connectionToSave.username,
        password: connectionToSave.password
      });
      
      const result = response as { success: boolean; message: string };
      if (result.success) {
        onStatusUpdate('Connection saved and connected successfully!');
        onConnectionSelect(connectionToSave);
        // Auto-update status after successful connection
        if (onConnectionChange) {
          onConnectionChange(true, connectionToSave.name);
        }
        setShowModal(false);
        resetForm();
      } else {
        onStatusUpdate(`Connection saved but failed to connect: ${result.message}`);
      }
    } catch (error) {
      console.error('Save connection error:', error);
      onStatusUpdate(`Failed to save connection: ${error}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const resetForm = () => {
    setFormData({
      id: '',
      name: '',
      db_type: 'postgresql',
      host: '',
      port: 5432,
      database: '',
      username: '',
      password: ''
    });
    setEditingConnection(null);
  };

  const editConnection = (connection: ConnectionConfig) => {
    setFormData(connection);
    setEditingConnection(connection);
    setShowModal(true);
  };

  return (
    <div className="connections-manager">
      <div className="connections-header">
        <div>
          <h3>Saved Connections</h3>
          <p className="connections-subtitle">Manage your database connections</p>
        </div>
        <button 
          className="btn btn-primary"
          onClick={() => setShowModal(true)}
        >
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
                  <span className="connection-detail-item">
                    <Server className="detail-icon" size={16} />
                    {connection.host}:{connection.port}
                  </span>
                  <span className="connection-detail-item">
                    <HardDrive className="detail-icon" size={16} />
                    {connection.database}
                  </span>
                  <span className="connection-detail-item">
                    <User className="detail-icon" size={16} />
                    {connection.username}
                  </span>
                </div>
              </div>
              <div className="connection-actions">
                <button 
                  className="btn btn-success btn-sm"
                  onClick={() => testConnection(connection)}
                  title="Test and connect to this database"
                >
                  Connect
                </button>
                <button 
                  className="btn btn-secondary btn-sm"
                  onClick={() => editConnection(connection)}
                  title="Edit connection settings"
                >
                  Edit
                </button>
                <button 
                  className="btn btn-danger btn-sm"
                  onClick={() => deleteConnection(connection.id)}
                  title="Delete this connection"
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h3>{editingConnection ? 'Edit Connection' : 'Add Connection'}</h3>
              <button className="modal-close" onClick={() => { resetForm(); onCancel?.(); }}>
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
                    value={formData.name || ''}
                    onChange={(e) => {
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
                    value={formData.db_type || 'postgresql'}
                    onChange={(e) => {
                      setFormData(prev => ({ ...prev, db_type: e.target.value }));
                      // Reset port to default when changing DB type
                      if (e.target.value === 'postgresql') {
                        setFormData(prev => ({ ...prev, port: 5432 }));
                      } else if (e.target.value === 'mysql') {
                        setFormData(prev => ({ ...prev, port: 3306 }));
                      }
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
                  <div className="form-row">
                    <div className="form-group">
                      <label>Host *</label>
                      <input
                        type="text"
                        className="form-input"
                        value={formData.host || ''}
                        onChange={(e) => {
                          setFormData(prev => ({ ...prev, host: e.target.value }));
                          setFormErrors(prev => ({ ...prev, host: '' }));
                        }}
                        placeholder="localhost"
                      />
                      {formErrors.host && <span className="form-error">{formErrors.host}</span>}
                    </div>
                    <div className="form-group">
                      <label>Port *</label>
                      <input
                        type="number"
                        className="form-input"
                        value={formData.port || 5432}
                        onChange={(e) => {
                          setFormData(prev => ({ ...prev, port: parseInt(e.target.value) }));
                          setFormErrors(prev => ({ ...prev, port: '' }));
                        }}
                        placeholder="5432"
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
                    value={formData.database || ''}
                    onChange={(e) => {
                      setFormData(prev => ({ ...prev, database: e.target.value }));
                      setFormErrors(prev => ({ ...prev, database: '' }));
                    }}
                    placeholder="mydatabase"
                  />
                  {formErrors.database && <span className="form-error">{formErrors.database}</span>}
                </div>

                {formData.db_type !== 'sqlite' && (
                  <div className="form-row">
                    <div className="form-group">
                      <label>Username *</label>
                      <input
                        type="text"
                        className="form-input"
                        value={formData.username || ''}
                        onChange={(e) => {
                          setFormData(prev => ({ ...prev, username: e.target.value }));
                          setFormErrors(prev => ({ ...prev, username: '' }));
                        }}
                        placeholder="postgres"
                      />
                      {formErrors.username && <span className="form-error">{formErrors.username}</span>}
                    </div>
                    <div className="form-group">
                      <label>Password</label>
                      <input
                        type="password"
                        className="form-input"
                        value={formData.password || ''}
                        onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                        placeholder="password"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              <button 
                className="btn btn-secondary"
                onClick={() => { resetForm(); onCancel?.(); }}
                disabled={isConnecting}
              >
                Cancel
              </button>
              <button 
                className={`btn ${isConnecting ? 'btn-loading' : 'btn-primary'}`}
                onClick={saveConnection}
                disabled={isConnecting}
              >
                {isConnecting ? (
                  <>
                    <span className="loading-spinner"></span>
                    Connecting...
                  </>
                ) : (
                  <>
                    {editingConnection ? 'Update' : 'Save'} & Connect
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConnectionsManager;
