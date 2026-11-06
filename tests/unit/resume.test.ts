import { expect, test, vi } from "vitest";
import { importOrders, resumeOrderDetails } from "../../src/resume";
import type { CollectedOrder } from "../../src/collect";
import { PddError } from "../../src/pdd";

function input(): CollectedOrder[] {
  return Array.from({ length: 23 }, (_, index) => ({
    order: {
      order_sn: `261017-${index}`,
      offset: String(index),
      original: true,
    },
    detail: index < 15 ? { orderSn: `261017-${index}`, original: true } : null,
    ...(index >= 15 ? { detailFailure: "paused" as const } : {}),
  }));
}

test("resuming missing details preserves existing successes and order positions without reading the list", async () => {
  const original = input();
  const before = structuredClone(original);
  const result = [...original];
  const source = {
    getOrderDetail: vi.fn(async (id: string) => ({
      orderSn: id,
      recovered: true,
    })),
    getOrders: vi.fn(),
  };
  for await (const update of resumeOrderDetails(
    source,
    original,
    new AbortController().signal,
  )) {
    result[update.index] = update.entry;
  }
  expect(source.getOrderDetail.mock.calls.map(([id]) => id)).toEqual(
    original.slice(15).map((entry) => entry.order.order_sn),
  );
  expect(source.getOrders).not.toHaveBeenCalled();
  expect(result).toHaveLength(23);
  expect(result.map((entry) => entry.order)).toEqual(
    before.map((entry) => entry.order),
  );
  for (let index = 0; index < 15; index++)
    expect(result[index]).toBe(original[index]);
  expect(original).toEqual(before);
  expect(
    result.every((entry) => entry.detail !== null && !entry.detailFailure),
  ).toBe(true);
});

test("three unavailable details do not skip later missing entries in an explicit resume", async () => {
  const original = input().slice(15, 20);
  const result = [...original];
  let requested = 0;
  const source = {
    getOrderDetail: vi.fn(async (id: string) => {
      if (++requested <= 3)
        throw new PddError("missing detail", "detail-unavailable");
      return { orderSn: id };
    }),
  };
  for await (const update of resumeOrderDetails(
    source,
    original,
    new AbortController().signal,
  ))
    result[update.index] = update.entry;
  expect(source.getOrderDetail).toHaveBeenCalledTimes(5);
  expect(
    result.slice(0, 3).every((entry) => entry.detailFailure === "unavailable"),
  ).toBe(true);
  expect(result.slice(3).every((entry) => entry.detail !== null)).toBe(true);
});

test.each(["session", "request", "schema"] as const)(
  "a %s error stops resume and leaves saved and pending entries intact",
  async (code) => {
    const original = input();
    const result = [...original];
    const error = new PddError("stop", code);
    const source = {
      getOrderDetail: vi
        .fn()
        .mockResolvedValueOnce({ orderSn: original[15]!.order.order_sn })
        .mockRejectedValueOnce(error),
    };
    await expect(
      (async () => {
        for await (const update of resumeOrderDetails(
          source,
          original,
          new AbortController().signal,
        ))
          result[update.index] = update.entry;
      })(),
    ).rejects.toBe(error);
    expect(source.getOrderDetail).toHaveBeenCalledTimes(2);
    expect(result[15]!.detail).not.toBeNull();
    expect(result[16]).toBe(original[16]);
    expect(result[22]).toBe(original[22]);
    expect(result.slice(0, 15)).toEqual(original.slice(0, 15));
  },
);

test("cancellation preserves completed updates and issues no next request", async () => {
  const original = input();
  const controller = new AbortController();
  const source = {
    getOrderDetail: vi.fn(async (id: string) => ({ orderSn: id })),
  };
  const stream = resumeOrderDetails(source, original, controller.signal);
  expect((await stream.next()).value).toMatchObject({ index: 15 });
  controller.abort();
  await expect(stream.next()).rejects.toBe(controller.signal.reason);
  expect(source.getOrderDetail).toHaveBeenCalledOnce();
});

test("import validates the exported array while preserving raw fields and failure markers", () => {
  const original = input();
  expect(importOrders(JSON.stringify(original))).toEqual(original);
  expect(() => importOrders("not JSON")).toThrow(SyntaxError);
  expect(() => importOrders('{"orders":[]}')).toThrow("JSON 订单数组");
  expect(() => importOrders('[{"order":{},"detail":null}]')).toThrow(
    "JSON 订单数组",
  );
});
