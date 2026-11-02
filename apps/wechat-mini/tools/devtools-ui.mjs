import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buttonByText, cleanupOwnedSession, navigate, tapAndWait, waitForState, withDeadline } from "./devtools-driver.mjs";

// Explicit synthetic views exercise the real DevTools renderer and native taps.
// They cannot establish model quality, production authentication or phone permissions.
export async function verifyNativeUI({ syntheticUI, sdkPath, output, endpoint = "ws://127.0.0.1:9420" }) {
  assert.equal(syntheticUI, true, "EXPLICIT_SYNTHETIC_UI_FLAG_REQUIRED");
  const address = new URL(endpoint);
  assert.ok(address.protocol === "ws:" && ["127.0.0.1", "localhost"].includes(address.hostname) && !address.username && !address.password, "LOCAL_DEVTOOLS_ENDPOINT_REQUIRED");
  assert.ok(sdkPath && output, "SDK_PATH_AND_OUTPUT_REQUIRED");
  const automator = createRequire(import.meta.url)(resolve(sdkPath));
  await mkdir(resolve(output), { recursive: true });
  const directory = await mkdtemp(join(resolve(output), "native-ui-"));
  const result = { pid: process.pid, status: "RUNNING", boundary: "REAL_DEVTOOLS_UI_SYNTHETIC_VIEWS", paidCalls: 0, realModel: "NOT_RUN", realism: "NOT_CERTIFIED", phoneAlbumPermissions: "NOT_RUN", nativeAlbumSave: "NOT_RUN", steps: [], screenshots: [] };
  let mini, server, fixture, token, bound = false;
  async function step(name, action) {
    const started = Date.now();
    try { await withDeadline(name, action, 45000); result.steps.push({ name, status: "PASS", elapsedMs: Date.now() - started }); console.log(`PASS ${name}`); }
    catch (error) { result.steps.push({ name, status: "FAIL", error: error.message }); throw error; }
  }
  const evaluate = (name, fn, ...args) => withDeadline(name, () => mini.evaluate(fn, ...args));
  async function project(data) {
    await evaluate("project explicit view", function (value) { getCurrentPages().slice(-1)[0].setData(value); return true; }, data);
  }
  async function frame(name) {
    const bounds = await evaluate("native class layout", function () {
      return new Promise(resolve => wx.createSelectorQuery().in(getCurrentPages().slice(-1)[0])
        .select(".page").boundingClientRect().selectAll(".button").boundingClientRect().exec(resolve));
    });
    assert.ok(bounds[0] && bounds[0].width <= result.system.windowWidth + 1, "NATIVE_PAGE_WIDTH_INVALID");
    for (const button of bounds[1]) {
      assert.ok(button.left >= -1 && button.right <= result.system.windowWidth + 1, "NATIVE_BUTTON_HORIZONTAL_OVERFLOW");
      assert.ok(button.height >= 43.5, "NATIVE_BUTTON_TOUCH_TARGET_TOO_SMALL");
    }
    await writeFile(join(directory, name + ".layout.json"), JSON.stringify(bounds, null, 2) + "\n");
    const path = join(directory, name + ".png");
    await withDeadline("screenshot " + name, () => mini.screenshot({ path }));
    const bytes = await readFile(path); assert.ok(bytes.length > 1000, "NATIVE_SCREENSHOT_EMPTY");
    result.screenshots.push({ name, path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  async function scrollToBottom(page) {
    await evaluate("scroll native page", function () { wx.pageScrollTo({ scrollTop: 99999, duration: 0 }); return true; });
    await waitForState("native page scrolled", async () => Number(await page.scrollTop()) > 0);
  }
  async function scrollClassIntoView(selector) {
    const rect = await evaluate("locate native control", function (selector) {
      return new Promise(resolve => wx.createSelectorQuery().in(getCurrentPages().slice(-1)[0]).select(selector).boundingClientRect().exec(values => resolve(values[0])));
    }, selector);
    assert.ok(rect, "NATIVE_SCROLL_TARGET_MISSING");
    const page = await mini.currentPage();
    const top = Number(await page.scrollTop()) + rect.top - 80;
    await evaluate("scroll control into viewport", function (top) { wx.pageScrollTo({ scrollTop: Math.max(0, top), duration: 0 }); return true; }, top);
    let previous = "";
    await waitForState("native control visible and stable", async () => {
      const current = await evaluate("native visibility", function (selector, height) {
        return new Promise(resolve => wx.createSelectorQuery().in(getCurrentPages().slice(-1)[0]).select(selector).boundingClientRect().exec(values => {
          const rect = values[0]; resolve(rect && rect.top >= 0 && rect.bottom <= height ? [rect.left, rect.top, rect.width, rect.height].join(":") : "");
        }));
      }, selector, result.system.windowHeight);
      const stable = current && current === previous; previous = current; return stable;
    });
  }
  try {
    mini = await withDeadline("connect", () => automator.connect({ wsEndpoint: endpoint }));
    result.system = await withDeadline("system", () => mini.systemInfo());
    assert.equal(result.system.platform, "devtools", "THIS_RUNNER_IS_DEVTOOLS_UI_ONLY");
    const projectConfig = JSON.parse(await readFile(new URL("../project.config.json", import.meta.url), "utf8"));
    assert.equal(await evaluate("AppID", function () { return wx.getAccountInfoSync().miniProgram.appId; }), projectConfig.appid);
    assert.equal(await evaluate("session admission", function () { return !!require("services/session.js").get(); }), false, "ACTIVE_USER_SESSION_MUST_BE_PRESERVED");
    const { timelineFixture, syntheticPng } = await import("../../../services/api/test/timeline-fixtures.mjs");
    const { createApiServer, StaticTokenAuthenticator } = await import("../../../services/api/dist/index.js");
    const { FileTimelineArtifactStore } = await import("../../../services/api/dist/timeline-artifacts.js");
    fixture = await timelineFixture(join(directory, "runtime.sqlite"));
    const store = new FileTimelineArtifactStore(join(directory, "images")), nodes = [];
    for (let i = 0; i < 21; i++) nodes.push(await fixture.readyNode(await store.put("age-" + i, syntheticPng(i, 64, 64), "image/png"), i * 5));
    fixture.runtime.applyExternalBusinessEvent(fixture.service, fixture.callback("root", "succeeded", { schemaVersion: "ltm.timeline-results.v1", sourceAssetId: "source", planVersion: "age-portrait-plan.v1", aiLabel: true, nodes }));
    token = randomUUID() + randomUUID();
    server = createApiServer({ runtime: fixture.runtime, capabilityRegistry: fixture.registry, timelineArtifacts: store, appEnvironment: "test", staticDirectory: null,
      authenticator: new StaticTokenAuthenticator([{ token, actorId: "user", tenantId: "tenant", roles: ["consumer"], allowedPurposes: ["age_transformation", "sharing"] }]) });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = "http://127.0.0.1:" + server.address().port;
    const headers = { authorization: "Bearer " + token, "x-purpose": "age_transformation" };
    const projection = await (await fetch(base + "/v1/session", { headers })).json();
    const view = (await (await fetch(base + "/v1/timelines/root", { headers })).json()).data;
    assert.equal(view.readyCount, 21);
    await evaluate("bind explicit synthetic session", function (candidate, response) { require("services/session.js").bindServerProjection(candidate, response); return true; },
      { actorId: "user", tenantId: "tenant", roles: ["consumer"], purpose: "age_transformation", accessToken: token, expiresAt: new Date(Date.now() + 3600000).toISOString() }, projection);
    bound = true;
    let page;
    await step("capture real consent taps and picker enable/disable", async () => {
      page = await navigate(mini, "switchTab", "/pages/capture/index");
      const checkbox = await withDeadline("checkbox", () => page.$("checkbox"));
      const picker = await withDeadline("picker", () => page.$(".upload-picker"));
      assert.equal(await picker.property("disabled"), true);
      await tapAndWait("consent accepted", checkbox, async () => (await page.data()).accepted === true && await picker.property("disabled") === false);
      await frame("capture-consent");
      await tapAndWait("consent withdrawn", checkbox, async () => (await page.data()).accepted === false && await picker.property("disabled") === true);
    });
    await step("library renders all 21 ages and native controls", async () => {
      page = await navigate(mini, "switchTab", "/pages/library/index");
      await waitForState("library initial load settles", async () => !!(await page.data()).error);
      await project({ activeCommandId: "root", delivery: view, selectedNode: view.nodes[0], selectedAge: 0, previewPath: "", timelineBusy: false, batchTotal: 21, batchSaved: 2, albumPermissionDenied: true,
        error: "联调样例：合成视图，未调用真实模型；未执行真实相册授权。" });
      const chips = await waitForState("21 native age buttons", async () => { const list = await page.$$(".age-chip"); return list.length === 21 && list; });
      const ages = [];
      for (const chip of chips) ages.push(Number(await chip.attribute("data-age")));
      assert.deepEqual(ages, Array.from({ length: 21 }, (_, i) => i * 5));
      result.ageGeometry = [];
      for (const chip of chips) {
        const label = await chip.$("view"), state = await chip.$(".age-chip-state");
        const [size, origin, labelSize, labelOrigin, stateSize, stateOrigin] = await Promise.all([chip.size(), chip.offset(), label.size(), label.offset(), state.size(), state.offset()]);
        assert.ok(Number(size.width) >= 44 && Number(size.height) >= 44, "NATIVE_AGE_TOUCH_TARGET_TOO_SMALL");
        assert.ok(Number(labelSize.height) <= 24 && Number(labelSize.width) <= Number(size.width) - 4, "NATIVE_AGE_LABEL_WRAPPED_OR_CLIPPED");
        assert.ok(labelOrigin.top >= origin.top && stateOrigin.top >= labelOrigin.top + Number(labelSize.height) && stateOrigin.top + Number(stateSize.height) <= origin.top + Number(size.height), "NATIVE_AGE_STATUS_CLIPPED");
        result.ageGeometry.push({ age: Number(await chip.attribute("data-age")), size, labelSize, stateSize });
      }
      assert.ok(await buttonByText(page, "保存 0 岁原图"));
      assert.ok(await buttonByText(page, "继续保存剩余原图"));
      assert.ok(await buttonByText(page, "前往设置，允许保存到相册"));
      await frame("library-21-top");
      await scrollToBottom(page); await frame("library-save-settings");
    });
    await step("native age 100 selection survives unavailable backend without claiming download", async () => {
      await scrollClassIntoView(".age-rail");
      const rail = await page.$(".age-rail");
      await withDeadline("horizontal age rail scroll", () => rail.scrollTo(99999, 0));
      const chip = await page.$('.age-chip[data-age="100"]');
      assert.equal(Number(await chip.attribute("data-age")), 100);
      const ageLabel = await chip.$("view");
      const labelSize = await ageLabel.size();
      result.ageLabelSize = labelSize;
      assert.ok(Number(labelSize.height) <= 24, "NATIVE_AGE_LABEL_WRAPPED_OR_CLIPPED");
      result.ageRail = await waitForState("age 100 visible in native rail", () => evaluate("native rail measurement", function () {
        return new Promise(resolve => wx.createSelectorQuery().in(getCurrentPages().slice(-1)[0])
          .select(".age-rail").scrollOffset().select(".age-rail").boundingClientRect().selectAll(".age-chip").boundingClientRect().exec(values => {
            const rail = values[1], last = values[2].at(-1); resolve(last && last.left >= rail.left && last.right <= rail.right ? values : false);
          }));
      }));
      await frame("library-age-100-before-tap");
      try { await tapAndWait("age 100 selected", chip, async () => (await page.data()).selectedAge === 100); }
      finally { const data = await page.data(); result.ageSelection = { selectedAge: data.selectedAge, timelineBusy: data.timelineBusy, error: data.error, timelineMessage: data.timelineMessage }; }
      await waitForState("age fetch settled", async () => !(await page.data()).timelineBusy);
      assert.ok((await page.data()).timelineMessage, "UNAVAILABLE_BACKEND_MUST_NOT_APPEAR_AS_A_DOWNLOADED_PHOTO");
      await frame("library-age-100-selected");
    });
    await step("native stop button changes the actual cancellation signal", async () => {
      await evaluate("explicit in-flight UI state", function () { getCurrentPages().slice(-1)[0].batchSignal = { cancelled: false }; return true; });
      await project({ batchSaving: true, timelineBusy: true });
      const stop = await waitForState("stop control rendered", () => buttonByText(page, "停止后续保存"));
      await scrollClassIntoView(".button.danger");
      assert.equal(await stop.property("disabled"), false);
      await frame("library-stop-before-tap");
      try { await tapAndWait("batch cancelled", stop, () => evaluate("actual cancellation signal", function () { return getCurrentPages().slice(-1)[0].batchSignal.cancelled === true; })); }
      finally { result.batchSignal = await evaluate("batch observation", function () { const p = getCurrentPages().slice(-1)[0]; return { path: p.route, signal: p.batchSignal, saving: p.data.batchSaving, busy: p.data.timelineBusy }; }); }
      await project({ batchSaving: false, timelineBusy: false });
    });
    await step("failed age shows retry and recovery controls", async () => {
      await project({ selectedAge: 40, selectedNode: { targetAge: 40, status: "failed", canRetry: true, attempts: 1 } });
      await waitForState("retry control", () => buttonByText(page, "重新生成 40 岁的照片 ↻"));
      assert.ok(await buttonByText(page, "刷新时间轴 / 重试下载"));
      await scrollToBottom(page); await frame("library-failure-recovery");
    });
    await step("wardrobe renders the denied permission settings entry", async () => {
      page = await navigate(mini, "navigateTo", "/pages/wardrobe/index?rootId=root&age=0");
      await waitForState("wardrobe initial load settles", async () => !(await page.data()).busy);
      await project({ albumPermissionDenied: true, error: "联调样例：仅验证权限入口展示，未调用真实相册授权。" });
      await waitForState("wardrobe settings", () => buttonByText(page, "前往设置，允许保存到相册"));
      await scrollToBottom(page); await frame("wardrobe-settings");
    });
    await step("native wardrobe return button opens the actual album", async () => {
      const back = await waitForState("wardrobe album button", () => buttonByText(page, "返回相册"));
      await tapAndWait("wardrobe returned to album", back, async () => {
        const current = await mini.currentPage();
        if (current.path !== "pages/library/index" || !await current.$(".page")) return false;
        page = current; return true;
      });
    });
    result.status = "PASS_DEVTOOLS_UI_ONLY";
  } catch (error) { result.status = "FAILED"; result.error = { message: error.message, stack: error.stack }; throw error; }
  finally {
    try {
      if (mini && bound) {
        await cleanupOwnedSession(mini, token);
      }
    } catch (error) { result.cleanupError = error.message; result.status = "FAILED"; console.error("Native cleanup failed:", error.stack); }
    finally { if (mini) await withDeadline("disconnect owned client", () => mini.disconnect());
      if (server?.listening) await new Promise(resolve => server.close(resolve)); fixture?.runtime.close();
      await writeFile(join(directory, "results.json"), JSON.stringify(result, null, 2) + "\n");
      console.log(JSON.stringify({ directory, status: result.status, passed: result.steps.filter(s => s.status === "PASS").length })); }
  }
  assert.equal(result.status, "PASS_DEVTOOLS_UI_ONLY");
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { "synthetic-ui": { type: "boolean", default: false }, sdk: { type: "string" }, output: { type: "string" }, endpoint: { type: "string" } } });
  try { await verifyNativeUI({ syntheticUI: values["synthetic-ui"], sdkPath: values.sdk, output: values.output, endpoint: values.endpoint }); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
