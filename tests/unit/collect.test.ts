import { expect, test, vi } from "vitest";
import { collectOrders } from "../../src/collect";
import type { CollectedOrder } from "../../src/collect";
import { PddError, type Order } from "../../src/pdd";
const options: Parameters<typeof collectOrders>[1] = {
  startDate: null,
  endDate: null,
  pageSize: 10,
  maxPages: 10,
  includeDetails: true,
};
const signal = new AbortController().signal;

test("collection leaves caller-owned UTC dates unchanged", async () => {
  const startDate = new Date("2026-10-17");
  const endDate = new Date("2026-10-17");
  const api = source([[order("261017-a"), order("261016-old")]]);
  const entries = await drain(
    collectOrders(api, { ...options, startDate, endDate }, signal),
  );
  expect(entries.map((entry) => entry.order.order_sn)).toEqual(["261017-a"]);
  expect(startDate.toISOString()).toBe("2026-10-17T00:00:00.000Z");
  expect(endDate.toISOString()).toBe("2026-10-17T00:00:00.000Z");
});

test("page counts accept the full uint32 range", async () => {
  expect(
    await drain(
      collectOrders(source([]), { ...options, maxPages: 2 ** 32 - 1 }, signal),
    ),
  ).toEqual([]);
  for (const maxPages of [-1, 1.5, 2 ** 32, Infinity, NaN]) {
    await expect(
      collectOrders(source([]), { ...options, maxPages }, signal).next(),
    ).rejects.toThrow();
  }
});

test("zero pages make no requests and zero page size is forwarded", async () => {
  const api = source([]);
  expect(
    await drain(collectOrders(api, { ...options, maxPages: 0 }, signal)),
  ).toEqual([]);
  expect(api.getOrders).not.toHaveBeenCalled();
  expect(
    await drain(collectOrders(api, { ...options, pageSize: 0 }, signal)),
  ).toEqual([]);
  expect(api.getOrders).toHaveBeenCalledWith(null, 0, signal);
});

function order(id = "261017-a", fields: Record<string, unknown> = {}): Order {
  return { order_sn: id, offset: "cursor:" + id, ...fields };
}
function source(pages: Order[][]) {
  let index = 0;
  return {
    getOrders: vi.fn(
      async (_cursor: string | null, _size: number, active: AbortSignal) => {
        active.throwIfAborted();
        return pages[index++] ?? [];
      },
    ),
    getOrderDetail: vi.fn(async (id: string, active: AbortSignal) => {
      active.throwIfAborted();
      return { orderSn: id, marker: id };
    }),
  };
}
async function nextPage(stream: ReturnType<typeof collectOrders>) {
  const step = await stream.next();
  if (step.done) throw new Error("Expected another page");
  return step.value;
}
async function drain(stream: ReturnType<typeof collectOrders>) {
  const entries: CollectedOrder[] = [];
  for await (const { orders: page } of stream)
    for await (const entry of page) entries.push(entry);
  return entries;
}

test("both paging and details advance lazily with an explicit page total", async () => {
  const api = source([
    [order("261017-a"), order("261017-b")],
    [order("261016-c")],
  ]);
  const pages = collectOrders(api, options, signal);
  expect(api.getOrders).not.toHaveBeenCalled();
  const { total, orders: page } = await nextPage(pages);
  expect(total).toBe(2);
  expect(api.getOrders).toHaveBeenCalledOnce();
  expect(api.getOrderDetail).not.toHaveBeenCalled();
  expect("entries" in page).toBe(false);
  const first = await page.next();
  expect(first.value).toMatchObject({
    order: { order_sn: "261017-a" },
    detail: { marker: "261017-a" },
  });
  expect(api.getOrderDetail).toHaveBeenCalledTimes(1);
  expect(api.getOrders).toHaveBeenCalledTimes(1);
  await page.return();
  await pages.return();
  expect(api.getOrderDetail).toHaveBeenCalledTimes(1);
  expect(api.getOrders).toHaveBeenCalledTimes(1);
});

test("skipping an inner iterator fetches no detail and outer cursors remain opaque", async () => {
  const first = order("261017-a", { offset: "opaque/not-an-order-id" });
  const api = source([[first], [order("261016-b")]]);
  const pages = collectOrders(api, options, signal);
  await nextPage(pages);
  const { orders: page } = await nextPage(pages);
  expect(api.getOrderDetail).not.toHaveBeenCalled();
  expect(api.getOrders.mock.calls).toEqual([
    [null, 10, signal],
    [first.offset, 10, signal],
  ]);
  await page.next();
  expect(api.getOrderDetail).toHaveBeenCalledWith("261016-b", signal);
  await pages.return();
});

test("page totals count selected orders without reading details ahead", async () => {
  const api = source([
    [order("261018-new"), order("261017-kept"), order("261016-old")],
  ]);
  const pages = collectOrders(
    api,
    {
      ...options,
      startDate: new Date("2026-10-17"),
      endDate: new Date("2026-10-17"),
    },
    signal,
  );
  const { total, orders: page } = await nextPage(pages);
  expect(total).toBe(1);
  expect(api.getOrderDetail).not.toHaveBeenCalled();
  expect((await page.next()).value).toMatchObject({
    order: { order_sn: "261017-kept" },
  });
  expect((await page.next()).done).toBe(true);
  expect((await pages.next()).done).toBe(true);
  expect(api.getOrders).toHaveBeenCalledOnce();
});

test("an empty selection has a zero total and can advance to the next page", async () => {
  const api = source([[order("261018-new")], [order("261017-kept")]]);
  const pages = collectOrders(
    api,
    { ...options, endDate: new Date("2026-10-17") },
    signal,
  );
  const { total: emptyTotal, orders: empty } = await nextPage(pages);
  expect(emptyTotal).toBe(0);
  expect((await empty.next()).done).toBe(true);
  expect(api.getOrderDetail).not.toHaveBeenCalled();
  const { total, orders: page } = await nextPage(pages);
  expect(total).toBe(1);
  expect((await page.next()).value).toMatchObject({
    order: { order_sn: "261017-kept" },
  });
  await page.return();
  await pages.return();
});

test("descending dates preserve inclusive bounds and stop further paging", async () => {
  const first = order("261017-a"),
    last = order("261016-b");
  const api = source([
    [order("261018-new"), first],
    [last, order("261015-old"), order("261014-unvisited")],
  ]);
  const entries = await drain(
    collectOrders(
      api,
      {
        ...options,
        startDate: new Date("2026-10-16"),
        endDate: new Date("2026-10-17"),
      },
      signal,
    ),
  );
  expect(entries.map((e) => e.order.order_sn)).toEqual([
    first.order_sn,
    last.order_sn,
  ]);
  expect(api.getOrders).toHaveBeenCalledTimes(2);
  expect(api.getOrderDetail.mock.calls.map(([id]) => id)).toEqual([
    first.order_sn,
    last.order_sn,
  ]);
});

test("an already aborted signal reaches the client and preserves its reason", async () => {
  const api = source([[order()]]),
    reason = new Error("stop");
  const active = AbortSignal.abort(reason);
  await expect(collectOrders(api, options, active).next()).rejects.toBe(reason);
  expect(api.getOrders).toHaveBeenCalledWith(null, 10, active);
});

test("the consumer retains yielded entries and breaks without fetching remaining details", async () => {
  const controller = new AbortController();
  const api = source([[order("261017-a"), order("261017-b")]]);
  const saved: CollectedOrder[] = [];
  pages: for await (const { orders: page } of collectOrders(
    api,
    options,
    controller.signal,
  )) {
    for await (const entry of page) {
      saved.push(entry);
      controller.abort();
      break pages;
    }
  }
  expect(saved.map((e) => e.order.order_sn)).toEqual(["261017-a"]);
  expect(api.getOrderDetail).toHaveBeenCalledOnce();
  expect(api.getOrders).toHaveBeenCalledOnce();
});

test("cancellation during a detail request throws without generating a partial entry", async () => {
  const controller = new AbortController();
  const api = source([
    [order("261017-a"), order("261017-b"), order("261017-c")],
  ]);
  api.getOrderDetail
    .mockResolvedValueOnce({ orderSn: "261017-a", marker: "kept" })
    .mockImplementationOnce(async (_id, active) => {
      controller.abort();
      active.throwIfAborted();
      return { orderSn: "unreachable", marker: "unreachable" };
    });
  const { orders: page } = await nextPage(
    collectOrders(api, options, controller.signal),
  );
  const first = await page.next();
  await expect(page.next()).rejects.toBe(controller.signal.reason);
  expect(first.value).toMatchObject({ detail: { marker: "kept" } });
  expect(api.getOrderDetail).toHaveBeenCalledTimes(2);
});

test.each(["request", "session", "schema"] as const)(
  "%s detail failures propagate unchanged and start no subsequent requests",
  async (code) => {
    const api = source([[order(), order("261017-b")]]),
      error = new PddError("detail unavailable", code);
    api.getOrderDetail.mockRejectedValueOnce(error);
    await expect(drain(collectOrders(api, options, signal))).rejects.toBe(
      error,
    );
    expect(api.getOrderDetail).toHaveBeenCalledOnce();
    expect(api.getOrders).toHaveBeenCalledOnce();
  },
);

test("consecutive unavailable details across pages never skip remaining detail requests", async () => {
  const orders = ["a", "b", "c", "d", "e"].map((id) => order(`261017-${id}`));
  const api = source([orders.slice(0, 2), orders.slice(2, 4), orders.slice(4)]);
  api.getOrderDetail.mockRejectedValue(
    new PddError("missing rawData", "detail-unavailable"),
  );
  const entries = await drain(collectOrders(api, options, signal));
  expect(entries.map((entry) => entry.order)).toEqual(orders);
  expect(entries.map((entry) => entry.detailFailure)).toEqual([
    "unavailable",
    "unavailable",
    "unavailable",
    "unavailable",
    "unavailable",
  ]);
  expect(entries.every((entry) => entry.detail === null)).toBe(true);
  expect(api.getOrderDetail).toHaveBeenCalledTimes(5);
  expect(api.getOrders).toHaveBeenCalledTimes(4);
});

test("intermittent unavailable details preserve later successful details", async () => {
  const orders = Array.from({ length: 6 }, (_, index) =>
    order(`261017-${index}`),
  );
  const api = source([orders.slice(0, 3), orders.slice(3)]);
  api.getOrderDetail.mockImplementation(async (id) => {
    if (id !== "261017-2" && id !== "261017-5") {
      throw new PddError("missing rawData", "detail-unavailable");
    }
    return { orderSn: id, marker: id };
  });
  const entries = await drain(collectOrders(api, options, signal));
  expect(entries.map((entry) => entry.order)).toEqual(orders);
  expect(entries.filter((entry) => entry.detail !== null)).toHaveLength(2);
  expect(entries.some((entry) => entry.detailFailure === "paused")).toBe(false);
  expect(api.getOrderDetail).toHaveBeenCalledTimes(6);
});

test.each([true, false])(
  "unknown or invalid order dates are retained and flagged (details=%s)",
  async (includeDetails) => {
    const unknown = order("not-a-date");
    const invalid = order("261332-invalid");
    const valid = order("261017-valid");
    const api = source([[unknown, invalid, valid]]);
    const entries = await drain(
      collectOrders(
        api,
        { ...options, includeDetails, startDate: new Date("2026-10-01") },
        signal,
      ),
    );
    expect(entries.map((entry) => entry.order)).toEqual([
      unknown,
      invalid,
      valid,
    ]);
    expect(entries.map((entry) => entry.dateUncertain)).toEqual([
      true,
      true,
      undefined,
    ]);
    expect(api.getOrderDetail).toHaveBeenCalledTimes(includeDetails ? 3 : 0);
    expect(
      entries.every((entry) => includeDetails || entry.detail === null),
    ).toBe(true);
  },
);

test("list-only iteration accepts opaque IDs and consumer break needs no detail request", async () => {
  const api = source([[order("not-a-date"), order("another")]]);
  const saved: CollectedOrder[] = [];
  pages: for await (const { orders: page } of collectOrders(
    api,
    { ...options, includeDetails: false },
    signal,
  )) {
    for await (const entry of page) {
      saved.push(entry);
      break pages;
    }
  }
  expect(saved).toEqual([{ order: order("not-a-date"), detail: null }]);
  expect(api.getOrderDetail).not.toHaveBeenCalled();
  expect(api.getOrders).toHaveBeenCalledOnce();
});

test("page caps avoid extra requests and invalid page sizes fail before requests", async () => {
  const api = source([[order()], [order("261016-b")]]);
  expect(
    await drain(collectOrders(api, { ...options, maxPages: 1 }, signal)),
  ).toHaveLength(1);
  expect(api.getOrders).toHaveBeenCalledOnce();
  await expect(
    collectOrders(api, { ...options, pageSize: 51 }, signal).next(),
  ).rejects.toThrow();
  expect(api.getOrders).toHaveBeenCalledOnce();
});

test("independent iterators start with fresh cursors and signals", async () => {
  const api = source([[order()], [order("261017-b")]]);
  const previous = collectOrders(api, options, signal);
  await nextPage(previous);
  await previous.return();
  const nextSignal = new AbortController().signal;
  const second = await drain(collectOrders(api, options, nextSignal));
  expect(second[0]!.order.order_sn).toBe("261017-b");
  expect(api.getOrders).toHaveBeenNthCalledWith(2, null, 10, nextSignal);
});
