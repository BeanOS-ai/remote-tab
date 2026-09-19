// Narrow installed-browser API surface; no runtime polyfill or external assets.
export interface Tab {
  id?: number;
  url?: string;
  title?: string;
  windowId?: number;
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
    update(id: number, options: { active: boolean }): Promise<Tab>;
    create(options: { url: string }): Promise<Tab>;
    onRemoved: Event<(id: number) => void>;
  };
  windows: { update(id: number, options: { focused: boolean }): Promise<unknown> };
  action: {
    setBadgeText(options: { text: string }): Promise<void>;
    setBadgeBackgroundColor(options: { color: string }): Promise<void>;
    setTitle(options: { title: string }): Promise<void>;
  };
  notifications: {
    create(
      id: string,
      options: {
        type: "basic";
        iconUrl: string;
        title: string;
        message: string;
        requireInteraction: boolean;
      },
    ): Promise<string>;
    clear(id: string): Promise<boolean>;
    onClicked: Event<(id: string) => void>;
  };
  debugger: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(
      target: { tabId: number; sessionId?: string },
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown>;
    onEvent: Event<
      (
        target: { tabId?: number; sessionId?: string },
        method: string,
        params?: Record<string, unknown>,
      ) => void
    >;
    onDetach: Event<(target: { tabId?: number; sessionId?: string }, reason: string) => void>;
  };
}
declare global {
  const chrome: ChromeApi;
  const REMOTE_TAB_SERVER_ORIGIN: string;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
