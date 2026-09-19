// Real Chromium coverage of the production handoff UI and isolated-world boundary.
// No relay, external fixture, credentials, or package downloads are required.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mountHandoff } from "../../packages/extension/src/handoff-overlay.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const artifacts = process.env.HANDOFF_SCREENSHOTS || "/tmp/remote-tab-handoff-screenshots";
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.setContent(`<!doctype html><html lang="en"><title>Remote Tab handoff fixture</title>
    <style>body{font:18px/1.5 system-ui;background:#f2f5f2;color:#173326;margin:60px}
    main{max-width:700px;padding:35px;background:white;border-radius:20px}
    label,input{display:block}input{font:inherit;padding:10px;margin:8px 0 25px;width:320px}
    button{font:inherit;padding:10px 20px}</style>
    <main><h1>Review your request</h1><p>This is a disposable browser test form.</p>
    <label>Name<input id="name" value="Ada"></label>
    <label>Email<input id="email" value="ada@example.test"></label>
    <button>Submit request</button></main></html>`);
  const shot = (name) => page.screenshot({ path: join(artifacts, `${name}.png`) });
  await shot("before");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Runtime.enable");
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "remote-tab-handoff-browser-test",
  });
  const binding = "remoteTabHandoffTestDone";
  const token = "disposable-browser-test-request";
  const calls = [];
  cdp.on("Runtime.bindingCalled", (event) => calls.push(event));
  await cdp.send("Runtime.addBinding", { name: binding, executionContextId });
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: true,
    });
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await evaluate(`globalThis.handoffTestController = (${mountHandoff.toString()})(
    ${JSON.stringify("Review your name and email, then choose Done to let the agent continue.")},
    ${JSON.stringify(binding)}, ${JSON.stringify(token)}, Date.now() + 60000)`);
  const host = page.locator("#remote-tab-handoff");
  await host.waitFor({ state: "visible" });
  await shot("pending");
  // Closed shadow roots must stay inaccessible to page scripts. Neither page-world
  // function names nor forged DOM/keyboard/messages may acknowledge the handoff.
  assert.deepEqual(
    await page.evaluate((name) => {
      const element = document.querySelector("#remote-tab-handoff");
      const result = { shadowRoot: element.shadowRoot, bindingType: typeof globalThis[name] };
      element.click();
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      window.postMessage(
        { type: "remote-tab-handoff-done", token: "disposable-browser-test-request" },
        "*",
      );
      return result;
    }, binding),
    { shadowRoot: null, bindingType: "undefined" },
  );

  // CDP sees the closed shadow tree, allowing test-only access to the exact button
  // without adding a production DOM hook or exposing the request capability.
  await cdp.send("DOM.enable");
  const buttonNodes = async () => {
    const { nodes } = await cdp.send("DOM.getFlattenedDocument", { depth: -1, pierce: true });
    return nodes.filter(
      (node) => node.nodeName === "BUTTON" && node.attributes?.includes("button"),
    );
  };
  const button = async (label) => {
    for (const node of await buttonNodes()) {
      const { object } = await cdp.send("DOM.resolveNode", {
        nodeId: node.nodeId,
        executionContextId,
      });
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function(){return this.textContent}",
        returnByValue: true,
      });
      if (result.value === label) return object.objectId;
    }
    throw new Error(`Missing real handoff button: ${label}`);
  };
  const onButton = async (label, functionDeclaration) => {
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId: await button(label),
      functionDeclaration,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  };
  const click = async (label) => {
    await evaluate("handoffTestController.refresh()");
    const rect = await onButton(
      label,
      "function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}",
    );
    await page.mouse.click(rect.x, rect.y);
  };
  await onButton(
    "Done",
    `function(){
    this.click();
    this.dispatchEvent(new MouseEvent("click", {bubbles:true,composed:true}));
    this.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter",bubbles:true}));
  }`,
  );
  assert.equal(calls.length, 0, "Synthetic events must never acknowledge a human request");
  await click("Collapse");
  await shot("collapsed");
  assert.equal(calls.length, 0, "Collapse must not acknowledge the request");
  await click("Remote Tab · Your turn");
  await page.evaluate(() => document.querySelector("#remote-tab-handoff").remove());
  await host.waitFor({ state: "visible" });
  await page.evaluate(() => {
    document.querySelector("#remote-tab-handoff").style.cssText = "display:none!important";
  });
  await host.waitFor({ state: "visible" });
  assert.equal(calls.length, 0, "Removing or hiding the UI must not acknowledge the request");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await onButton("Done", "function(){return getComputedStyle(this).animationName}"),
    "none",
  );
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "overlapping-field";
    input.setAttribute("aria-label", "Low form field");
    input.style.cssText = "position:fixed;bottom:25px;left:100px;width:320px";
    document.body.append(input);
    input.focus();
  });
  assert.ok((await host.boundingBox()).y < 100, "UI must move away from the focused bottom field");
  await page.locator("#overlapping-field").fill("Still editable");
  assert.equal(await page.locator("#overlapping-field").inputValue(), "Still editable");
  await shot("focused-field");
  await page.locator("#overlapping-field").evaluate((input) => input.remove());
  await onButton("Remote Tab · Your turn", "function(){this.focus()}");
  await page.keyboard.press("Enter");
  await onButton("Collapse", "function(){this.focus()}");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  assert.equal(calls.length, 0, "Keyboard collapse/expand must not acknowledge the request");
  await page.locator("#name").fill("Ada Lovelace");
  assert.equal(await page.locator("#name").inputValue(), "Ada Lovelace");
  assert.equal(calls.length, 0, "Editing the underlying form must not acknowledge the request");
  await click("Done");
  await page.waitForFunction(() => document.querySelector("#remote-tab-handoff") !== null);
  assert.deepEqual(
    calls.map(({ name, payload, executionContextId: context }) => ({ name, payload, context })),
    [{ name: binding, payload: token, context: executionContextId }],
  );
  await evaluate("handoffTestController.clear()");
  await host.waitFor({ state: "detached" });
  await shot("cleared");
  await evaluate(`globalThis.handoffTestController = (${mountHandoff.toString()})(
    "Keyboard completion", ${JSON.stringify(binding)}, "keyboard-request", Date.now() + 60000)`);
  await onButton("Done", "function(){this.focus()}");
  await page.keyboard.press("Enter");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload, "keyboard-request");
  await evaluate("handoffTestController.clear()");
  await evaluate(`globalThis.handoffTestController = (${mountHandoff.toString()})(
    "Expired request", ${JSON.stringify(binding)}, "expired-request", Date.now() - 1)`);
  await click("Done");
  assert.equal(calls.length, 2, "Expired request must reject even a trusted click");
  await host.waitFor({ state: "detached" });
  console.log(
    `PASS: Chromium ${browser.version()}; isolated-world handoff, forgery rejection, trusted mouse/keyboard Done, collapse, reduced motion, DOM tampering, focused field, clear/expiry; screenshots ${artifacts}`,
  );
} finally {
  await browser.close();
}
