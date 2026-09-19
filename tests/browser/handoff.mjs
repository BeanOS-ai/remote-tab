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
    ${JSON.stringify("Review your name and email, then choose Done in the Remote Tab popup.")},
    Date.now() + 60000)`);
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
  await assert.rejects(button("Done"), /Missing real handoff button/);
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
    await onButton("Collapse", "function(){return getComputedStyle(this).animationName}"),
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
  // Recheck a still-focused field after genuine viewport and document/container
  // scroll events. Focus does not change during any of these movements.
  const reset = async () => {
    await evaluate("handoffTestController.clear()");
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.activeElement?.blur();
    });
    await evaluate(`globalThis.handoffTestController = (${mountHandoff.toString()})(
      "Review the focused field", Date.now() + 60000)`);
  };
  const assertClearOfField = async (selector) => {
    const field = await page.locator(selector).boundingBox();
    const ui = await host.boundingBox();
    assert.ok(field && ui);
    assert.ok(
      ui.y + ui.height <= field.y ||
        ui.y >= field.y + field.height ||
        ui.x + ui.width <= field.x ||
        ui.x >= field.x + field.width,
      `Reminder covers focused field: ${JSON.stringify({ field, ui })}`,
    );
  };
  await reset();
  await page.locator("#name").evaluate((input) => {
    input.style.cssText = "position:fixed;top:490px;left:100px;height:40px;margin:0";
    input.focus();
  });
  await page.setViewportSize({ width: 1100, height: 570 });
  await page.waitForFunction(
    () => document.querySelector("#remote-tab-handoff").getBoundingClientRect().y < 100,
  );
  await assertClearOfField("#name");
  await reset();
  await page.locator("#name").evaluate((input) => {
    input.style.cssText = "position:absolute;top:1100px;left:100px;height:40px;margin:0";
    document.body.style.height = "2000px";
    input.focus({ preventScroll: true });
    window.scrollTo(0, 370);
  });
  await page.waitForFunction(
    () => document.querySelector("#remote-tab-handoff").getBoundingClientRect().y < 100,
  );
  await assertClearOfField("#name");
  await reset();
  await page.evaluate(() => {
    const scroller = document.createElement("div");
    scroller.style.cssText = "position:fixed;top:0;left:0;width:600px;height:800px;overflow:auto";
    scroller.innerHTML =
      '<div style="height:2000px;padding-top:1100px"><input id="scroll-field" style="height:40px;margin:0"></div>';
    document.body.append(scroller);
    document.querySelector("#scroll-field").focus({ preventScroll: true });
    scroller.scrollTop = 370;
  });
  await page.waitForFunction(
    () => document.querySelector("#remote-tab-handoff").getBoundingClientRect().y < 100,
  );
  await assertClearOfField("#scroll-field");
  await page
    .locator("#scroll-field")
    .evaluate((input) => input.parentElement.parentElement.remove());

  // A hostile page controls the public host, including in the top layer. Attack
  // the real internal control with trusted clicks while the human sees an
  // unrelated Play video button. There is deliberately no Done capability here.
  for (const attack of ["transparent", "hidden", "moved", "resized", "covered"]) {
    await reset();
    await page.evaluate((attack) => {
      const host = document.querySelector("#remote-tab-handoff");
      const restyle = () => {
        host.style.cssText = `position:fixed!important;left:0!important;top:0!important;
          bottom:auto!important;right:auto!important;width:1000px!important;margin:0!important;
          ${attack === "transparent" ? "opacity:0!important" : ""};
          ${attack === "hidden" ? "visibility:hidden!important" : ""};
          ${attack === "resized" ? "transform:scale(.5)!important;transform-origin:top left!important" : ""}`;
      };
      restyle();
      window.attackTimer = setInterval(restyle, 10);
    }, attack);
    const point = await onButton(
      "Collapse",
      "function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}",
    );
    await page.evaluate(
      ({ point, attack }) => {
        const decoy = document.createElement("button");
        decoy.id = "play-video";
        decoy.textContent = "Play video";
        decoy.style.cssText = `position:fixed;left:${point.x - 60}px;top:${point.y - 20}px;width:120px;height:40px;margin:0;z-index:2147483647`;
        document.body.append(decoy);
        if (attack === "covered") {
          decoy.setAttribute("popover", "manual");
          decoy.showPopover();
        }
      },
      { point, attack },
    );
    await page.mouse.click(point.x, point.y);
    await page.keyboard.press("Enter");
    await page.evaluate(() => {
      clearInterval(window.attackTimer);
      document.querySelector("#play-video").remove();
    });
    await evaluate("Promise.resolve()");
    assert.equal(calls.length, 0, `${attack} host plus trusted input must not acknowledge Done`);
  }
  await evaluate("handoffTestController.clear()");
  await host.waitFor({ state: "detached" });
  await shot("cleared");
  await evaluate(`globalThis.handoffTestController = (${mountHandoff.toString()})(
    "Expired request", Date.now() - 1)`);
  await host.waitFor({ state: "detached" });
  assert.equal(calls.length, 0);
  console.log(
    `PASS: Chromium ${browser.version()}; informational isolated handoff, host clickjacking, keyboard collapse, focus/scroll/resize avoidance, clear/expiry; screenshots ${artifacts}`,
  );
} finally {
  await browser.close();
}
