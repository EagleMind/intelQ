import React, { useState } from 'react';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import {
  useAiSettings,
  DEFAULT_LMSTUDIO_ENDPOINT,
  DEFAULT_OPENROUTER_ENDPOINT,
} from '../store/AiSettingsContext';
import type { Provider } from '../services/llm';

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
    aiReady,
    setProvider,
    setLmStudioEndpoint,
    setOpenRouterEndpoint,
    setOpenRouterApiKey,
    save,
  } = useAiSettings();

  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

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
          aiReady
            ? 'text-success border-success/40 bg-success/10'
            : 'text-warning border-warning/40 bg-warning/10'
        }`}
      >
        {aiReady ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
        <span>
          {provider === 'lmstudio'
            ? aiReady
              ? 'LM Studio is set up — run a model locally and you’re ready.'
              : 'Enter your LM Studio endpoint to continue.'
            : aiReady
              ? 'OpenRouter API key is set.'
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
        </select>
        <p className="text-xs text-muted-foreground mt-1">
          {provider === 'lmstudio'
            ? 'Runs models on your machine — nothing leaves your computer.'
            : 'Hosted models via OpenRouter. Requires an API key.'}
        </p>
      </div>

      {provider === 'lmstudio' ? (
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
