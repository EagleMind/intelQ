import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api } from '../services/api';
import { sync } from '../services/sync';
import type { LlmConfig, Provider } from '../services/llm';

export const DEFAULT_LMSTUDIO_ENDPOINT = 'http://localhost:1234/api/v1/chat';
export const DEFAULT_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEYRING_ACCOUNT = 'openrouter_api_key';

interface AiSettingsValue {
  provider: Provider;
  lmStudioEndpoint: string;
  openRouterEndpoint: string;
  openRouterApiKey: string;
  /** True once settings have been loaded from the local store / keychain. */
  loaded: boolean;
  /**
   * Whether the user had already configured an AI provider *when the app
   * loaded* (a stable boot-time snapshot — it does not flip when the user
   * edits settings mid-session). Used to skip onboarding for returning users.
   */
  configuredAtStart: boolean;
  /** Whether the current provider has everything it needs to generate SQL. */
  aiReady: boolean;
  /** Convenience bundle for `generateSql`. */
  config: LlmConfig;
  setProvider: (p: Provider) => void;
  setLmStudioEndpoint: (s: string) => void;
  setOpenRouterEndpoint: (s: string) => void;
  setOpenRouterApiKey: (s: string) => void;
  /** Persist settings to the local store and the API key to the OS keychain. */
  save: () => Promise<void>;
}

const Ctx = createContext<AiSettingsValue | null>(null);

export const AiSettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [provider, setProvider] = useState<Provider>('lmstudio');
  const [lmStudioEndpoint, setLmStudioEndpoint] = useState(DEFAULT_LMSTUDIO_ENDPOINT);
  const [openRouterEndpoint, setOpenRouterEndpoint] = useState(DEFAULT_OPENROUTER_ENDPOINT);
  const [openRouterApiKey, setOpenRouterApiKey] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [configuredAtStart, setConfiguredAtStart] = useState(false);

  // Load settings on mount from the local SQLite store, migrating any legacy
  // localStorage values (and the legacy API key into the OS keychain).
  useEffect(() => {
    (async () => {
      const settings = await sync.getSettings().catch(() => ({} as Record<string, string>));

      const migrateKey = async (key: string) => {
        const ls = localStorage.getItem(key);
        if (ls !== null && settings[key] === undefined) {
          try {
            await sync.setSetting(key, ls);
            settings[key] = ls;
          } catch (e) {
            console.warn('Failed to migrate setting', key, e);
          }
          localStorage.removeItem(key);
        }
      };
      await migrateKey('provider');
      await migrateKey('lmStudioEndpoint');
      await migrateKey('openRouterEndpoint');

      setProvider((settings['provider'] as Provider | undefined) ?? 'lmstudio');
      setLmStudioEndpoint(settings['lmStudioEndpoint'] ?? DEFAULT_LMSTUDIO_ENDPOINT);
      setOpenRouterEndpoint(settings['openRouterEndpoint'] ?? DEFAULT_OPENROUTER_ENDPOINT);

      const legacy = localStorage.getItem('openRouterApiKey');
      if (legacy) {
        try {
          await api.credentialSet(OPENROUTER_KEYRING_ACCOUNT, legacy);
        } catch (e) {
          console.warn('Failed to migrate API key into keyring:', e);
        }
        localStorage.removeItem('openRouterApiKey');
      }
      let loadedKey = '';
      try {
        loadedKey = (await api.credentialGet(OPENROUTER_KEYRING_ACCOUNT)) ?? '';
        setOpenRouterApiKey(loadedKey);
      } catch (e) {
        console.warn('Failed to load API key:', e);
      }

      // Treat the provider as already configured if the user explicitly saved
      // before (the flag, or a persisted provider/endpoint setting) or already
      // has an API key. A brand-new install has none of these, so it still sees
      // the guide. This is a one-shot boot snapshot, not reactive to edits.
      setConfiguredAtStart(
        settings['ai_configured'] === 'true' ||
          settings['provider'] !== undefined ||
          loadedKey.trim().length > 0
      );

      setLoaded(true);
    })();
  }, []);

  const save = async () => {
    await sync.setSetting('provider', provider);
    await sync.setSetting('lmStudioEndpoint', lmStudioEndpoint);
    await sync.setSetting('openRouterEndpoint', openRouterEndpoint);
    await sync.setSetting('ai_configured', 'true');
    if (openRouterApiKey.trim()) {
      await api.credentialSet(OPENROUTER_KEYRING_ACCOUNT, openRouterApiKey);
    } else {
      await api.credentialDelete(OPENROUTER_KEYRING_ACCOUNT);
    }
  };

  const aiReady =
    provider === 'lmstudio'
      ? lmStudioEndpoint.trim().length > 0
      : openRouterApiKey.trim().length > 0;

  const value = useMemo<AiSettingsValue>(
    () => ({
      provider,
      lmStudioEndpoint,
      openRouterEndpoint,
      openRouterApiKey,
      loaded,
      configuredAtStart,
      aiReady,
      config: { provider, lmStudioEndpoint, openRouterEndpoint, openRouterApiKey },
      setProvider,
      setLmStudioEndpoint,
      setOpenRouterEndpoint,
      setOpenRouterApiKey,
      save,
    }),
    [
      provider,
      lmStudioEndpoint,
      openRouterEndpoint,
      openRouterApiKey,
      loaded,
      configuredAtStart,
      aiReady,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useAiSettings = (): AiSettingsValue => {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAiSettings must be used inside <AiSettingsProvider>');
  return ctx;
};
