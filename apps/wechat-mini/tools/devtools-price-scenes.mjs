import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buttonByText, navigate, tapAndWait, waitForState, withDeadline } from "./devtools-driver.mjs";

// Real local HTTP/SQLite purchase scope; all people/quality reports remain synthetic.
// This prepares unpaid orders only. No checkout, native payment or fulfil request.
export async function preparePriceViews({ base, headers }) {
  async function create(input) {
    const response = await fetch(base + "/v1/photo-purchases", { method: "POST", headers: { ...headers, "content-type": "application/json", "idempotency-key": "native-price-" + randomUUID() }, body: JSON.stringify(input), signal: AbortSignal.timeout(8000) });
    const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result));
    assert.equal(result.data.paymentState, "pending"); assert.ok(result.data.items.every(item => item.commandId === null));
    return result.data;
  }
  const generation = { sourceAssetId: "source", participantIds: ["user"], currentAge: 35, seed: "native-price-seed", promptPolicyVersion: "age-policy-v1", illustrativeLabel: true };
  const catalogResponse=await fetch(base+'/v1/photo-products',{headers,signal:AbortSignal.timeout(8000)});assert.equal(catalogResponse.status,200);const products=(await catalogResponse.json()).data.products.filter(p=>p.sku.startsWith('lifespan-'));
  const albums=[];for(const product of products)albums.push(await create({sku:product.sku,generation:{...generation,targetAges:Array.from({length:product.imageCount},(_,i)=>i*(product.imageCount===11?10:5)),timelineProfile:`lifespan-${product.imageCount}-v1`,imageQuality:product.imageQuality}}));
  assert.equal(albums.length,4);const lifespan=albums.find(p=>p.sku==='lifespan-21');assert.ok(lifespan);
  const age = await create({ sku: "selected-age", generation: { ...generation, targetAges: [37], timelineProfile: "single-age-v1" } });
  const series = await create({ sku: "wardrobe-series", sourceRootCommandId: "root", targetAge: 0, seriesId: "daily" });
  const response = await fetch(base + "/v1/timelines/root/nodes/0/wardrobe", { headers, signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200); const context = (await response.json()).data;
  assert.deepEqual([lifespan.amountMinor, age.amountMinor, series.amountMinor], [4990, 590, 990]);
  assert.deepEqual([lifespan.expectedCount, age.expectedCount, series.expectedCount], [21, 1, 4]);
  return { lifespan, albums, age, series, context };
}

export async function verifyPriceScenes({ mini, views, step, frame, project, windowHeight }) {
  const text = async page => (await withDeadline("native page root", () => page.$(".page"))).text();
  async function control(page, className, attribute, value) {
    const elements = await page.$$(className), matches = [];
    for (let i = 0; i < elements.length; i++) if (await elements[i].attribute(attribute) === value) matches.push(i);
    assert.equal(matches.length, 1, "NATIVE_PRICE_CONTROL_IDENTITY_UNCERTAIN");
    const index = matches[0];
    const measure = () => mini.evaluate(function (selector, index) {
      return new Promise(resolve => wx.createSelectorQuery().in(getCurrentPages().slice(-1)[0]).selectAll(selector).boundingClientRect().exec(values => resolve({ count: values[0].length, rect: values[0][index] })));
    }, className, index);
    const initial = await measure(); assert.equal(initial.count, elements.length); assert.ok(initial.rect);
    const top = Number(await page.scrollTop()) + initial.rect.top - 80;
    await mini.evaluate(function (top) { wx.pageScrollTo({ scrollTop: Math.max(0, top), duration: 0 }); return true; }, top);
    let previous = "";
    await waitForState("native price control visible and stable", async () => {
      const { count, rect } = await measure(); assert.equal(count, elements.length);
      const current = rect && rect.top >= 0 && rect.bottom <= windowHeight ? [rect.left, rect.top, rect.width, rect.height].join(":") : "";
      const stable = current && current === previous; previous = current; return stable;
    });
    assert.equal(await elements[index].attribute(attribute), value); return elements[index];
  }
  await step("price: home advertises four album tiers,1/590 and whole-series990", async () => {
    const page = await navigate(mini, "switchTab", "/pages/home/index");
    const body = await text(page); for (const label of ["¥19.90", "¥29.90", "¥49.90", "普通清晰", "高清", "1 张 ¥5.90", "整系列 ¥9.90", "全部适用款式"]) assert.ok(body.includes(label), label);
    await frame("prices-home");
  });
  await step("price: actual single/couple and age/lifespan mode taps keep correct totals", async () => {
    const page = await navigate(mini, "navigateTo", "/pages/editor/index?assetId=source");
    assert.equal((await page.data()).priceLifespan, "¥49.90"); assert.equal((await page.data()).priceAge, "¥5.90");
    await tapAndWait("selected-age mode", await control(page, ".choice", "data-value", "age"), async () => (await page.data()).playMode === "age");
    assert.ok(await buttonByText(page, "¥5.90 · 生成 30 岁照片"));
    await tapAndWait("couple mode", await control(page, ".choice", "data-value", "couple"), async () => (await page.data()).subjectMode === "couple");
    assert.ok(await buttonByText(page, "¥5.90 · 生成 30 岁照片"));
    await frame("prices-editor-age-couple");
    await tapAndWait("lifespan mode", await control(page, ".choice", "data-value", "lifespan"), async () => (await page.data()).playMode === "lifespan");
    const generate = await buttonByText(page, "¥49.90 · 生成 21 张照片"); assert.ok(generate); assert.equal(await generate.property("disabled"), true);
    await frame("prices-editor-21");
  });
  await step("price: wardrobe native series selection includes four styles for one990 total", async () => {
    const page = await navigate(mini, "navigateTo", "/pages/wardrobe/index?rootId=root&age=0");
    await waitForState("wardrobe initial request settled", async () => !(await page.data()).busy);
    const context = views.context, styles = context.styles;
    const series = [...new Map(styles.filter(style => !style.legacy).map(style => [style.seriesId, { id: style.seriesId, label: style.seriesLabel.split(" · ")[0] }])).values()];
    await project({ context, styles, series, selectedSeriesId: "daily", people: context.participants.map(person => ({ ...person, self: true, label: "照片里的人" })), error: "", busy: false });
    await withDeadline("derive actual eligible styles", () => mini.evaluate(function () { getCurrentPages().slice(-1)[0].updateBundle(); return true; }));
    assert.equal((await page.data()).bundleCount, views.series.expectedCount); assert.equal((await page.data()).priceSeries, "¥9.90");
    await tapAndWait("whole east series selected", await control(page, ".series-option", "data-series", "east"), async () => (await page.data()).selectedSeriesId === "east");
    assert.equal((await page.data()).bundleCount, 4); assert.ok((await text(page)).includes("不逐款计费"));
    await frame("prices-wardrobe-series");
  });
  await step("price: orders render real immutable unpaid quotes without opening payment", async () => {
    const page = await navigate(mini, "navigateTo", "/pages/commerce/index");
    await waitForState("orders initial request settled", async () => !(await page.data()).loading);
    await withDeadline("project real unpaid quotes", () => mini.evaluate(function (quotes) {
      const page = getCurrentPages().slice(-1)[0], purchases = require("services/photo-purchases.js");
      for (const quote of quotes) purchases.validate(quote);
      page.setData({ orders: quotes.map(quote => ({ ...quote, amountText: purchases.money(quote.amountMinor), stateText: "待付款" })), error: "" });
      page.showOrder(quotes[2]); return true;
    }, [views.lifespan, views.age, views.series]));
    const body = await text(page); assert.ok(body.includes("¥9.90")); assert.ok(body.includes("¥5.90")); assert.ok(body.includes("本系列全部适用款式"));
    assert.equal((await page.data()).selected.paymentState, "pending"); assert.ok(await buttonByText(page, "确认订单并继续"));
    await frame("prices-orders");
  });
}
