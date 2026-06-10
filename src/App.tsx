import React, { useEffect, useState } from 'react';
import { Tag } from 'lucide-react';
import DataExplorer from './components/DataExplorer';
import NLQInterface from './components/NLQInterface';
import ConnectionsManager from './components/ConnectionsManager';
import SyncSettings from './components/SyncSettings';
import SetupGuide from './components/SetupGuide';
import AnnotationPanel from './components/annotations/AnnotationPanel';
import { sync } from './services/sync';
import { DbProvider, useDb } from './store/DbContext';
import { AiSettingsProvider, useAiSettings } from './store/AiSettingsContext';
import { AnnotationProvider, useAnnotations } from './store/AnnotationContext';
import { ThemeProvider } from '@/components/theme-provider';
import { ThemeToggle } from '@/components/theme-toggle';
import './index.css';

const Workspace: React.FC = () => (
  <div className="h-full flex gap-4 p-4">
    <div className="w-[280px] shrink-0">
      <DataExplorer />
    </div>
    <div className="flex-1 min-w-0">
      <NLQInterface />
    </div>
  </div>
);

const ONBOARDING_DONE_KEY = 'onboarding_done';

const Shell: React.FC = () => {
  const { status, statusMessage, isLoading, initializing, disconnect } = useDb();
  const { loaded: aiLoaded, configuredAtStart } = useAiSettings();
  const { openPanel } = useAnnotations();
  const [showConnectionsManager, setShowConnectionsManager] = useState(false);
  const [showSync, setShowSync] = useState(false);

  // The workspace is shown only after the user has explicitly finished the
  // setup guide (persisted), so completing a single step never skips the rest.
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setOnboardingDone((await sync.getSetting(ONBOARDING_DONE_KEY)) === 'true');
      } catch {
        // ignore — treat as not onboarded
      } finally {
        setOnboardingLoaded(true);
      }
    })();
  }, []);

  const completeOnboarding = () => {
    setOnboardingDone(true);
    sync.setSetting(ONBOARDING_DONE_KEY, 'true').catch(() => {
      // best-effort persistence
    });
  };

  const booting = initializing || !aiLoaded || !onboardingLoaded;
  // Show workspace only after the user has explicitly finished onboarding
  const showWorkspace = onboardingDone;

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="bg-card border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-foreground">IntelQuery</h1>
          <span className="text-sm text-muted-foreground">Database Query Tool</span>
        </div>
        <div className="flex gap-2 items-center">
          {showWorkspace && (
            <>
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
              {status.connected && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => openPanel()}
                  title="Add annotations to tables and columns"
                >
                  <Tag className="w-4 h-4 mr-2" />
                  Annotate
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => setShowSync(true)}>
                Sync
              </button>
            </>
          )}
          <ThemeToggle />
        </div>
      </header>

      <div className="h-px bg-primary"></div>

      <div className="bg-card border-b border-border px-6 py-3 flex items-center gap-3">
        <div
          className={`w-3 h-3 rounded-full ${status.connected ? 'bg-success' : 'bg-destructive'}`}
        ></div>
        <span className="text-sm text-foreground">
          {status.connected
            ? `Connected to ${status.connectionName ?? 'database'}`
            : 'Not connected to database'}
        </span>
      </div>

      <main className="flex-1 bg-background overflow-hidden">
        {booting ? (
          <div className="h-full flex items-center justify-center">
            <div className="spinner"></div>
          </div>
        ) : showWorkspace ? (
          <Workspace />
        ) : (
          <SetupGuide
            onOpenConnections={() => setShowConnectionsManager(true)}
            onEnter={completeOnboarding}
          />
        )}
      </main>

      <div className="h-px bg-primary"></div>

      <footer className="bg-card border-t border-border px-6 py-2">
        <div className="flex items-center gap-3">
          {isLoading && (
            <div className="loading-spinner">
              <div className="spinner"></div>
            </div>
          )}
          <span className="status-message text-sm text-muted-foreground">{statusMessage}</span>
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

      <AnnotationPanel />

      {showSync && (
        <div className="modal-overlay" onClick={() => setShowSync(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Sync & Backup</h3>
              <button className="modal-close" onClick={() => setShowSync(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <SyncSettings onClose={() => setShowSync(false)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const App: React.FC = () => (
  <ThemeProvider defaultTheme="system" storageKey="intelquery-theme">
    <DbProvider>
      <AiSettingsProvider>
        <AnnotationProvider>
          <Shell />
        </AnnotationProvider>
      </AiSettingsProvider>
    </DbProvider>
  </ThemeProvider>
);

export default App;
