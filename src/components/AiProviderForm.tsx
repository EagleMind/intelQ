import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import {
  useAiSettings,
  DEFAULT_LMSTUDIO_ENDPOINT,
  DEFAULT_OPENROUTER_ENDPOINT,
  DEFAULT_OPENROUTER_MODEL,
} from '../store/AiSettingsContext';
import type { Provider } from '../services/llm';
import { api } from '../services/api';
import type { ClaudeStatus } from '../types/api';

interface Props {
  /** Called after a successful save. */
  onSaved?: () => void;
  /** Render a Cancel button (e.g. inside the settings modal). */
  onCancel?: () => void;
  saveLabel?: string;
}

const AiProviderForm: React.FC<Props> = ({ onSaved, onCancel, saveLabel = 'Save' }) => {
  const {
    provider,
    lmStudioEndpoint,
    openRouterEndpoint,
    openRouterApiKey,
    openRouterModel,
    claudeCliPath,
    claudeModel,
    aiReady,
    setProvider,
    setLmStudioEndpoint,
    setOpenRouterEndpoint,
    setOpenRouterApiKey,
    setOpenRouterModel,
    setClaudeCliPath,
    setClaudeModel,
    save,
  } = useAiSettings();

  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [checkingClaude, setCheckingClaude] = useState(false);

  // Asked of the CLI itself, so "installed" and "signed in" are never a guess.
  const checkClaude = useCallback(async (cliPath: string) => {
    setCheckingClaude(true);
    try {
      setClaude(await api.claudeStatus(cliPath));
    } catch (e) {
      setClaude({
        found: false, path: null, signedIn: false, email: null, org: null, plan: null,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setCheckingClaude(false);
    }
  }, []);

  // Checked when Claude Code is picked, not on every keystroke in the path field.
  useEffect(() => {
    if (provider === 'claude') void checkClaude(claudeCliPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, checkClaude]);

  const claudeOk = Boolean(claude?.found && claude.signedIn);
  const bannerOk = provider === 'claude' ? claudeOk : aiReady;

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await save();
      setFeedback('Saved');
      onSaved?.();
    } catch (e) {
      setFeedback(`Failed to save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div
        className={`flex items-center gap-2 text-sm mb-4 px-3 py-2 rounded-lg border ${
          bannerOk
            ? 'text-success border-success/40 bg-success/10'
            : 'text-warning border-warning/40 bg-warning/10'
        }`}
      >
        {provider === 'claude' && checkingClaude ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : bannerOk ? (
          <CheckCircle2 className="w-4 h-4" />
        ) : (
          <AlertCircle className="w-4 h-4" />
        )}
        <span>
          {provider === 'claude'
            ? checkingClaude
              ? 'Looking for Claude Code…'
              : claudeOk
                ? `Claude Code is signed in as ${claude?.email ?? 'an unnamed account'}${
                    claude?.plan ? ` (${claude.plan} plan)` : ''
                  }.`
                : claude?.error ?? 'Claude Code has not been checked yet.'
            : provider === 'lmstudio'
            ? aiReady
              ? 'LM Studio is set up — run a model locally and you’re ready.'
              : 'Enter your LM Studio endpoint to continue.'
            : aiReady
              ? 'OpenRouter API key is set.'
              : openRouterApiKey.trim()
                ? 'Enter an OpenRouter model ID to continue.'
                : 'Add your OpenRouter API key to continue.'}
        </span>
      </div>

      <div className="form-group">
        <label>Provider</label>
        <select
          className="form-input"
          value={provider}
          onChange={e => setProvider(e.target.value as Provider)}
        >
          <option value="lmstudio">LM Studio (local, free)</option>
          <option value="openrouter">OpenRouter (cloud, API key)</option>
          <option value="claude">Claude Code (your Claude subscription)</option>
        </select>
        <p className="text-xs text-muted-foreground mt-1">
          {provider === 'lmstudio'
            ? 'Runs models on your machine — nothing leaves your computer.'
            : provider === 'claude'
              ? 'Uses the Claude Code CLI you are signed in to — no API key. Claude sees table and column names, never row data.'
              : 'Hosted models via OpenRouter. Requires an API key.'}
        </p>
      </div>

      {provider === 'claude' ? (
        <>
          <div className="form-group">
            <label>Claude command</label>
            <div className="flex gap-2">
              <input
                type="text"
                className="form-input flex-1"
                value={claudeCliPath}
                onChange={e => setClaudeCliPath(e.target.value)}
                placeholder={claude?.path ?? 'Found automatically'}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void checkClaude(claudeCliPath)}
                disabled={checkingClaude}
                title="Check again"
              >
                <RefreshCw className={`w-4 h-4 ${checkingClaude ? 'animate-spin' : ''}`} />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Leave blank to find it on PATH or in the Claude desktop app. Set a full path only if it is somewhere else.
            </p>
          </div>
          <div className="form-group">
            <label>Model</label>
            <input
              type="text"
              className="form-input"
              value={claudeModel}
              onChange={e => setClaudeModel(e.target.value)}
              placeholder="CLI default"
            />
            <p className="text-xs text-muted-foreground mt-1">
              An alias such as haiku (fastest), sonnet or opus, or a full model ID. Blank uses Claude Code’s default.
            </p>
          </div>
        </>
      ) : provider === 'lmstudio' ? (
        <div className="form-group">
          <label>LM Studio Endpoint</label>
          <input
            type="text"
            className="form-input"
            value={lmStudioEndpoint}
            onChange={e => setLmStudioEndpoint(e.target.value)}
            placeholder={DEFAULT_LMSTUDIO_ENDPOINT}
          />
        </div>
      ) : (
        <>
          <div className="form-group">
            <label>OpenRouter Endpoint</label>
            <input
              type="text"
              className="form-input"
              value={openRouterEndpoint}
              onChange={e => setOpenRouterEndpoint(e.target.value)}
              placeholder={DEFAULT_OPENROUTER_ENDPOINT}
            />
          </div>
          <div className="form-group">
            <label>OpenRouter API Key</label>
            <input
              type="password"
              className="form-input"
              value={openRouterApiKey}
              onChange={e => setOpenRouterApiKey(e.target.value)}
              placeholder="sk-or-v1-..."
            />
            <p className="text-xs text-muted-foreground mt-1">
              Stored in your OS keychain, not localStorage.
            </p>
          </div>
          <div className="form-group">
            <label>OpenRouter Model</label>
            <input
              type="text"
              className="form-input"
              value={openRouterModel}
              onChange={e => setOpenRouterModel(e.target.value)}
              placeholder={DEFAULT_OPENROUTER_MODEL}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Any model ID from openrouter.ai/models, e.g. {DEFAULT_OPENROUTER_MODEL}.
            </p>
          </div>
        </>
      )}

      <div className="flex items-center gap-3 mt-2">
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : saveLabel}
        </button>
        {onCancel && (
          <button className="btn btn-secondary" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
        {feedback && <span className="text-xs text-muted-foreground">{feedback}</span>}
      </div>
    </div>
  );
};

export default AiProviderForm;
