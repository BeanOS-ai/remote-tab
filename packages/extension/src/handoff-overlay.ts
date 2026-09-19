/** Serialized into a fresh CDP isolated world. No page-world globals or messaging.
 * Keep this function self-contained: it runs with clean DOM intrinsics and
 * no acknowledgement capability. The shared DOM is never a consent boundary. */
export function mountHandoff(message: string, expiresAt: number) {
  const host = document.createElement("div");
  host.id = "remote-tab-handoff";
  host.setAttribute("popover", "manual");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { color-scheme: light; }
    * { box-sizing: border-box; }
    .bar { font: 15px/1.45 system-ui,sans-serif; color: #fff; background: #172b29;
      border: 2px solid #a6edb5; border-radius: 16px; padding: 16px 20px;
      box-shadow: 0 6px 30px #0005; display: flex; align-items: center; gap: 18px; }
    .identity { min-width: 145px; } strong { display: block; font-size: 16px; }
    .brand { color: #a6edb5; font-size: 12px; font-weight: 750; letter-spacing: .09em; }
    .message { flex: 1; max-height: 20vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
    button { font: 650 14px/1.3 system-ui,sans-serif; border: 1px solid #9db6ad;
      border-radius: 9px; padding: 10px 15px; background: #243e39; color: #fff;
      cursor: pointer; flex-shrink: 0; }
    button:focus-visible, .message:focus-visible { outline: 3px solid #ffdc80; outline-offset: 3px; }
    .instruction { font-size: 13px; color: #a6edb5; margin-top: 6px; }
    .compact { padding: 10px 14px; border: 2px solid #a6edb5; background: #172b29;
      box-shadow: 0 4px 20px #0005; border-radius: 24px; }
    [hidden] { display: none !important; }
    @media (max-width: 650px) { .bar { flex-wrap: wrap; gap: 10px; padding: 12px; }
      .identity { min-width: 0; } .message { flex-basis: 100%; order: 2; } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
  `;
  const bar = document.createElement("section");
  bar.className = "bar";
  bar.setAttribute("role", "region");
  bar.setAttribute("aria-label", "Remote Tab — your turn");
  const identity = document.createElement("div");
  identity.className = "identity";
  const brand = document.createElement("span");
  brand.className = "brand";
  brand.textContent = "REMOTE TAB";
  const heading = document.createElement("strong");
  heading.textContent = "Your turn";
  identity.append(brand, heading);
  const text = document.createElement("div");
  text.className = "message";
  text.textContent = message;
  text.tabIndex = 0;
  text.setAttribute("role", "status");
  const instruction = document.createElement("div");
  instruction.className = "instruction";
  instruction.textContent =
    "When finished, open Remote Tab in the browser toolbar and choose Done.";
  const request = document.createElement("div");
  request.className = "message";
  request.append(text, instruction);
  const collapse = document.createElement("button");
  collapse.textContent = "Collapse";
  collapse.type = "button";
  collapse.setAttribute("aria-label", "Collapse Remote Tab request");
  const compact = document.createElement("button");
  compact.className = "compact";
  compact.textContent = "Remote Tab · Your turn";
  compact.type = "button";
  compact.hidden = true;
  compact.setAttribute("aria-label", "Expand Remote Tab request — your turn");
  bar.append(identity, request, collapse);
  root.append(style, bar, compact);
  let collapsed = false;
  let top = false;
  let alive = true;
  let lease = Date.now() + 5000;
  let expiry = expiresAt;
  function position() {
    host.style.cssText = `all:initial!important;position:fixed!important;inset:auto!important;
      ${top ? "top" : "bottom"}:12px!important;right:12px!important;
      left:${collapsed ? "auto" : "12px"}!important;width:${collapsed ? "max-content" : "auto"}!important;
      max-width:calc(100vw - 24px)!important;height:auto!important;margin:0!important;
      padding:0!important;border:0!important;background:transparent!important;
      opacity:1!important;visibility:visible!important;display:block!important;
      z-index:2147483647!important;transform:none!important;pointer-events:auto!important;`;
  }
  function setCollapsed(value: boolean) {
    collapsed = value;
    bar.hidden = value;
    compact.hidden = !value;
    position();
  }
  // The page can hide, move, or cover the host despite its closed shadow root.
  // These controls only change presentation; Done lives in the extension popup.
  collapse.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    setCollapsed(true);
    compact.focus();
  });
  compact.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    setCollapsed(false);
    collapse.focus();
  });
  function avoidField(element: EventTarget | null = document.activeElement) {
    if (
      !(element instanceof Element) ||
      element === host ||
      !element.matches("input,textarea,select,[contenteditable]")
    )
      return;
    const field = element.getBoundingClientRect();
    const ui = host.getBoundingClientRect();
    if (
      field.bottom > ui.top &&
      field.top < ui.bottom &&
      field.right > ui.left &&
      field.left < ui.right
    ) {
      setCollapsed(true);
      top = field.top + field.height / 2 > innerHeight / 2;
      position();
    }
  }
  const onFocus = (event: Event) => avoidField(event.target);
  const onViewport = () => avoidField();
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("scroll", onViewport, true);
  window.addEventListener("resize", onViewport);
  function restore() {
    if (!alive) return;
    if (!host.isConnected) document.documentElement.append(host);
    position();
    if (!host.matches(":popover-open")) host.showPopover();
    avoidField();
  }
  restore();
  avoidField();
  // The page can remove its DOM, but cannot turn removal into consent. Restore
  // accidental/removal tampering; badge + notification also live outside it.
  const observer = new MutationObserver(() => {
    if (!host.isConnected) restore();
  });
  observer.observe(document.documentElement, { childList: true });
  function clear() {
    alive = false;
    clearInterval(timer);
    observer.disconnect();
    document.removeEventListener("focusin", onFocus, true);
    document.removeEventListener("scroll", onViewport, true);
    window.removeEventListener("resize", onViewport);
    host.remove();
  }
  const timer = setInterval(() => {
    if (Date.now() >= Math.min(lease, expiry)) clear();
    else restore();
  }, 1000);
  return {
    clear,
    refresh(deadline?: number) {
      if (deadline !== undefined && Number.isFinite(deadline)) expiry = deadline;
      lease = Date.now() + 5000;
    },
  };
}
