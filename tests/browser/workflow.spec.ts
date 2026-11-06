import Papa from "papaparse";
import { test, expect } from "./fixtures";

test("stylesheet scopes stop at child regions and native fields keep form ownership", async ({
  shop,
}) => {
  const { panel, page } = shop;
  const form = panel.getByRole("form", { name: "收集设置", exact: true });
  expect(
    await form.evaluate((element) => {
      const form = element as HTMLFormElement;
      return [
        "startDate",
        "endDate",
        "includeDetails",
        "pageSize",
        "maxPages",
      ].every(
        (name) =>
          (form.elements.namedItem(name) as HTMLInputElement)?.form === form,
      );
    }),
  ).toBe(true);
  const start = panel.getByRole("button", { name: "开始收集", exact: true });
  const close = panel.getByRole("button", { name: "收起", exact: true });
  const border = await start.evaluate(
    (element) => getComputedStyle(element).borderTopWidth,
  );
  await page.locator("#pdd-order-export").evaluate((host) => {
    const rules = [...host.shadowRoot!.querySelector("style")!.sheet!.cssRules];
    const dialog = rules.find(
      (rule) =>
        rule instanceof CSSScopeRule && rule.start?.includes('"dialog"'),
    ) as CSSScopeRule;
    if (!dialog) throw new Error("Missing dialog style scope");
    dialog.insertRule("button { border: 13px solid red !important; }");
  });
  expect(
    await close.evaluate((element) => getComputedStyle(element).borderTopWidth),
  ).toBe("13px");
  expect(
    await start.evaluate((element) => getComputedStyle(element).borderTopWidth),
  ).toBe(border);
  await expect(
    panel.getByText("日期留空表示不限。", { exact: true }),
  ).toBeVisible();
  expect(
    await start.evaluate((element) =>
      (element as HTMLButtonElement).form?.getAttribute("aria-label"),
    ),
  ).toBe("收集设置");
});

test("the fixed launcher stays in the viewport and remains keyboard accessible", async ({
  shop,
}) => {
  const { page } = shop;
  await shop.panel.getByRole("button", { name: "收起", exact: true }).click();
  const launcher = page.getByRole("button", { name: "导出账单", exact: true });
  for (const width of [1000, 320]) {
    await page.setViewportSize({ width, height: 568 });
    const bounds = (await launcher.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeCloseTo(width - 16, 0);
    expect(bounds.y + bounds.height).toBeCloseTo(548, 0);
  }
  await launcher.focus();
  await page.keyboard.press("Enter");
  await expect(shop.dialog).toBeVisible();
  await expect(launcher).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(shop.dialog).toBeHidden();
  await expect(launcher).toBeFocused();
  await launcher.tap();
  await expect(shop.dialog).toBeVisible();
});

test("panel dimensions stay compact when the site uses a large root font", async ({
  shop,
}) => {
  const { page } = shop;
  expect(
    await shop.dialog.evaluate((element) => {
      const styles = (element.getRootNode() as ShadowRoot).querySelectorAll(
        "style",
      );
      return {
        hasRules:
          [...styles].some((style) => Boolean(style.sheet?.cssRules.length)) ||
          (element.getRootNode() as ShadowRoot).adoptedStyleSheets.some(
            (sheet) => sheet.cssRules.length > 0,
          ),
      };
    }),
  ).toEqual({ hasRules: true });
  await page.setViewportSize({ width: 1900, height: 900 });
  const normalWidth = (await shop.dialog.boundingBox())!.width;
  await page.addStyleTag({
    content:
      ":root { font-size: 100px !important; } #pdd-order-export { font-family: serif !important; }",
  });
  expect(
    await shop.dialog.evaluate(
      (element) => getComputedStyle(element).fontFamily,
    ),
  ).toContain("system-ui");
  await expect
    .poll(async () => (await shop.dialog.boundingBox())!.width)
    .toBeCloseTo(normalWidth, 0);
  await page.screenshot({ path: test.info().outputPath("desktop.png") });
  await shop.panel.getByText("请求设置", { exact: true }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: test.info().outputPath("expanded.png") });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 568 });
    const bounds = (await shop.dialog.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(width - 24);
    expect(Math.abs(bounds.x - (width - bounds.width) / 2)).toBeLessThan(2);
    expect(
      await shop.dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("mobile.png") });
});

test("native descriptions preserve control interactions and page progress starts at zero", async ({
  shop,
}) => {
  const { page, fixture, release } = shop;
  const details = shop.panel.getByRole("checkbox", { name: "收集详情" });
  await expect(details.locator("..")).toHaveAttribute(
    "title",
    /收集时间会更长/,
  );
  await shop.panel.getByText("收集详情", { exact: true }).click();
  await expect(details).not.toBeChecked();
  await details.focus();
  await page.keyboard.press("Space");
  await expect(details).toBeChecked();
  await shop.panel.getByText("请求设置", { exact: true }).click();
  await expect(
    shop.panel.getByLabel("最多读取页数", { exact: true }).locator(".."),
  ).toHaveAttribute("title", /页数上限/);
  fixture.holdDetails = true;
  await shop.panel
    .getByRole("button", { name: "开始收集", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => fixture.requests.length).toBe(2);
  await expect(shop.panel.getByRole("progressbar")).toHaveAttribute(
    "value",
    "0",
  );
  await expect(shop.panel.getByRole("progressbar")).toHaveAttribute("max", "2");
  await expect(
    shop.panel.getByRole("heading", { name: "收集进度" }),
  ).toBeVisible();
  fixture.holdDetails = false;
  release();
  const json = shop.panel.getByRole("button", {
    name: "导出 JSON",
    exact: true,
  });
  await expect(json).toBeVisible();
  await expect(
    shop.panel.getByRole("region", { name: "收集进度", exact: true }),
  ).toBeHidden();
  await expect(
    shop.panel.getByRole("region", { name: "收集结果", exact: true }),
  ).toBeVisible();
  await expect(shop.panel.getByRole("progressbar")).toHaveCount(0);
  await expect(json).toHaveAttribute(
    "title",
    /订单与详情数据。\n\n.*个人信息.*精度损失/,
  );
  await expect(
    shop.panel.getByRole("button", { name: "导出 CSV", exact: true }),
  ).toHaveAttribute("title", /未扣除退款。\n\n.*设为文本/);
  await expect(json).toBeEnabled();
  await json.focus();
  await expect(json).toBeFocused();
  await expect(shop.dialog).toBeVisible();
  await shop.panel.getByRole("button", { name: "收起", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(shop.dialog).toBeHidden();
});

test("starting collection from a focused field moves focus to the stop button", async ({
  shop,
}) => {
  const { fixture } = shop;
  fixture.holdDetails = true;
  await shop.panel.getByText("请求设置", { exact: true }).click();
  await shop.panel.getByLabel("每页订单数", { exact: true }).focus();
  await shop.panel
    .getByRole("form", { name: "收集设置", exact: true })
    .evaluate((form) => (form as HTMLFormElement).requestSubmit());
  const stop = shop.panel.getByRole("button", {
    name: "停止并保留结果",
    exact: true,
  });
  await expect(stop).toBeFocused();
  await expect(
    shop.panel.locator("[data-ui=collect-settings]"),
  ).not.toHaveAttribute("open");
  await stop.click();
});

test("installed userscript collects first and exports only on request", async ({
  shop,
}) => {
  const { page, fixture, downloads, file } = shop;
  await expect(
    shop.panel.getByRole("region", { name: "收集结果" }),
  ).toBeHidden();
  await expect(shop.panel.getByLabel("开始日期")).toHaveValue("");
  await expect(shop.panel.getByLabel("结束日期")).toHaveValue("");
  await expect(shop.panel.getByLabel("每页订单数")).toHaveValue("20");
  await expect(
    shop.panel.getByRole("button", { name: "不限日期", exact: true }),
  ).toHaveCount(0);
  await expect(shop.panel.getByLabel("开始日期")).toHaveAccessibleDescription(
    "日期留空表示不限。",
  );
  await expect(shop.panel.getByLabel("结束日期")).toHaveAccessibleDescription(
    "日期留空表示不限。",
  );
  expect(
    await shop.dialog.evaluate(
      (element) => element instanceof HTMLDialogElement,
    ),
  ).toBe(true);
  expect(
    await shop.dialog.evaluate((element) => {
      return element.scrollWidth <= element.clientWidth;
    }),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("panel.png") });
  await shop.panel.getByRole("button", { name: "收起", exact: true }).click();
  await expect(shop.dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出账单", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("launcher.png") });
  await page.getByRole("button", { name: "导出账单", exact: true }).click();
  await shop.panel.getByRole("button", { name: "开始收集" }).click();
  await expect
    .poll(() =>
      shop.panel
        .getByRole("button", { name: "导出 CSV", exact: true })
        .isEnabled(),
    )
    .toBe(true);
  expect(downloads).toHaveLength(0);
  const requestCount = fixture.requests.length;
  await expect(
    shop.panel.getByRole("button", { name: "重新收集", exact: true }),
  ).toBeVisible();
  await expect(shop.panel.getByLabel("开始日期")).toBeHidden();
  await shop.panel.getByText("收集设置", { exact: true }).click();
  await shop.panel.getByLabel("开始日期").fill("2026-10-17");
  await expect(
    shop.panel.getByText("结果日期：不限 至 不限", { exact: true }),
  ).toBeVisible();
  expect(fixture.requests).toHaveLength(requestCount);
  const csvDownload = page.waitForEvent("download");
  await shop.panel
    .getByRole("button", { name: "导出 CSV", exact: true })
    .click();
  const csv = await file(await csvDownload);
  expect([...csv.bytes.subarray(0, 3)]).toEqual([239, 187, 191]);
  expect(csv.name).toBe("拼多多账单_不限至不限.csv");
  const parsed = Papa.parse<{ 订单编号: string }>(csv.bytes.toString(), {
    header: true,
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.data.map((row) => row.订单编号)).toEqual(
    fixture.orders.map((order) => order.order_sn),
  );
  const jsonDownload = page.waitForEvent("download");
  await shop.panel
    .getByRole("button", { name: "导出 JSON", exact: true })
    .click();
  const jsonFile = await file(await jsonDownload);
  expect(jsonFile.name).toBe(csv.name.replace(/\.csv$/, ".json"));
  expect(downloads).toHaveLength(2);
  const json = JSON.parse(jsonFile.bytes.toString());
  expect(Array.isArray(json)).toBe(true);

  expect(json.map((entry: { order: unknown }) => entry.order)).toEqual(
    fixture.orders,
  );
  expect(
    json.map((entry: { detail: { marker: string } }) => entry.detail.marker),
  ).toEqual(fixture.orders.map((order) => order.order_sn));
  await page.goto("https://mobile.pinduoduo.com/other.html");
  expect(await page.getByRole("button", { name: "导出账单" }).count()).toBe(0);
});

test("recollection validates drafts before replacing the result and keeps the new partial range", async ({
  shop,
}) => {
  const { page, fixture, downloads, file } = shop;
  await shop.panel.getByRole("button", { name: "开始收集" }).click();
  await expect(
    shop.panel.getByRole("button", { name: "导出 JSON", exact: true }),
  ).toBeVisible();
  const previousRequests = fixture.requests.length;
  await shop.panel.getByText("收集设置", { exact: true }).click();
  await shop.panel.getByText("请求设置", { exact: true }).click();
  await shop.panel.getByLabel("每页订单数").fill("0");
  await shop.panel.getByText("请求设置", { exact: true }).click();
  await shop.panel.getByText("收集设置", { exact: true }).click();
  await shop.panel
    .getByRole("button", { name: "重新收集", exact: true })
    .click();
  await expect(shop.panel.getByLabel("每页订单数")).toBeVisible();
  await expect(shop.panel.getByLabel("每页订单数")).toBeFocused();
  expect(fixture.requests).toHaveLength(previousRequests);
  await expect(
    shop.panel.getByRole("button", { name: "导出 JSON", exact: true }),
  ).toBeVisible();
  await shop.panel.getByLabel("每页订单数").fill("20");
  await shop.panel.getByLabel("开始日期").fill("2026-10-17");
  await shop.panel.getByLabel("结束日期").fill("2026-10-17");
  fixture.holdDetails = true;
  fixture.allowDetails = 1;
  await shop.panel
    .getByRole("button", { name: "重新收集", exact: true })
    .click();
  await expect.poll(() => fixture.requests.length).toBe(previousRequests + 3);
  await expect(
    shop.panel.getByRole("button", { name: "导出 JSON", exact: true }),
  ).toBeHidden();
  await expect(
    shop.panel.getByRole("button", { name: "收起", exact: true }),
  ).toBeVisible();
  await shop.panel
    .getByRole("button", { name: "停止并保留结果", exact: true })
    .click();
  await expect(
    shop.panel.getByRole("button", { name: "导出部分 JSON", exact: true }),
  ).toBeVisible();
  await expect(
    shop.panel.getByText("结果日期：2026-10-17 至 2026-10-17", { exact: true }),
  ).toBeVisible();
  expect(downloads).toHaveLength(0);
  const download = page.waitForEvent("download");
  await shop.panel
    .getByRole("button", { name: "导出部分 JSON", exact: true })
    .click();
  const exportedFile = await file(await download);
  expect(exportedFile.name).toBe(
    "拼多多账单_2026-10-17至2026-10-17_不完整.json",
  );
  const exported = JSON.parse(exportedFile.bytes.toString());
  expect(Array.isArray(exported)).toBe(true);
  await page.setViewportSize({ width: 320, height: 568 });
  expect(
    await shop.dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath("small-result.png") });
});

test("hiding preserves a blocked task and reopening allows an explicit stop", async ({
  shop,
}) => {
  const { page, fixture, downloads, file, release } = shop;
  fixture.holdDetails = true;
  fixture.allowDetails = 1;
  await shop.panel.getByRole("button", { name: "开始收集" }).click();
  await expect.poll(() => fixture.requests.length).toBe(3);
  await expect(shop.panel.getByRole("progressbar")).toHaveAttribute(
    "value",
    "1",
  );
  await expect(shop.panel.getByRole("progressbar")).toHaveAttribute("max", "2");
  expect(
    await shop.panel
      .getByRole("progressbar")
      .evaluate((element) => (element as HTMLProgressElement).position),
  ).toBe(0.5);
  await shop.panel.getByRole("button", { name: "收起", exact: true }).click();
  await expect(shop.dialog).toBeHidden();
  await page.getByRole("button", { name: "导出账单", exact: true }).click();
  await expect(shop.panel.getByRole("progressbar")).toHaveAttribute(
    "value",
    "1",
  );
  await expect(shop.panel.getByLabel("每页订单数")).toBeDisabled();
  await shop.panel
    .getByRole("button", { name: "停止并保留结果", exact: true })
    .click();
  const exportJson = shop.panel.getByRole("button", {
    name: "导出部分 JSON",
  });
  await expect(exportJson).toBeEnabled();
  release();
  expect(downloads).toHaveLength(0);
  const partialDownload = page.waitForEvent("download");
  await exportJson.click();
  const exported = await file(await partialDownload);
  expect(exported.name).toMatch(/_不完整\.json$/);
  const json = JSON.parse(exported.bytes.toString());
  expect(Array.isArray(json)).toBe(true);
  expect(json.map((entry: { order: unknown }) => entry.order)).toEqual(
    fixture.orders.slice(0, 1),
  );
  expect(
    json.every((entry: { detail: unknown }) => entry.detail !== null),
  ).toBe(true);
  await expect(shop.panel.getByLabel("开始日期")).toBeHidden();
  await page.screenshot({ path: test.info().outputPath("export.png") });
  await shop.panel.getByText("收集设置", { exact: true }).click();
  await expect(shop.panel.getByLabel("开始日期")).toBeVisible();
  expect(fixture.requests).toHaveLength(3);
});

test("Escape hides the dialog while collection completes and drafts survive reopening", async ({
  shop,
}) => {
  const { page, fixture, release } = shop;
  fixture.holdDetails = true;
  fixture.allowDetails = 1;
  fixture.pageSize = 30;
  await shop.panel.getByText("请求设置", { exact: true }).click();
  await shop.panel.getByLabel("每页订单数").fill("30");
  await shop.panel.getByRole("button", { name: "开始收集" }).click();
  await expect.poll(() => fixture.requests.length).toBe(3);
  await expect(shop.panel.getByLabel("开始日期")).toBeHidden();
  await expect(shop.panel.getByRole("progressbar")).toBeVisible();
  await expect(
    shop.panel.getByRole("button", { name: "停止并保留结果" }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("collecting.png") });
  await expect(shop.panel.getByLabel("每页订单数")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(shop.dialog).not.toBeVisible();
  release();
  await expect(
    shop.panel.getByRole("button", {
      name: "导出 JSON",
      exact: true,
      includeHidden: true,
    }),
  ).toHaveCount(1);
  await expect(shop.dialog).toBeHidden();
  await page.getByRole("button", { name: "导出账单", exact: true }).click();
  await expect(
    shop.panel.getByRole("button", { name: "导出 JSON", exact: true }),
  ).toBeEnabled();
  await shop.panel.getByText("收集设置", { exact: true }).click();
  await expect(shop.panel.getByLabel("每页订单数")).toHaveValue("30");
  await expect(shop.panel.getByLabel("开始日期")).toBeEnabled();
  expect(fixture.requests).toHaveLength(4);
});

test("Native fields validate and remain isolated from site styles", async ({
  shop,
}) => {
  const { page, fixture } = shop;
  const before = await page.evaluate(() => ({
    styles: document.head.querySelectorAll("style").length,
    font: getComputedStyle(document.documentElement).fontSize,
  }));
  await page.addStyleTag({
    content:
      "input, button { font-size: 70px !important; display: none !important; }",
  });
  await expect(
    shop.panel.getByRole("button", { name: "开始收集" }),
  ).toBeVisible();
  expect(
    await shop.panel
      .getByLabel("开始日期")
      .evaluate((input) => getComputedStyle(input).fontSize),
  ).not.toBe("70px");
  await shop.panel.getByText("请求设置", { exact: true }).click();
  const size = shop.panel.getByLabel("每页订单数");
  await size.fill("0");
  await shop.panel.getByText("请求设置", { exact: true }).click();
  await shop.panel.getByText("收集设置", { exact: true }).click();
  await shop.panel.getByRole("button", { name: "开始收集" }).click();
  await expect(size).toBeFocused();
  await expect(size).toBeVisible();
  expect(
    await size.evaluate((input) => (input as HTMLInputElement).checkValidity()),
  ).toBe(false);
  expect(fixture.requests).toHaveLength(0);
  await size.fill("20");
  await shop.panel.getByLabel("开始日期").fill("2026-10-18");
  await shop.panel.getByLabel("结束日期").fill("2026-10-17");
  await shop.panel.getByRole("button", { name: "开始收集" }).click();
  expect(fixture.requests).toHaveLength(0);
  await shop.panel.getByLabel("开始日期").fill("");
  await shop.panel.getByLabel("结束日期").fill("");
  await expect(shop.panel.getByRole("checkbox")).toBeChecked();
  await shop.panel.getByText("收集详情", { exact: true }).click();
  await expect(shop.panel.getByRole("checkbox")).not.toBeChecked();
  await shop.panel.getByLabel("每页订单数").press("Enter");
  await expect(
    shop.panel.getByRole("button", { name: "导出 JSON", exact: true }),
  ).toBeEnabled();
  await expect(
    shop.panel.getByRole("button", { name: "重新收集", exact: true }),
  ).toBeFocused();
  expect(
    fixture.requests.every((request) => request.path.includes("order_list")),
  ).toBe(true);
  await shop.panel.getByRole("button", { name: "收起", exact: true }).click();
  await expect(shop.dialog).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "导出账单", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => ({
      styles: document.head.querySelectorAll("style").length,
      font: getComputedStyle(document.documentElement).fontSize,
    })),
  ).toEqual({ ...before, styles: before.styles + 1 });
});

test("CSV failure explains the JSON fallback and keeps the collected data", async ({
  shop,
}) => {
  const { page, fixture, downloads, file } = shop;
  fixture.orders[0]!.order_amount = -1;
  await shop.panel.getByRole("button", { name: "开始收集" }).click();
  const csv = shop.panel.getByRole("button", { name: "导出 CSV", exact: true });
  await expect(csv).toBeEnabled();
  const warning = page.waitForEvent("dialog");
  const clicked = csv.click();
  const alert = await warning;
  expect(alert.type()).toBe("alert");
  expect(alert.message()).toBe("CSV 生成失败，请尝试导出 JSON。");
  await alert.accept();
  await clicked;
  expect(downloads).toHaveLength(0);
  const json = shop.panel.getByRole("button", {
    name: "导出 JSON",
    exact: true,
  });
  await expect(json).toBeEnabled();
  const download = page.waitForEvent("download");
  await json.click();
  const exported = JSON.parse((await file(await download)).bytes.toString());
  expect(exported.map((entry: { order: unknown }) => entry.order)).toEqual(
    fixture.orders,
  );
  await expect(shop.panel.getByRole("status")).toHaveText("收集完成。");
});

test("installed fixed script finishes date-filtered paging with an unrecognizable order number", async ({
  shop,
}) => {
  const { page, fixture, panel, file } = shop;
  fixture.orders[1]!.order_sn = "legacy-order";
  let pages = 0;
  await page.route("**/proxy/api/api/aristotle/order_list_v4?*", (route) => {
    const order = fixture.orders[pages++];
    return route.fulfill({ json: { orders: order ? [order] : [] } });
  });
  await panel.getByLabel("开始日期").fill("2026-10-01");
  await panel.getByLabel("结束日期").fill("2026-10-31");
  await panel.getByRole("button", { name: "开始收集", exact: true }).click();
  const json = panel.getByRole("button", { name: "导出 JSON", exact: true });
  await expect(json).toBeEnabled();
  await expect(panel.getByRole("alert")).toBeHidden();
  await expect(panel.getByRole("note")).toContainText(
    "1 笔订单无法按编号核对日期",
  );
  expect(pages).toBe(3);
  const download = page.waitForEvent("download");
  await json.click();
  const entries = JSON.parse((await file(await download)).bytes.toString());
  expect(entries.map((entry: { order: unknown }) => entry.order)).toEqual(
    fixture.orders,
  );
  expect(
    entries.map((entry: { dateUncertain?: true }) => entry.dateUncertain),
  ).toEqual([undefined, true]);
});

test("denied detail access shows a login hint without partial exports", async ({
  shop,
}) => {
  const { page, downloads } = shop;
  await page.route("**/order.html?*", (route) =>
    route.fulfill({
      status: 403,
      body: "Internal response details must not appear in the UI",
    }),
  );
  await shop.panel.getByRole("button", { name: "开始收集" }).click();
  await expect(shop.panel.getByRole("alert")).toHaveText(
    "登录已失效或访问被拒绝，请在当前页面重新登录。",
  );
  await expect(
    shop.panel.getByRole("button", { name: "开始收集", exact: true }),
  ).toBeEnabled();
  await expect(shop.dialog).not.toContainText("Internal response details");
  expect(downloads).toHaveLength(0);
  await expect(
    shop.panel
      .locator('[data-ui="export"]')
      .getByRole("button", { name: /JSON/ }),
  ).toHaveCount(0);
});

test("an unavailable detail retains that order and collects later details before exporting", async ({
  shop,
}) => {
  const { page, fixture, panel, file } = shop;
  fixture.orders.push({
    order_sn: "261017-c",
    offset: "cursor:c",
    order_amount: 250,
  });
  await page.route("**/order.html?*", (route) => {
    const id = new URL(route.request().url()).searchParams.get("order_sn");
    if (id !== "261017-b") return route.fallback();
    return route.fulfill({
      contentType: "text/html",
      body: "<main>Detail unavailable</main>",
    });
  });
  await panel.getByRole("button", { name: "开始收集", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText(
    "订单列表收集完成，详情不完整。",
  );
  await expect(
    panel.getByText("已收集 3 笔订单 · 详情 2 笔", { exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("note")).toContainText("1 笔订单缺少详情");
  await expect(panel.getByRole("alert")).toBeHidden();
  const download = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "导出 JSON（详情不完整）", exact: true })
    .click();
  const exported = await file(await download);
  expect(exported.name).toBe("拼多多账单_不限至不限_详情不完整.json");
  const entries = JSON.parse(exported.bytes.toString());
  expect(entries.map((entry: { order: unknown }) => entry.order)).toEqual(
    fixture.orders,
  );
  expect(entries[1]).toMatchObject({
    detail: null,
    detailFailure: "unavailable",
  });
  expect(entries[2].detail).toMatchObject({ orderSn: "261017-c" });
});

test("imported JSON resumes only missing details and exports all original orders", async ({
  shop,
}) => {
  const { page, panel, fixture, file } = shop;
  fixture.orders.push(
    { order_sn: "261017-c", offset: "cursor:c", order_amount: 100 },
    { order_sn: "261017-d", offset: "cursor:d", order_amount: 200 },
  );
  const entries = fixture.orders.map((order, index) => ({
    order,
    detail: index < 2 ? { orderSn: order.order_sn, original: true } : null,
    ...(index >= 2 ? { detailFailure: "paused" } : {}),
  }));
  await expect(
    panel.getByText("固定版 2026-10-25.4", { exact: true }),
  ).toBeVisible();
  await panel.getByLabel("导入已有 JSON", { exact: true }).setInputFiles({
    name: "saved-orders.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(entries)),
  });
  await expect(
    panel.getByText("已有 4 笔订单 · 保留详情 2 笔 · 待补 2 笔", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.requests).toHaveLength(0);
  await panel
    .getByRole("button", { name: "仅补齐缺失的 2 笔详情", exact: true })
    .click();
  await expect(
    panel.locator('[data-ui="export-result"] [role="status"]'),
  ).toHaveText("导入订单的详情已齐全。");
  expect(fixture.requests.map((request) => request.path)).toEqual([
    "/order.html",
    "/order.html",
  ]);
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "导出 JSON", exact: true }).click();
  const exported = await file(await download);
  expect(exported.name).toBe("拼多多账单_导入订单_补齐详情.json");
  const result = JSON.parse(exported.bytes.toString());
  expect(result.slice(0, 2)).toEqual(entries.slice(0, 2));
  expect(result.map((entry: { order: unknown }) => entry.order)).toEqual(
    fixture.orders,
  );
  expect(
    result
      .slice(2)
      .every(
        (entry: { detail: unknown; detailFailure?: string }) =>
          entry.detail !== null && !entry.detailFailure,
      ),
  ).toBe(true);
});
