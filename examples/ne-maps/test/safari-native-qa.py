#!/usr/bin/env python3
"""Source-bound smoke of native macOS Safari through Apple's safaridriver.

No third-party driver, remote browser, network RPC, wallet or signer.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib import error, request

BASE = "http://127.0.0.1:4177/"
WEBDRIVER = "http://127.0.0.1:4456"
ARTIFACT = Path(os.environ.get("NE_SAFARI_QA_OUT", "safari-qa"))


def call(method, path, payload=None, timeout=25):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = request.Request(WEBDRIVER + path, data=body, method=method,
                          headers={"Content-Type": "application/json"})
    try:
        with request.urlopen(req, timeout=timeout) as response:
            result = json.load(response)
    except error.HTTPError as exc:
        detail = exc.read(1100).decode("utf-8", errors="replace")
        raise RuntimeError(f"WebDriver HTTP {exc.code} {method} {path}: {detail}") from exc
    if not isinstance(result, dict):
        raise RuntimeError(f"WebDriver invalid response {method} {path}")
    value = result.get("value")
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(f"WebDriver {method} {path}: {value['error']}: {value.get('message', '')}")
    return result


def run():
    if os.uname().sysname != "Darwin":
        raise RuntimeError("Native macOS Safari required, not WebKit/Chromium")
    if not Path("/usr/bin/safaridriver").is_file():
        raise RuntimeError("Apple /usr/bin/safaridriver missing")
    ARTIFACT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ne-safari-qa-") as temp:
        log_path = Path(temp) / "driver.log"
        with log_path.open("wb") as log:
            driver = subprocess.Popen(["/usr/bin/safaridriver", "-p", "4456"],
                                      stdout=log, stderr=subprocess.STDOUT)
            sid = None
            try:
                ready = False
                for _ in range(90):
                    if driver.poll() is not None:
                        break
                    try:
                        status = call("GET", "/status", timeout=3)
                        if isinstance(status.get("value"), dict):
                            ready = True
                            break
                    except (OSError, ValueError, RuntimeError):
                        pass
                    time.sleep(.25)
                if not ready:
                    raise RuntimeError("safaridriver not ready: " + log_path.read_text(errors="replace")[-1700:])
                session = call("POST", "/session",
                               {"capabilities": {"alwaysMatch": {"browserName": "safari"}}}, timeout=55)
                sid = session.get("sessionId") or (session.get("value") or {}).get("sessionId")
                caps = (session.get("value") or {}).get("capabilities") or {}
                if not sid or str(caps.get("browserName", "")).lower() != "safari":
                    raise RuntimeError("Native Safari session unverified: " + str(caps)[:500])
                print("SAFARI_NATIVE_SESSION browser=" + str(caps.get("browserName")) +
                      " version=" + str(caps.get("browserVersion")) +
                      " platform=" + str(caps.get("platformName")))
                route = "/session/" + sid

                def cmd(method, suffix, payload=None, timeout=30):
                    return call(method, route + suffix, payload, timeout=timeout).get("value")

                def eval_js(script):
                    return cmd("POST", "/execute/sync", {"script": script, "args": []}, timeout=25)

                # Actual macOS Safari window, NOT emulated iPhone/iPad Safari.
                cmd("POST", "/window/rect", {"width": 1100, "height": 850})
                scenarios = [
                    ("empty", "#/", "No application cases loaded", "atlas"),
                    ("examples", "#/examples", "Synthetic Core golden", "atlas"),
                    ("genesis-lens", "#/case/zksys-genesis-20261118/lens", "Declared evidence relations", "lens"),
                    ("genesis-trail", "#/case/zksys-genesis-20261118/trail", "guided reading order", "trail"),
                    ("f2-lens", "#/case/f2/lens", "Propositions and evidence bases", "lens"),
                    ("f2-trail", "#/case/f2/trail", "guided reading order", "trail"),
                ]
                findings = []
                for name, hashroute, expected, view in scenarios:
                    cmd("POST", "/url", {"url": BASE + hashroute}, timeout=40)
                    state = None
                    for _ in range(70):
                        state = eval_js("""return {
                          content: (document.querySelector('#app')?.textContent || '').slice(0,18000),
                          width: innerWidth,
                          docWidth: document.documentElement.scrollWidth,
                          bodyWidth: document.body.scrollWidth,
                          pageHeight: Math.max(document.body.scrollHeight,document.documentElement.scrollHeight),
                          relations: document.querySelectorAll('.relation-edge').length,
                          steps: document.querySelectorAll('.trail-step').length
                        };""")
                        if state and expected in state["content"]:
                            break
                        time.sleep(.12)
                    if not state or expected not in state["content"]:
                        raise RuntimeError(name + ": rendered content missing: " + str(state)[:500])
                    width = state["width"]
                    if not isinstance(width, (int, float)) or not 500 <= width <= 1400:
                        raise RuntimeError(name + ": unexpected Safari window width " + str(width))
                    if state["docWidth"] > width + 2 or state["bodyWidth"] > width + 2:
                        raise RuntimeError(name + ": horizontal overflow: " + str(state))
                    if view == "lens" and state["relations"] < 1:
                        raise RuntimeError(name + ": declared relationship missing")
                    if view == "trail" and state["steps"] < 1:
                        raise RuntimeError(name + ": reading steps missing")
                    eval_js("window.scrollTo(0,Math.max(document.body.scrollHeight,document.documentElement.scrollHeight));")
                    time.sleep(.15)
                    bottom = eval_js("""let h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);
                        let f=document.querySelector('footer')?.getBoundingClientRect();
                        return {scrollY: window.scrollY, reached: scrollY+innerHeight>=h-5,
                          footerVisible: !!f && f.top < innerHeight && f.bottom > 0};""")
                    if not bottom["reached"] or not bottom["footerVisible"]:
                        raise RuntimeError(name + ": bottom not reachable: " + str(bottom))
                    if name in ("genesis-lens", "genesis-trail"):
                        eval_js("window.scrollTo(0,0);")
                        encoded = cmd("GET", "/screenshot")
                        if not isinstance(encoded, str):
                            raise RuntimeError(name + ": native Safari screenshot absent")
                        png = base64.b64decode(encoded, validate=True)
                        if png[:8] != b"\x89PNG\r\n\x1a\n":
                            raise RuntimeError(name + ": Safari screenshot is not PNG")
                        (ARTIFACT / ("safari-" + name + ".png")).write_bytes(png)
                    item = {"name": name, "viewportWidth": width,
                            "pageHeight": state["pageHeight"], "relations": state["relations"],
                            "steps": state["steps"], "scrollY": bottom["scrollY"]}
                    findings.append(item)
                    print("SAFARI_NATIVE_PASS " + json.dumps(item, sort_keys=True))
                report = {"schema": "ne-maps-native-safari-qa/v0.1",
                          "commitSha": os.environ.get("GITHUB_SHA"),
                          "browserName": caps["browserName"],
                          "browserVersion": caps.get("browserVersion"),
                          "platformName": caps.get("platformName"),
                          "scenarios": findings,
                          "notTested": ["Safari on iOS", "VoiceOver", "third-party novice usability"]}
                (ARTIFACT / "REPORT.json").write_text(
                    json.dumps(report, indent=2) + "\n", encoding="utf-8")
                names = ["safari-genesis-lens.png", "safari-genesis-trail.png"]
                (ARTIFACT / "SHA256SUMS.txt").write_text("".join(
                    hashlib.sha256((ARTIFACT / name).read_bytes()).hexdigest() + "  " + name + "\n"
                    for name in names), encoding="ascii")
                print("SAFARI_NATIVE_QA_PASS 6/6 macOS Safari; scroll, width and screenshots")
            finally:
                if sid:
                    try:
                        call("DELETE", "/session/" + sid, timeout=7)
                    except Exception as exc:
                        print("WARN Safari session cleanup: " + str(exc)[:200])
                driver.terminate()
                try:
                    driver.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    driver.kill()
                    driver.wait(timeout=5)


if __name__ == "__main__":
    run()
