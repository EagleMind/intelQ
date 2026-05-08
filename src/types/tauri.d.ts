declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke: <T = any>(command: string, args?: Record<string, any>) => Promise<T>;
      };
    };
  }
}

export {};
