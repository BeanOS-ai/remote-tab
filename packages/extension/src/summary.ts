// Fixed plain-language summaries deliberately omit typed text, code and page content.
const summaries: Record<string, string> = {
  browser_snapshot: "Read the page",
  browser_take_screenshot: "Captured a screenshot",
  browser_console_messages: "Read console messages",
  browser_network_requests: "Read network activity",
  browser_click: "Clicked an element",
  browser_type: "Typed into a field",
  browser_press_key: "Pressed a key",
  browser_hover: "Moved over an element",
  browser_select_option: "Selected an option",
  browser_drag: "Dragged an element",
  browser_navigate: "Navigated to a page",
  browser_navigate_back: "Went back",
  browser_wait_for: "Waited for the page",
  browser_evaluate: "Ran a page script",
};
export function actionSummary(tool: string): string {
  return summaries[tool] ?? "Requested an action";
}
