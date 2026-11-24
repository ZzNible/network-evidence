// Dependency-free, source-agnostic Chromium CDP QA for the local NE Maps UI.
// Tests the *actual emulated viewport*, not the requested CLI screenshot size.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = new URL(process.env.NE_MAPS_BASE_URL || "http://127.0.0.1:4177/");
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") {
  throw new Error("Only the loopback NE Maps server is allowed");
}
const binary = process.env.NE_MAPS_BROWSER || "chromium";
const screenshots = process.env.NE_MAPS_SCREENSHOT_DIR || "";
const profile = await mkdtemp(join(tmpdir(), "ne-maps-cdp-"));
const child = spawn(binary, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let browserLog = "";
child.stderr.on("data", bytes => { browserLog = (browserLog + bytes.toString()).slice(-2500); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;

try {
  let port;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Chromium exited: " + browserLog);
    try {
      port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
    } catch { /* CDP startup in progress */ }
    if (port) break;
    await sleep(100);
  }
  if (!port) throw new Error("Chromium CDP endpoint missing: " + browserLog);
  const response = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" });
  if (!response.ok) throw new Error("Chromium local CDP tab creation failed: HTTP " + response.status);
  const target = await response.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP WebSocket connection timed out")), 7000);
    socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP WebSocket failed")); }, { once: true });
  });

  const waiting = new Map();
  let nextId = 0;
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const item = waiting.get(message.id);
    if (!item) return;
    waiting.delete(message.id);
    clearTimeout(item.timeout);
    if (message.error) item.reject(new Error(item.method + ": " + message.error.message));
    else item.resolve(message.result || {});
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(method + " timed out")); }, 20000);
    waiting.set(id, { resolve, reject, timeout, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async fn => {
    const result = await command("Runtime.evaluate", {
      expression: "(" + fn.toString() + ")()", returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error("Browser JS error: " + result.exceptionDetails.text);
    return result.result?.value;
  };
  await command("Page.enable");
  await command("Runtime.enable");

  const scenarios = [
    ["empty-320", "#/", 320, "No application cases loaded", 0, 0],
    ["examples-320", "#/examples", 320, "Synthetic Core golden", 0, 0],
    ["genesis-lens-320", "#/case/zksys-genesis-20261118/lens", 320, "Declared evidence relations", 1, 0],
    ["genesis-lens-390", "#/case/zksys-genesis-20261118/lens", 390, "Declared evidence relations", 1, 0],
    ["genesis-lens-1440", "#/case/zksys-genesis-20261118/lens", 1440, "Declared evidence relations", 1, 0],
    ["genesis-trail-320", "#/case/zksys-genesis-20261118/trail", 320, "guided reading order", 0, 1],
    ["genesis-trail-390", "#/case/zksys-genesis-20261118/trail", 390, "guided reading order", 0, 1],
    ["genesis-trail-1440", "#/case/zksys-genesis-20261118/trail", 1440, "guided reading order", 0, 1],
    ["f2-lens-320", "#/case/f2/lens", 320, "Propositions and evidence bases", 0, 0],
    ["f2-trail-320", "#/case/f2/trail", 320, "guided reading order", 0, 1],
  ];
  const reports = [];
  for (const [id, hash, width, expectedText, minRelations, minSteps] of scenarios) {
    await command("Emulation.setDeviceMetricsOverride", {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 500,
    });
    const url = new URL(base);
    url.hash = hash;
    await command("Page.navigate", { url: url.toString() });

    let ready = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const state = await evaluate(() => ({
        ready: document.readyState === "complete" && !!document.querySelector("#app") &&
          !document.querySelector("#app .loading"),
        text: document.querySelector("#app")?.textContent || "",
      }));
      if (state?.ready && state.text.includes(expectedText)) { ready = true; break; }
      if (state?.ready && state.text.startsWith("NE Maps could not load")) {
        throw new Error(id + ": case collection failed: " + state.text.slice(0, 170));
      }
      await sleep(100);
    }
    if (!ready) throw new Error(id + ": expected rendered text missing after page load");

    const metrics = await evaluate(() => {
      const w = innerWidth;
      const d = document.documentElement;
      const b = document.body;
      const overflow = [...document.querySelectorAll(
        ".app-shell,.detail-panel,.relation-edge,.trail-step,.case-card,.detail-head,.detail-grid,.library-tabs"
      )].map(el => ({ name: el.className, r: el.getBoundingClientRect() }))
        .filter(el => el.r.width > 0 && (el.r.left < -2 || el.r.right > w + 2))
        .slice(0, 8).map(el => ({
          name: el.name, left: Math.round(el.r.left), right: Math.round(el.r.right),
        }));
      return {
        viewportWidth: w, documentWidth: d.scrollWidth, bodyWidth: b.scrollWidth,
        pageHeight: Math.max(d.scrollHeight, b.scrollHeight),
        relations: document.querySelectorAll(".relation-edge").length,
        steps: document.querySelectorAll(".trail-step").length,
        overflow,
      };
    });
    if (metrics.viewportWidth !== width || metrics.documentWidth > width + 2 ||
        metrics.bodyWidth > width + 2 || metrics.overflow.length > 0) {
      throw new Error(id + ": horizontal overflow or viewport mismatch: " + JSON.stringify(metrics));
    }
    if (metrics.relations < minRelations || metrics.steps < minSteps) {
      throw new Error(id + ": case detail missing: " + JSON.stringify(metrics));
    }
    await evaluate(() => window.scrollTo(0,
      Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)));
    await sleep(70);
    const bottom = await evaluate(() => {
      const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const f = document.querySelector("footer")?.getBoundingClientRect();
      return {
        scrollY, reachedBottom: scrollY + innerHeight >= h - 4,
        footerVisible: !!f && f.top < innerHeight && f.bottom > 0,
      };
    });
    if (!bottom.reachedBottom || !bottom.footerVisible ||
        (metrics.pageHeight > 920 && bottom.scrollY < 10)) {
      throw new Error(id + ": bottom not reachable: " + JSON.stringify({ metrics, bottom }));
    }
    if (screenshots && (id === "genesis-lens-320" || id === "genesis-trail-320")) {
      await mkdir(screenshots, { recursive: true });
      await evaluate(() => window.scrollTo(0, 0));
      await sleep(35);
      const png = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      if (!png.data) throw new Error(id + ": no full-page screenshot");
      await writeFile(join(screenshots, "full-" + id + ".png"), Buffer.from(png.data, "base64"));
    }
    reports.push({ id, hash, ...metrics, ...bottom });
    console.log("VIEWPORT_PASS " + id + " width=" + width +
      " pageHeight=" + metrics.pageHeight + " scrollBottom=" + bottom.scrollY);
  }

  // Real CDP keyboard events, with focus and navigation observed in the browser.
  // This catches route changes that accidentally discard the keyboard focus.
  const pressKey = async key => {
    const vk = key === "Tab" ? 9 : 13;
    const params = { key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await command("Input.dispatchKeyEvent", { type: "keyDown", ...params });
    await command("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  };
  const focusInfo = () => evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? "",
      id: el?.id ?? "",
      className: typeof el?.className === "string" ? el.className : "",
      href: el?.getAttribute("href") ?? null,
      focusVisible: !!el?.matches?.(":focus-visible"),
      hash: location.hash,
      content: (document.querySelector("#app")?.textContent ?? "").slice(0, 1700),
    };
  });
  await command("Emulation.setDeviceMetricsOverride", {
    width: 320, height: 900, deviceScaleFactor: 1, mobile: true,
  });
  await command("Page.navigate", { url: new URL("#/", base).toString() });
  let entryReady = false;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const state = await focusInfo();
    if (state.content.includes("No application cases loaded")) { entryReady = true; break; }
    await sleep(80);
  }
  if (!entryReady) throw new Error("KEYBOARD: empty application workspace did not render");
  await pressKey("Tab");
  const firstTab = await focusInfo();
  if (firstTab.href !== "#/mine" || !firstTab.focusVisible) {
    throw new Error("KEYBOARD: first tab should focus visible My cases link: " + JSON.stringify(firstTab));
  }
  await pressKey("Tab");
  const secondTab = await focusInfo();
  if (secondTab.href !== "#/examples" || !secondTab.focusVisible) {
    throw new Error("KEYBOARD: second tab should focus visible Examples link: " + JSON.stringify(secondTab));
  }
  await pressKey("Enter");
  let examplesOpened = false;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const state = await focusInfo();
    if (state.hash === "#/examples" && state.content.includes("Synthetic Core golden")) {
      examplesOpened = true;
      break;
    }
    await sleep(70);
  }
  if (!examplesOpened) throw new Error("KEYBOARD: Enter did not activate Examples and render the cases");
  const afterNavigation = await focusInfo();
  if (afterNavigation.id !== "app") {
    throw new Error("KEYBOARD: view replacement lost focus (expected main #app): " +
      JSON.stringify(afterNavigation));
  }
  await pressKey("Tab");
  const fromMain = await focusInfo();
  if (fromMain.href !== "#/mine" || !fromMain.focusVisible) {
    throw new Error("KEYBOARD: Tab after route focus must reach collection tabs: " +
      JSON.stringify(fromMain));
  }
  await pressKey("Tab");
  await pressKey("Tab");
  const firstCard = await focusInfo();
  if (firstCard.href !== "#/case/f1/lens" || !firstCard.focusVisible) {
    throw new Error("KEYBOARD: Lens link not reachable by Tab: " + JSON.stringify(firstCard));
  }
  await pressKey("Enter");
  let lensOpened = false;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const state = await focusInfo();
    if (state.hash === "#/case/f1/lens" && state.content.includes("Declared evidence relations")) {
      lensOpened = true;
      break;
    }
    await sleep(70);
  }
  if (!lensOpened) throw new Error("KEYBOARD: Enter did not open case Lens");
  if ((await focusInfo()).id !== "app") {
    throw new Error("KEYBOARD: opening Lens lost focus from main");
  }
  await pressKey("Tab");
  await pressKey("Tab");
  await pressKey("Tab");
  const trailLink = await focusInfo();
  if (trailLink.href !== "#/case/f1/trail" || !trailLink.focusVisible) {
    throw new Error("KEYBOARD: Trail navigation not reachable by Tab: " + JSON.stringify(trailLink));
  }
  await pressKey("Enter");
  let trailOpened = false;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    const state = await focusInfo();
    if (state.hash === "#/case/f1/trail" && state.content.includes("guided reading order")) {
      trailOpened = true;
      break;
    }
    await sleep(70);
  }
  if (!trailOpened || (await focusInfo()).id !== "app") {
    throw new Error("KEYBOARD: Trail keyboard activation or focus handoff failed");
  }
  console.log("KEYBOARD_QA_PASS 320px: visible Tab focus, Enter navigation, focus handoff, Lens/Trail");

  if (screenshots) {
    await writeFile(join(screenshots, "VIEWPORT_QA.json"),
      JSON.stringify({ schema: "ne-maps-viewport-qa/v0.1", scenarios: reports }, null, 2) + "\n");
  }
  console.log("VIEWPORT_QA_PASS " + reports.length + "/" + scenarios.length +
    " exact widths; no horizontal overflow; bottom/footers reached");
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  child.kill("SIGTERM");
  await sleep(150);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true });
}
