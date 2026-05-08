import React, { useState, useEffect } from 'react';
import { safeInvoke } from './utils/tauri';
import DataExplorer from './components/DataExplorer';
import NLQInterface from './components/NLQInterface';
import ConnectionsManager from './components/ConnectionsManager';
import './index.css';

interface DatabaseStatus {
  connected: boolean;
  connectionName?: string;
}

const App: React.FC = () => {
  const [dbStatus, setDbStatus] = useState<DatabaseStatus>({ connected: false });
  const [statusMessage, setStatusMessage] = useState<string>('Ready');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [showConnectionsManager, setShowConnectionsManager] = useState(false);

  useEffect(() => {
    checkDatabaseStatus();
  }, []);

  const checkDatabaseStatus = async () => {
    try {
      const response = await safeInvoke('get_database_status');
      setDbStatus(response as DatabaseStatus);
    } catch (error) {
      console.error('Failed to check database status:', error);
    }
  };

  const handleConnectionChange = (connected: boolean, connectionName?: string) => {
    setDbStatus({ connected, connectionName });
  };

  const handleStatusUpdate = (message: string) => {
    setStatusMessage(message);
  };

  const handleLoadingChange = (loading: boolean) => {
    setIsLoading(loading);
  };

  return (
    <div className="h-screen flex flex-col bg-[#212121]">
      {/* Header/Navigation */}
      <header className="bg-[#2d2d2d] border-b border-[#404040] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-white">IntelQuery</h1>
          <span className="text-sm text-[#cccccc]">Database Query Tool</span>
        </div>
        <button 
          className="btn btn-secondary btn-sm"
          onClick={() => setShowConnectionsManager(true)}
        >
          Manage Connections
        </button>
      </header>

      <div className="h-px bg-[#0078d4]"></div>
      
      {/* Connection Status */}
      <div className="bg-[#2d2d2d] border-b border-[#404040] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${dbStatus.connected ? 'bg-[#107c10]' : 'bg-[#d13438]'}`}></div>
          <span className="text-sm text-white">
            {dbStatus.connected 
              ? `Connected to ${dbStatus.connectionName || 'database'}` 
              : 'Not connected to database'
            }
          </span>
        </div>
        <button 
          className="btn btn-secondary btn-sm"
          onClick={checkDatabaseStatus}
        >
          Refresh Status
        </button>
      </div>
      
      {/* Main Content */}
      <main className="flex-1 bg-[#212121] overflow-hidden">
        <div className="h-full flex gap-4 p-4">
          {/* Left Column - Data Explorer */}
          <div className="flex-1 min-w-0 max-w-[25%]">
            <DataExplorer 
              dbConnected={dbStatus.connected}
              onStatusUpdate={handleStatusUpdate}
              onLoadingChange={handleLoadingChange}
            />
          </div>
          
          {/* Right Column - NLQ Interface */}
          <div className="flex-1 min-w-0">
            <NLQInterface 
              dbConnected={dbStatus.connected}
              onStatusUpdate={handleStatusUpdate}
              onLoadingChange={handleLoadingChange}
            />
          </div>
        </div>
      </main>
      
      <div className="h-px bg-[#0078d4]"></div>
      
      {/* Status Bar */}
      <footer className="bg-[#2d2d2d] border-t border-[#404040] px-6 py-2">
        <div className="flex items-center gap-3">
          {isLoading && (
            <div className="loading-spinner">
              <div className="spinner"></div>
            </div>
          )}
          <span className="status-message text-sm text-[#cccccc]">
            {statusMessage}
          </span>
        </div>
      </footer>
      
      {/* Connections Manager Modal */}
      {showConnectionsManager && (
        <div className="modal-overlay" onClick={() => setShowConnectionsManager(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Saved Connections</h3>
              <button className="modal-close" onClick={() => setShowConnectionsManager(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <ConnectionsManager 
                onConnectionSelect={(connection) => {
                  setShowConnectionsManager(false);
                  handleConnectionChange(true, connection.name);
                }}
                onStatusUpdate={handleStatusUpdate}
                onConnectionChange={handleConnectionChange}
                onCancel={() => setShowConnectionsManager(false)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
