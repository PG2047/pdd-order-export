// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mobile.pinduoduo.com/orders.html"}
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { PddClient } from "../../src/pdd";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("scheduler", {
    postTask(
      callback: () => unknown,
      { delay = 0, signal }: SchedulerPostTaskOptions = {},
    ) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          reject(signal!.reason);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          try {
            resolve(callback());
          } catch (error) {
            reject(error);
          }
        }, delay);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  });
});
afterEach(() => {
  document.cookie = "pdd_user_id=; Max-Age=0; Path=/";
  document.cookie = "pdd_user_id=; Max-Age=0; Path=/orders.html";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const client = (fetch: typeof globalThis.fetch) => {
  vi.stubGlobal("fetch", fetch);
  document.cookie = "pdd_user_id=123; Path=/";
  return new PddClient();
};

test.each([new Error("custom cancellation"), "cancelled"])(
  "cancelling the initial wait preserves the abort reason: %s",
  async (reason) => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    const pending = client(fetcher)
      .getOrders(null, 10, controller.signal)
      .catch((error) => error);
    controller.abort(reason);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("cancelling an in-flight request preserves its reason without retrying", async () => {
  const controller = new AbortController();
  const reason = new Error("stop this request");
  const fetcher = vi.fn<typeof fetch>(
    (_url, options) =>
      new Promise((_, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => reject(options!.signal!.reason),
          { once: true },
        );
      }),
  );
  const pending = client(fetcher)
    .getOrders(null, 10, controller.signal)
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(600);
  expect(fetcher).toHaveBeenCalledOnce();
  controller.abort(reason);
  await vi.runAllTimersAsync();
  expect(await pending).toBe(reason);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("pending response cleanup cannot prevent cancellation", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    cancel: () => new Promise<void>(() => {}),
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(body, { status: 503 }));
  let failure: unknown;
  const pending = client(fetcher)
    .getOrders(null, 10, controller.signal)
    .catch((error) => {
      failure = error;
    });
  await vi.advanceTimersByTimeAsync(600);
  controller.abort();
  await vi.runAllTimersAsync();
  expect(failure).toBe(controller.signal.reason);
  await pending;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test("retries only transport/server failures, preserving the original request across attempts", async () => {
  const discarded = new Response("temporary failure", { status: 503 });
  const cancelBody = vi.spyOn(discarded.body!, "cancel");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(discarded)
    .mockResolvedValueOnce(Response.json({ orders: [] }));
  const signal = new AbortController().signal;
  const pending = client(fetcher).getOrders("opaque", 10, signal);
  await vi.runAllTimersAsync();
  expect(await pending).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(cancelBody).toHaveBeenCalledOnce();
  for (const [, request] of fetcher.mock.calls) {
    expect(request).toMatchObject({
      signal,
      credentials: "include",
      redirect: "error",
      method: "POST",
      body: '{"size":10,"offset":"opaque"}',
    });
  }
  expect(vi.getTimerCount()).toBe(0);
});

test("response cleanup failure does not prevent retries or replace the final HTTP error", async () => {
  const discarded = new Response("temporary failure", { status: 503 });
  vi.spyOn(discarded.body!, "cancel").mockRejectedValue(new Error("cleanup"));
  const final = new Response("private upstream details", { status: 503 });
  const cancelFinal = vi.spyOn(final.body!, "cancel");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(discarded)
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(final);
  const pending = expect(
    client(fetcher).getOrders(null, 10, new AbortController().signal),
  ).rejects.toMatchObject({
    code: "request",
    message: "请求失败（HTTP 503），请稍后再试。",
  });
  await vi.runAllTimersAsync();
  await pending;
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(cancelFinal).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("aborting backoff settles immediately and leaves no retry timer or request behind", async () => {
  const controller = new AbortController();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 503 }));
  const pending = expect(
    client(fetcher).getOrders(null, 10, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(600);
  expect(fetcher).toHaveBeenCalledOnce();
  controller.abort();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
  expect(fetcher).toHaveBeenCalledOnce();
});

test("an HTML detail for a different order and a login failure both stop without retrying", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        '<script>window.rawData={"data":{"orderSn":"wrong"}};</script>',
      ),
    );
  const wrong = expect(
    client(fetcher).getOrderDetail("261017-a", new AbortController().signal),
  ).rejects.toMatchObject({ code: "schema" });
  await vi.runAllTimersAsync();
  await wrong;
  fetcher.mockResolvedValueOnce(
    new Response("private error body", { status: 401 }),
  );
  const denied = expect(
    client(fetcher).getOrders(null, 10, new AbortController().signal),
  ).rejects.toMatchObject({ code: "session" });
  await vi.runAllTimersAsync();
  await denied;
  expect(fetcher).toHaveBeenCalledTimes(2);
  document.cookie = "pdd_user_id=1; Path=/";
  document.cookie = "pdd_user_id=2; Path=/orders.html";
  expect(() => new PddClient()).toThrow();
});

test("rejects JavaScript expressions inside rawData without executing them", async () => {
  vi.stubGlobal("__pddProbe", false);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        '<script>window.rawData={"data":{"orderSn":"' +
          "261017-a" +
          '","probe":(globalThis.__pddProbe=true)}};</script>',
      ),
    );
  const pending = expect(
    client(fetcher).getOrderDetail("261017-a", new AbortController().signal),
  ).rejects.toMatchObject({ code: "detail-unavailable" });
  await vi.runAllTimersAsync();
  await pending;
  expect(Reflect.get(globalThis, "__pddProbe")).toBe(false);
  expect(fetcher).toHaveBeenCalledOnce();
});
