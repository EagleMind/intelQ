import React, { useState } from 'react';
import { safeInvoke } from '../utils/tauri';

interface DatabaseStatus {
  connected: boolean;
  connectionName?: string;
}

interface ConnectionStatusProps {
  status: DatabaseStatus;
  onConnectionChange: (connected: boolean, connectionName?: string) => void;
  onStatusUpdate: (message: string) => void;
  onLoadingChange: (loading: boolean) => void;
}

interface DatabaseConfig {
  db_type: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

const ConnectionStatus: React.FC<ConnectionStatusProps> = ({
  status,
  onConnectionChange,
  onStatusUpdate,
  onLoadingChange
}) => {
  const [showConnectionDialog, setShowConnectionDialog] = useState(false);
  const [dbConfig, setDbConfig] = useState<DatabaseConfig>({
    db_type: 'postgresql',
    host: 'localhost',
    port: 5432,
    database: '',
    username: '',
    password: ''
  });
  
  const handleConnect = async () => {
    try {
      onLoadingChange(true);
      onStatusUpdate('Connecting to database...');
      
      const response = await safeInvoke('connect_database', {
        dbType: dbConfig.db_type,
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        username: dbConfig.username,
        password: dbConfig.password
      });
      
      const result = response as { success: boolean; message: string };
      
      if (result.success) {
        onConnectionChange(true, `${dbConfig.database}@${dbConfig.host}`);
        onStatusUpdate('Connected successfully');
      } else {
        onStatusUpdate(`Connection failed: ${result.message}`);
      }
    } catch (error) {
      onStatusUpdate(`Connection error: ${error}`);
    } finally {
      onLoadingChange(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      onLoadingChange(true);
      onStatusUpdate('Disconnecting from database...');
      
      const response = await safeInvoke('disconnect_database', {});
      const result = response as { success: boolean; message: string };
      
      if (result.success) {
        onConnectionChange(false);
        onStatusUpdate(result.message);
      } else {
        onStatusUpdate(`Disconnection failed: ${result.message}`);
      }
    } catch (error) {
      onStatusUpdate(`Disconnection error: ${error}`);
    } finally {
      onLoadingChange(false);
    }
  };

  const handleInputChange = (field: keyof DatabaseConfig, value: string | number) => {
    setDbConfig(prev => ({
      ...prev,
      [field]: value
    }));
  };

  return (
    <div className="connection-status">
      <div className="connection-info">
        <div className={`status-indicator ${status.connected ? 'connected' : 'disconnected'}`}></div>
        <span className="status-text">
          {status.connected 
            ? `Connected: ${status.connectionName || 'Database'}` 
            : 'Not Connected'
          }
        </span>
      </div>
      
      <div className="connection-actions">
        {status.connected ? (
          <button className="btn btn-danger" onClick={handleDisconnect}>
            Disconnect
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => setShowConnectionDialog(true)}>
            Connect
          </button>
        )}
      </div>

      {showConnectionDialog && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h3>Database Connection</h3>
              <button 
                className="modal-close" 
                onClick={() => setShowConnectionDialog(false)}
              >
                ×
              </button>
            </div>
            
            <div className="modal-body">
              <div className="form-group">
                <label>Database Type:</label>
                <select 
                  value={dbConfig.db_type}
                  onChange={(e) => handleInputChange('db_type', e.target.value)}
                >
                  <option value="postgresql">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                </select>
              </div>

              <div className="form-group">
                <label>Host:</label>
                <input 
                  type="text"
                  value={dbConfig.host}
                  onChange={(e) => handleInputChange('host', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Port:</label>
                <input 
                  type="number"
                  value={dbConfig.port}
                  onChange={(e) => handleInputChange('port', parseInt(e.target.value))}
                />
              </div>

              <div className="form-group">
                <label>Database:</label>
                <input 
                  type="text"
                  value={dbConfig.database}
                  onChange={(e) => handleInputChange('database', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Username:</label>
                <input 
                  type="text"
                  value={dbConfig.username}
                  onChange={(e) => handleInputChange('username', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>Password:</label>
                <input 
                  type="password"
                  value={dbConfig.password}
                  onChange={(e) => handleInputChange('password', e.target.value)}
                />
              </div>
            </div>
            
            <div className="modal-footer">
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowConnectionDialog(false)}
              >
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleConnect}>
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ConnectionStatus;
