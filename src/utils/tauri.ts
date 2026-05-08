// Safe invoke function that uses global window.__TAURI__.core.invoke for Tauri 2.x
export const safeInvoke = async <T = any>(
  command: string,
  args?: Record<string, any>
): Promise<T> => {
  if (typeof window === 'undefined' || !window.__TAURI__?.core?.invoke) {
    throw new Error('Tauri API not available. Please run in Tauri desktop environment.');
  }
  
  return await (window as any).__TAURI__.core.invoke(command, args);
};
