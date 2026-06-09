import { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'system';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

const systemPrefersDark = () =>
  window.matchMedia('(prefers-color-scheme: dark)').matches;

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'intelquery-theme',
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme | null) ?? defaultTheme
  );

  // Apply the resolved theme to the document root, and keep it in sync with the
  // OS preference while in "system" mode.
  useEffect(() => {
    const root = window.document.documentElement;

    const apply = () => {
      const resolved = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
      root.classList.toggle('dark', resolved === 'dark');
    };

    apply();

    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const value: ThemeProviderState = {
    theme,
    setTheme: (next: Theme) => {
      localStorage.setItem(storageKey, next);
      setThemeState(next);
    },
  };

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
