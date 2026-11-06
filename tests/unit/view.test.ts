// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { h, render } from "preact";
import { ExportPanel } from "../../src/ui";
import stylesheet from "../../src/ui/styles.css?style";
import { PddClient, PddError, type Order } from "../../src/pdd";
import * as collection from "../../src/collect";
import * as files from "../../src/export";
import type { CollectedOrder } from "../../src/collect";
import sample from "../fixtures/orders/reviewed-orders/collected.json" with { type: "json" };

// 单元测试只需样式节点；真实 CSS 转换、布局和隔离由浏览器测试覆盖。
vi.mock("../../src/ui/styles.css?style", () => ({
  default: document.createElement("style"),
}));

// jsdom 没有模态弹层实现；真实焦点、Esc、布局由浏览器测试覆盖。
HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
HTMLDialogElement.prototype.close = function () {
  if (!this.open) return;
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

interface ViewHandle {
  readonly element: HTMLDivElement;
  dispose(): void;
}

const views: ViewHandle[] = [];

beforeEach(() => {
  document.cookie = "pdd_user_id=123; path=/";
  vi.spyOn(PddClient.prototype, "getOrders").mockResolvedValue([]);
  vi.spyOn(PddClient.prototype, "getOrderDetail").mockImplementation(
    async (id) => ({ orderSn: id }),
  );
  vi.spyOn(collection, "collectOrders");
  vi.spyOn(files, "exportFile");
  vi.spyOn(files, "downloadFile").mockImplementation(() => {});
  vi.spyOn(globalThis, "alert").mockImplementation(() => {});
});

afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function createView(): ViewHandle {
  const element = document.createElement("div");
  const mount = document.createElement("div");
  const root = element.attachShadow({ mode: "open" });
  root.append(stylesheet.cloneNode(true), mount);
  render(h(ExportPanel, {}), mount);
  document.body.append(element);
  const view: ViewHandle = {
    element,
    dispose() {
      render(null, mount);
      root.replaceChildren();
      element.remove();
    },
  };
  views.push(view);
  return view;
}

async function updated() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function ui(view: ViewHandle) {
  const root = view.element.shadowRoot!;
  const native = root.querySelector<HTMLFormElement>("form[aria-label]")!;
  return {
    root,
    native,
    input: (name: string) =>
      native.querySelector<HTMLInputElement>(`input[name="${name}"]`)!,
    action: (name: string) =>
      [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === name,
      )!,
    running: () => root.querySelector("fieldset")!.disabled,
    alert: () => root.querySelector<HTMLElement>('[role="alert"]')!,
    status: () => root.querySelector<HTMLElement>('[role="status"]')!,
    exports: () => root.querySelector<HTMLElement>(".exports")!,
  };
}

function mockPage(entries: readonly CollectedOrder[]) {
  return {
    total: entries.length,
    orders: (async function* () {
      yield* entries;
    })(),
  };
}
function mockResult() {
  const result: readonly CollectedOrder[] = sample;
  vi.mocked(collection.collectOrders).mockImplementation(async function* () {
    yield mockPage(result);
  });
  return result;
}

test("multiple views keep independent style nodes when one element is moved", () => {
  const first = createView();
  const second = createView();
  const firstStyle = first.element.shadowRoot!.querySelector("style")!;
  const secondStyle = second.element.shadowRoot!.querySelector("style")!;
  expect(firstStyle).toBeInstanceOf(HTMLStyleElement);
  expect(secondStyle).toBeInstanceOf(HTMLStyleElement);
  expect(firstStyle).not.toBe(secondStyle);
  first.element.remove();
  document.body.append(first.element);
  expect(first.element.shadowRoot!.querySelector("style")).toBe(firstStyle);
  expect(second.element.shadowRoot!.querySelector("style")).toBe(secondStyle);
});

test("collection preserves settings and requires an explicit export interaction", async () => {
  const result = mockResult();
  const view = createView();
  const { root, native, input, action, exports } = ui(view);
  input("pageSize").value = "30";
  native.requestSubmit();
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  expect(files.exportFile).not.toHaveBeenCalled();
  expect(files.downloadFile).not.toHaveBeenCalled();
  expect(root.querySelector<HTMLFormElement>("form[aria-label]")).toBe(native);
  expect(input("pageSize").value).toBe("30");
  expect(collection.collectOrders).toHaveBeenCalledOnce();
  action("导出 JSON").click();
  expect(files.exportFile).toHaveBeenCalledWith(
    result,
    "json",
    null,
    null,
    false,
  );
  expect(files.downloadFile).toHaveBeenCalledOnce();
  view.dispose();
  view.dispose();
  await updated();
  expect(root.children).toHaveLength(0);
  expect(files.downloadFile).toHaveBeenCalledOnce();
});

test.each([2026, 10000])(
  "draft changes preserve empty fields and native date snapshots for year %i",
  async (year) => {
    mockResult();
    const startDate = `${year}-10-17`;
    const endDate = `${year}-10-18`;
    const date = (day: number) => new Date(Date.UTC(year, 9, day));
    const { root, native, input, action, exports } = ui(createView());
    const summary = root.querySelector(
      "[data-ui=collect-settings] summary small",
    )!;
    const edit = (name: string, value: string) => {
      input(name).value = value;
      input(name).dispatchEvent(new Event("input", { bubbles: true }));
    };
    edit("pageSize", "");
    edit("startDate", startDate);
    edit("endDate", endDate);
    input("includeDetails").click();
    await vi.waitFor(() =>
      expect(summary.textContent).toBe(`${startDate} 至 ${endDate} · 仅列表`),
    );
    expect(input("pageSize").value).toBe("");
    expect(input("endDate").min).toBe(startDate);
    native.requestSubmit();
    expect(collection.collectOrders).not.toHaveBeenCalled();
    edit("pageSize", "30");
    edit("maxPages", "3");
    native.requestSubmit();
    await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
    expect(collection.collectOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        getOrders: expect.any(Function),
        getOrderDetail: expect.any(Function),
      }),
      {
        startDate: date(17),
        endDate: date(18),
        includeDetails: false,
        pageSize: 30,
        maxPages: 3,
      },
      expect.any(AbortSignal),
    );
    edit("startDate", `${year}-10-01`);
    await vi.waitFor(() =>
      expect(summary.textContent).toBe(`${year}-10-01 至 ${endDate} · 仅列表`),
    );
    action("导出 JSON").click();
    expect(files.exportFile).toHaveBeenLastCalledWith(
      sample,
      "json",
      date(17),
      date(18),
      false,
    );
  },
);

test("hiding preserves a pending task until an explicit stop", async () => {
  let signal!: AbortSignal;
  vi.mocked(PddClient.prototype.getOrders).mockResolvedValueOnce(
    sample.map((e) => e.order),
  );
  vi.mocked(PddClient.prototype.getOrderDetail)
    .mockResolvedValueOnce({ orderSn: sample[0]!.order.order_sn })
    .mockImplementationOnce((_id, active) => {
      signal = active;
      return new Promise((_, reject) =>
        active.addEventListener("abort", () => reject(active.reason), {
          once: true,
        }),
      );
    });
  const view = createView();
  const { root, native, action, running, exports } = ui(view);
  root.querySelector("dialog")!.showModal();
  native.requestSubmit();
  await vi.waitFor(() => expect(running()).toBe(true));
  await vi.waitFor(() =>
    expect(PddClient.prototype.getOrderDetail).toHaveBeenCalledTimes(2),
  );
  root.querySelector("dialog")!.close();
  expect(signal.aborted).toBe(false);
  root.querySelector("dialog")!.showModal();
  action("停止并保留结果").click();
  expect(signal.aborted).toBe(true);
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  expect(root.querySelector("dialog")!.open).toBe(true);
  expect(action("导出部分 JSON").disabled).toBe(false);
  expect(files.downloadFile).not.toHaveBeenCalled();
});

test("disposing aborts collection and a late page cannot update a replacement view", async () => {
  let resolve!: (page: Order[]) => void;
  let signal!: AbortSignal;
  vi.mocked(PddClient.prototype.getOrders)
    .mockImplementationOnce((_offset, _size, active) => {
      signal = active;
      return new Promise<Order[]>((done) => {
        resolve = done;
      });
    })
    .mockResolvedValue([]);
  const view = createView();
  const previous = ui(view);
  previous.native.requestSubmit();
  await vi.waitFor(() =>
    expect(PddClient.prototype.getOrders).toHaveBeenCalledOnce(),
  );
  view.dispose();
  expect(signal.aborted).toBe(true);
  expect(previous.root.children).toHaveLength(0);
  expect(view.element.isConnected).toBe(false);
  const replacement = createView();
  const fresh = ui(replacement);
  fresh.native.requestSubmit();
  await vi.waitFor(() =>
    expect(fresh.status().textContent).toContain("未找到订单"),
  );
  const message = fresh.status().textContent;
  resolve([{ order_sn: "261017-late", offset: "late" }]);
  await updated();
  expect(fresh.status().textContent).toBe(message);
  expect(fresh.native).not.toBe(previous.native);
  expect(fresh.root.querySelectorAll("dialog")).toHaveLength(1);
  expect(fresh.exports()?.hidden ?? true).toBe(true);
  expect(fresh.running()).toBe(false);
  expect(PddClient.prototype.getOrderDetail).not.toHaveBeenCalled();
});

test("busy updates keep native draft nodes and submit their current values", async () => {
  let release!: () => void;
  vi.mocked(collection.collectOrders).mockImplementation(async function* () {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    yield mockPage(sample);
  });
  const view = createView();
  const { root, native, input, running, exports } = ui(view);
  const action = root.querySelector<HTMLButtonElement>(
    "[data-ui=collect-action]",
  )!;
  expect(action.form).toBe(native);
  expect(native.contains(action)).toBe(false);
  expect(root.querySelector("hr")!.hidden).toBe(true);
  input("pageSize").value = "30";
  native.requestSubmit();
  await vi.waitFor(() => expect(running()).toBe(true));
  expect(input("pageSize").matches(":disabled")).toBe(true);
  expect(action.type).toBe("button");
  expect(action.textContent).toBe("停止并保留结果");
  expect(root.querySelector("progress")!.hasAttribute("value")).toBe(false);
  expect(root.querySelector("hr")!.hidden).toBe(false);
  expect(collection.collectOrders).toHaveBeenCalledWith(
    expect.objectContaining({
      getOrders: expect.any(Function),
      getOrderDetail: expect.any(Function),
    }),
    expect.objectContaining({ pageSize: 30 }),
    expect.any(AbortSignal),
  );
  release();
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  expect(root.querySelector<HTMLFormElement>("form[aria-label]")).toBe(native);
  expect(root.querySelector("[data-ui=collect-action]")).toBe(action);
  expect(action.type).toBe("submit");
  expect(action.textContent).toBe("重新收集");
  expect(input("pageSize").value).toBe("30");
});

test("invalid native fields prevent collection and correction restores it", async () => {
  mockResult();
  const { native, input, exports } = ui(createView());
  input("pageSize").value = "0";
  const requestSettings = input("pageSize").closest("details")!;
  const settings = native.querySelector<HTMLDetailsElement>(
    "[data-ui=collect-settings]",
  )!;
  requestSettings.open = false;
  settings.open = false;
  native.requestSubmit();
  expect(collection.collectOrders).not.toHaveBeenCalled();
  expect(settings.open).toBe(true);
  expect(requestSettings.open).toBe(true);
  input("pageSize").value = "10";
  input("startDate").value = "2026-10-18";
  input("endDate").value = "2026-10-17";
  native.requestSubmit();
  expect(collection.collectOrders).not.toHaveBeenCalled();
  input("endDate").value = "2026-10-19";
  input("endDate").dispatchEvent(new Event("input", { bubbles: true }));
  native.requestSubmit();
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  expect(collection.collectOrders).toHaveBeenCalledOnce();
});

test("result text is escaped and disposal clears the host nodes", async () => {
  mockResult();
  vi.mocked(collection.collectOrders).mockImplementationOnce(
    async function* () {
      throw new PddError("<b>private</b>");
    },
  );
  const view = createView();
  const { root, native, alert, exports } = ui(view);
  native.requestSubmit();
  await vi.waitFor(() =>
    expect(alert().textContent).toContain("<b>private</b>"),
  );
  expect(root.querySelector("b")).toBeNull();
  expect(exports()?.hidden ?? true).toBe(true);
  expect(files.exportFile).not.toHaveBeenCalled();
  view.dispose();
  await updated();
  expect(root.children).toHaveLength(0);
});

test("native drafts and progress nodes survive updates and moving the view", async () => {
  let continueToList!: () => void;
  let finish!: () => void;
  vi.mocked(PddClient.prototype.getOrders)
    .mockResolvedValueOnce([
      { order_sn: "261017-a", offset: "a" },
      { order_sn: "261017-b", offset: "b" },
    ])
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        }),
    );
  vi.mocked(PddClient.prototype.getOrderDetail)
    .mockResolvedValueOnce({ orderSn: "261017-a" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          continueToList = () => resolve({ orderSn: "261017-b" });
        }),
    );
  const view = createView();
  const { root, native, input, action, exports } = ui(view);
  const size = input("pageSize");
  size.value = "30";
  native.requestSubmit();
  await vi.waitFor(() => expect(root.querySelector("progress")).not.toBeNull());
  const progress = root.querySelector("progress")!;
  await vi.waitFor(() =>
    expect(
      root.querySelector("[data-ui=collect-progress]")!.textContent,
    ).toContain("详情 1 笔"),
  );
  expect(progress.value).toBe(1);
  expect(progress.max).toBe(2);
  expect(progress.position).toBe(0.5);
  view.element.remove();
  document.body.append(view.element);
  continueToList();
  await vi.waitFor(() =>
    expect(PddClient.prototype.getOrders).toHaveBeenCalledTimes(2),
  );
  await vi.waitFor(() => expect(progress.hasAttribute("value")).toBe(false));
  expect(progress.position).toBe(-1);
  expect(root.querySelector("progress")).toBe(progress);
  expect(root.querySelector<HTMLFormElement>("form[aria-label]")).toBe(native);
  expect(input("pageSize")).toBe(size);
  expect(size.value).toBe("30");
  finish();
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  expect(input("pageSize")).toBe(size);
  expect(size.value).toBe("30");
  action("导出 CSV").click();
  expect(files.downloadFile).toHaveBeenCalledOnce();
  expect(files.downloadFile).toHaveBeenCalledWith(
    expect.stringMatching(/\.csv$/),
    expect.any(Blob),
  );
});

test.each(["cancel", "dispose"] as const)(
  "%s while a page is finishing does not request the next page",
  async (mode) => {
    let finishPage!: () => void;
    let signal!: AbortSignal;
    const nextPage = vi.fn();
    const entry = sample[0]!;
    vi.mocked(collection.collectOrders).mockImplementationOnce(
      async function* (_source, _options, active) {
        signal = active;
        yield {
          total: 1,
          orders: (async function* () {
            yield entry;
            await new Promise<void>((resolve) => {
              finishPage = resolve;
            });
          })(),
        };
        nextPage();
      },
    );
    const view = createView();
    const { native, action, exports } = ui(view);
    native.requestSubmit();
    await vi.waitFor(() => expect(finishPage).toBeTypeOf("function"));
    if (mode === "cancel") action("停止并保留结果").click();
    else view.dispose();
    expect(signal.aborted).toBe(true);
    finishPage();
    if (mode === "cancel")
      await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
    else await updated();
    expect(nextPage).not.toHaveBeenCalled();
  },
);

test("the action button can stop a newly started task immediately", async () => {
  let signal!: AbortSignal;
  vi.mocked(PddClient.prototype.getOrders).mockImplementationOnce(
    (_cursor, _size, active) => {
      signal = active;
      return new Promise((_, reject) =>
        active.addEventListener("abort", () => reject(active.reason), {
          once: true,
        }),
      );
    },
  );
  const { root, native, running, exports } = ui(createView());
  native.requestSubmit();
  root.querySelector<HTMLButtonElement>("[data-ui=collect-action]")!.click();
  expect(signal.aborted).toBe(true);
  await vi.waitFor(() => {
    expect(running()).toBe(false);
    expect(exports()?.hidden).toBe(true);
  });
});

test("cancel preserves a successful detail arriving after the abort", async () => {
  let resolve!: (detail: { orderSn: string }) => void;
  let signal!: AbortSignal;
  const order: Order = { order_sn: "261017-a", offset: "cursor:a" };
  vi.mocked(PddClient.prototype.getOrders).mockResolvedValue([order]);
  vi.mocked(PddClient.prototype.getOrderDetail).mockImplementationOnce(
    (_id, active) => {
      signal = active;
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  const { root, native, action, exports } = ui(createView());
  native.requestSubmit();
  await vi.waitFor(() =>
    expect(PddClient.prototype.getOrderDetail).toHaveBeenCalledOnce(),
  );
  native.requestSubmit();
  action("停止并保留结果").click();
  expect(signal.aborted).toBe(true);
  resolve({ orderSn: order.order_sn });
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  expect(root.querySelector('[aria-label="收集进度"]')).toBeNull();
  expect(
    root.querySelector('[data-ui="export-result"]')!.textContent,
  ).toContain("已收集 1 笔订单 · 详情 1 笔");
  action("导出部分 JSON").click();
  expect(files.exportFile).toHaveBeenCalledWith(
    [{ order, detail: { orderSn: order.order_sn } }],
    "json",
    null,
    null,
    true,
  );
  expect(PddClient.prototype.getOrders).toHaveBeenCalledOnce();
});

test("a detail failure shows the error without exposing a partial export", async () => {
  const orders: Order[] = [
    { order_sn: "261017-a", offset: "a" },
    { order_sn: "261017-b", offset: "b" },
  ];
  vi.mocked(PddClient.prototype.getOrders).mockResolvedValueOnce(orders);
  vi.mocked(PddClient.prototype.getOrderDetail).mockRejectedValueOnce(
    new PddError("详情暂时不可用"),
  );
  const { native, exports, alert } = ui(createView());
  native.requestSubmit();
  await vi.waitFor(() => expect(alert().textContent).toBe("详情暂时不可用"));
  expect(exports()?.hidden ?? true).toBe(true);
  expect(files.exportFile).not.toHaveBeenCalled();
  expect(files.downloadFile).not.toHaveBeenCalled();
});

test("import and resume preserve successful details and never fetch the order list", async () => {
  const entries: CollectedOrder[] = [
    {
      order: { order_sn: "261017-a", offset: "a" },
      detail: { orderSn: "261017-a", keep: "original" },
    },
    {
      order: { order_sn: "261017-b", offset: "b" },
      detail: null,
      detailFailure: "unavailable",
    },
    {
      order: { order_sn: "261017-c", offset: "c" },
      detail: null,
      detailFailure: "paused",
    },
  ];
  const { root, action } = ui(createView());
  const upload = root.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([], "saved.json", { type: "application/json" });
  Object.defineProperty(file, "text", {
    value: async () => JSON.stringify(entries),
  });
  Object.defineProperty(upload, "files", { value: [file], configurable: true });
  upload.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() =>
    expect(root.textContent).toContain("保留详情 1 笔 · 待补 2 笔"),
  );
  expect(PddClient.prototype.getOrders).not.toHaveBeenCalled();
  expect(PddClient.prototype.getOrderDetail).not.toHaveBeenCalled();
  action("仅补齐缺失的 2 笔详情").click();
  await vi.waitFor(() =>
    expect(root.textContent).toContain("导入订单的详情已齐全。"),
  );
  expect(PddClient.prototype.getOrders).not.toHaveBeenCalled();
  expect(
    vi.mocked(PddClient.prototype.getOrderDetail).mock.calls.map(([id]) => id),
  ).toEqual(["261017-b", "261017-c"]);
  action("导出 JSON").click();
  expect(files.exportFile).toHaveBeenCalledWith(
    [
      entries[0],
      { order: entries[1]!.order, detail: { orderSn: "261017-b" } },
      { order: entries[2]!.order, detail: { orderSn: "261017-c" } },
    ],
    "json",
    null,
    null,
    false,
    true,
  );
  const invalid = new File([], "invalid.json");
  Object.defineProperty(invalid, "text", {
    value: async () => "private invalid input",
  });
  Object.defineProperty(upload, "files", {
    value: [invalid],
    configurable: true,
  });
  upload.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() =>
    expect(root.textContent).toContain("已有结果已保留。"),
  );
  expect(root.textContent).not.toContain("private invalid input");
  expect(root.textContent).toContain(
    "已有 3 笔订单 · 保留详情 3 笔 · 待补 0 笔",
  );
});

test("unavailable details keep list results and show explicit detail incompleteness", async () => {
  const orders: Order[] = Array.from({ length: 4 }, (_, index) => ({
    order_sn: `261017-${index}`,
    offset: String(index),
  }));
  vi.mocked(PddClient.prototype.getOrders).mockResolvedValueOnce(orders);
  vi.mocked(PddClient.prototype.getOrderDetail).mockRejectedValue(
    new PddError("private response must stay hidden", "detail-unavailable"),
  );
  const { root, native, status, action } = ui(createView());
  native.requestSubmit();
  await vi.waitFor(() =>
    expect(status().textContent).toBe("订单列表收集完成，详情不完整。"),
  );
  expect(root.textContent).toContain("已收集 4 笔订单 · 详情 0 笔");
  expect(root.textContent).toContain("4 笔订单缺少详情");
  expect(root.textContent).not.toContain("private response");
  action("导出 JSON（详情不完整）").click();
  expect(files.exportFile).toHaveBeenCalledWith(
    orders.map((order) => ({
      order,
      detail: null,
      detailFailure: "unavailable",
    })),
    "json",
    null,
    null,
    false,
  );
  expect(PddClient.prototype.getOrderDetail).toHaveBeenCalledTimes(4);
});

test("date filtering keeps an unrecognizable order after a successful page and explains its date uncertainty", async () => {
  const first: Order = { order_sn: "261017-a", offset: "a" };
  const unknown: Order = { order_sn: "legacy-order", offset: "b" };
  vi.mocked(PddClient.prototype.getOrders)
    .mockResolvedValueOnce([first])
    .mockResolvedValueOnce([unknown]);
  const { root, native, input, running, alert, action } = ui(createView());
  input("startDate").value = "2026-10-01";
  input("endDate").value = "2026-10-31";
  native.requestSubmit();
  await vi.waitFor(() =>
    expect(
      vi.mocked(PddClient.prototype.getOrders).mock.calls.length,
    ).toBeGreaterThanOrEqual(2),
  );
  await vi.waitFor(() => expect(running()).toBe(false));
  expect(alert().textContent).toBe("");
  expect(PddClient.prototype.getOrders).toHaveBeenCalledTimes(3);
  expect(
    root.querySelector('[data-ui="export-result"]')!.textContent,
  ).toContain("1 笔订单无法按编号核对日期");
  action("导出 JSON").click();
  expect(files.exportFile).toHaveBeenCalledWith(
    [
      { order: first, detail: { orderSn: first.order_sn } },
      {
        order: unknown,
        detail: { orderSn: unknown.order_sn },
        dateUncertain: true,
      },
    ],
    "json",
    new Date("2026-10-01"),
    new Date("2026-10-31"),
    false,
  );
});

test.each(["detail", "list", "unknown detail"] as const)(
  "a mid-collection %s failure keeps completed orders available as a partial export",
  async (stage) => {
    const order: Order = { order_sn: "261017-a", offset: "a" };
    const detail = { orderSn: order.order_sn };
    const failure =
      stage === "unknown detail"
        ? new TypeError("private URL and token")
        : new PddError("请求暂时失败。");
    vi.mocked(PddClient.prototype.getOrders).mockResolvedValueOnce(
      stage !== "list"
        ? [order, { order_sn: "261017-b", offset: "b" }]
        : [order],
    );
    vi.mocked(PddClient.prototype.getOrderDetail).mockResolvedValueOnce(detail);
    if (stage !== "list") {
      vi.mocked(PddClient.prototype.getOrderDetail).mockRejectedValueOnce(
        failure,
      );
    } else {
      vi.mocked(PddClient.prototype.getOrders).mockRejectedValueOnce(failure);
    }
    const { root, native, exports, alert, action } = ui(createView());
    native.requestSubmit();
    await vi.waitFor(() =>
      expect(alert().textContent).toBe(
        stage === "unknown detail"
          ? "读取第 1 页第 2 笔订单详情时发生异常（TypeError），请保留此提示以便排查。"
          : failure.message,
      ),
    );
    expect(root.textContent).not.toContain("private URL and token");
    expect(exports()?.hidden ?? true).toBe(false);
    expect(
      root.querySelector('[data-ui="export-result"]')!.textContent,
    ).toContain("结果不完整");
    expect(files.downloadFile).not.toHaveBeenCalled();
    action("导出部分 JSON").click();
    expect(files.exportFile).toHaveBeenCalledWith(
      [{ order, detail }],
      "json",
      null,
      null,
      true,
    );
    expect(files.downloadFile).toHaveBeenCalledOnce();
  },
);

test("a CSV failure uses a native alert and JSON retry retains the result", async () => {
  const result = mockResult();
  vi.mocked(files.exportFile).mockImplementationOnce(() => {
    throw new Error("private diagnostic");
  });
  const { root, native, action, exports } = ui(createView());
  native.requestSubmit();
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  action("导出 CSV").click();
  expect(globalThis.alert).toHaveBeenCalledExactlyOnceWith(
    "CSV 生成失败，请尝试导出 JSON。",
  );
  expect(root.textContent).not.toContain("private diagnostic");
  expect(exports()?.hidden ?? true).toBe(false);
  expect(files.downloadFile).not.toHaveBeenCalled();
  action("导出 JSON").click();
  expect(globalThis.alert).toHaveBeenCalledOnce();
  expect(files.exportFile).toHaveBeenLastCalledWith(
    result,
    "json",
    null,
    null,
    false,
  );
  expect(files.downloadFile).toHaveBeenCalledOnce();
  expect(collection.collectOrders).toHaveBeenCalledOnce();
});

test("a failed download can be retried without repeating collection", async () => {
  mockResult();
  vi.mocked(files.downloadFile).mockImplementationOnce(() => {
    throw new Error("blocked");
  });
  const { native, action, exports } = ui(createView());
  native.requestSubmit();
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  action("导出 JSON").click();
  expect(globalThis.alert).toHaveBeenCalledExactlyOnceWith(
    "无法发起下载，请检查浏览器下载权限后重试。",
  );
  expect(exports()?.hidden ?? true).toBe(false);
  action("导出 JSON").click();
  expect(globalThis.alert).toHaveBeenCalledOnce();
  expect(files.downloadFile).toHaveBeenCalledTimes(2);
  expect(collection.collectOrders).toHaveBeenCalledOnce();
});

test("collection failure hides private diagnostics and a fresh attempt restores the UI", async () => {
  mockResult();
  vi.mocked(collection.collectOrders).mockImplementationOnce(
    async function* () {
      throw new Error("private URL and token");
    },
  );
  const { root, native, exports, alert } = ui(createView());
  native.requestSubmit();
  await vi.waitFor(() =>
    expect(alert().textContent).toBe(
      "检查收集设置时发生异常（Error），请保留此提示以便排查。",
    ),
  );
  expect(root.textContent).not.toContain("private URL and token");
  expect(exports()?.hidden ?? true).toBe(true);
  expect(files.exportFile).not.toHaveBeenCalled();
  native.requestSubmit();
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  expect(alert().hidden).toBe(true);
  expect(collection.collectOrders).toHaveBeenCalledTimes(2);
});

test("a failed session retry retains the result and fresh collection clears the collection error", async () => {
  const result = mockResult();
  const { native, action, exports, alert, status } = ui(createView());
  native.requestSubmit();
  await vi.waitFor(() => expect(exports()?.hidden ?? true).toBe(false));
  action("导出 JSON").click();
  expect(files.downloadFile).toHaveBeenCalledOnce();
  document.cookie = "pdd_user_id=; max-age=0; path=/";
  native.requestSubmit();
  await vi.waitFor(() => expect(alert().textContent).toContain("用户标识"));
  expect(exports()?.hidden ?? true).toBe(false);
  expect(collection.collectOrders).toHaveBeenCalledOnce();
  action("导出 JSON").click();
  expect(files.exportFile).toHaveBeenLastCalledWith(
    result,
    "json",
    null,
    null,
    false,
  );
  document.cookie = "pdd_user_id=123; path=/";
  native.requestSubmit();
  await vi.waitFor(() =>
    expect(collection.collectOrders).toHaveBeenCalledTimes(2),
  );
  await vi.waitFor(() => expect(status().textContent).toBe("收集完成。"));
  expect(exports()?.hidden ?? true).toBe(false);
  expect(alert().hidden).toBe(true);
  expect(files.downloadFile).toHaveBeenCalledTimes(2);
});
