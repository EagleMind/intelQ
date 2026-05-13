import React, { useState } from 'react';
import DataExplorer from './components/DataExplorer';
import NLQInterface from './components/NLQInterface';
import ConnectionsManager from './components/ConnectionsManager';
import { DbProvider, useDb } from './store/DbContext';
import './index.css';

const Shell: React.FC = () => {
  const { status, statusMessage, isLoading, disconnect } = useDb();
  const [showConnectionsManager, setShowConnectionsManager] = useState(false);

  return (
    <div className="h-screen flex flex-col bg-[#212121]">
      <header className="bg-[#2d2d2d] border-b border-[#404040] px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-white">IntelQuery</h1>
          <span className="text-sm text-[#cccccc]">Database Query Tool</span>
        </div>
        <div className="flex gap-2">
          {status.connected && (
            <button className="btn btn-secondary btn-sm" onClick={disconnect}>
              Disconnect
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowConnectionsManager(true)}
          >
            Manage Connections
          </button>
        </div>
      </header>

      <div className="h-px bg-[#0078d4]"></div>

      <div className="bg-[#2d2d2d] border-b border-[#404040] px-6 py-3 flex items-center gap-3">
        <div
          className={`w-3 h-3 rounded-full ${status.connected ? 'bg-[#107c10]' : 'bg-[#d13438]'}`}
        ></div>
        <span className="text-sm text-white">
          {status.connected
            ? `Connected to ${status.connectionName ?? 'database'}`
            : 'Not connected to database'}
        </span>
      </div>

      <main className="flex-1 bg-[#212121] overflow-hidden">
        <div className="h-full flex gap-4 p-4">
          <div className="w-[280px] shrink-0">
            <DataExplorer />
          </div>
          <div className="flex-1 min-w-0">
            <NLQInterface />
          </div>
        </div>
      </main>

      <div className="h-px bg-[#0078d4]"></div>

      <footer className="bg-[#2d2d2d] border-t border-[#404040] px-6 py-2">
        <div className="flex items-center gap-3">
          {isLoading && (
            <div className="loading-spinner">
              <div className="spinner"></div>
            </div>
          )}
          <span className="status-message text-sm text-[#cccccc]">{statusMessage}</span>
        </div>
      </footer>

      {showConnectionsManager && (
        <div className="modal-overlay" onClick={() => setShowConnectionsManager(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Saved Connections</h3>
              <button
                className="modal-close"
                onClick={() => setShowConnectionsManager(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <ConnectionsManager onClose={() => setShowConnectionsManager(false)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const App: React.FC = () => (
  <DbProvider>
    <Shell />
  </DbProvider>
);

export default App;
