// Narrow installed-browser API surface; no runtime polyfill or external assets.
export interface Tab {
  id?: number;
  url?: string;
  title?: string;
}
export interface Sender {
  id?: string;
  url?: string;
  tab?: Tab;
}
interface Event<T extends (...args: never[]) => unknown> {
  addListener(listener: T): void;
}
export interface ChromeApi {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: Event<
      (message: unknown, sender: Sender, respond: (value: unknown) => void) => boolean | undefined
    >;
  };
  tabs: {
    query(query: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
    get(id: number): Promise<Tab>;
    create(options: { url: string }): Promise<Tab>;
    onRemoved: Event<(id: number) => void>;
  };
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(
      target: { tabId: number },
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown>;
    onEvent: Event<
      (target: { tabId?: number }, method: string, params?: Record<string, unknown>) => void
    >;
    onDetach: Event<(target: { tabId?: number }, reason: string) => void>;
  };
}
declare global {
  const chrome: ChromeApi;
  const REMOTE_TAB_SERVER_ORIGIN: string;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
