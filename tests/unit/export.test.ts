// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { exportFile, downloadFile } from "../../src/export";
import type { CollectedOrder } from "../../src/collect";
import { parse } from "papaparse";

beforeEach(() => vi.stubGlobal("Blob", NodeBlob));
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const root = join(import.meta.dirname, "../fixtures/orders");
const cases = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = join(root, entry.name);
    const files = readdirSync(directory);
    const success = files.includes("exported.csv");
    const failure = files.includes("thrown.json");
    if (success && failure) {
      throw new Error(
        entry.name + ": exported.csv and thrown.json are mutually exclusive",
      );
    }
    return { name: entry.name, directory, success, failure };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
if (!cases.length) {
  throw new Error("No export regression cases found");
}

test.each(
  cases.flatMap((entry) =>
    [false, true].map((partial) => ({ ...entry, partial })),
  ),
)(
  "$name (partial=$partial): export expectations",
  async ({ directory, success, failure, partial }) => {
    const input: readonly CollectedOrder[] = JSON.parse(
      readFileSync(join(directory, "collected.json"), "utf8"),
    );
    const before = structuredClone(input);
    if (success) {
      const actual = exportFile(input, "csv", null, null, partial);
      expect(actual.blob.type).toBe("text/csv;charset=utf-8");
      const bytes = Buffer.from(await actual.blob.arrayBuffer());
      const expected = readFileSync(join(directory, "exported.csv"), "utf8");
      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([239, 187, 191]));
      expect(bytes.subarray(3).toString("utf8").replaceAll("\r\n", "\n")).toBe(
        expected.replaceAll("\r\n", "\n"),
      );
      expect(actual.name.endsWith("_不完整.csv")).toBe(partial);
    } else if (failure) {
      // Resolve the error as data so a successful export also fails these assertions.
      const error: unknown = (() => {
        try {
          return exportFile(input, "csv", null, null, partial);
        } catch (error) {
          return error;
        }
      })();
      expect(error).toBeInstanceOf(Error);
      const expected = JSON.parse(
        readFileSync(join(directory, "thrown.json"), "utf8"),
      );
      expect(error).toMatchObject(expected);
    }
    expect(input).toEqual(before);
    const json = exportFile(input, "json", null, null, partial);
    expect(json.blob.type).toBe("application/json;charset=utf-8");
    expect(json.name.endsWith(partial ? "_不完整.json" : ".json")).toBe(true);
    expect(JSON.parse(await json.blob.text())).toEqual(before);
  },
);

test("exports identify orders whose selected date range could not be checked", async () => {
  const entries: CollectedOrder[] = [
    { order: { order_sn: "261017-a", offset: "a" }, detail: null },
    {
      order: { order_sn: "legacy-order", offset: "b" },
      detail: null,
      dateUncertain: true,
    },
  ];
  const csv = await exportFile(entries, "csv", null, null).blob.text();
  const parsed = parse<Record<string, string>>(csv, { header: true });
  expect(parsed.errors).toEqual([]);
  expect(parsed.data.map((row) => [row.订单编号, row.日期核对])).toEqual([
    ["261017-a", ""],
    ["legacy-order", "日期待核对"],
  ]);
  const json = await exportFile(entries, "json", null, null).blob.text();
  expect(JSON.parse(json)).toEqual(entries);
});

test("exports distinguish missing details from an interrupted order list", async () => {
  const entries: CollectedOrder[] = [
    { order: { order_sn: "a", offset: "a" }, detail: { orderSn: "a" } },
    {
      order: { order_sn: "b", offset: "b" },
      detail: null,
      detailFailure: "unavailable",
    },
    {
      order: { order_sn: "c", offset: "c" },
      detail: null,
      detailFailure: "paused",
    },
  ];
  const csv = exportFile(entries, "csv", null, null);
  expect(csv.name).toBe("拼多多账单_不限至不限_详情不完整.csv");
  const rows = parse<Record<string, string>>(await csv.blob.text(), {
    header: true,
  }).data;
  expect(rows.map((row) => [row.订单编号, row.详情状态])).toEqual([
    ["a", "已获取"],
    ["b", "详情未能解析"],
    ["c", "详情已暂停读取"],
  ]);
  expect(exportFile(entries, "json", null, null, true).name).toBe(
    "拼多多账单_不限至不限_不完整.json",
  );
});

test.each([
  {
    start: "2026-10-01",
    end: "2026-10-17",
    partial: false,
    expected: "拼多多账单_2026-10-01至2026-10-17",
  },
  {
    start: "2026-10-01",
    end: "",
    partial: false,
    expected: "拼多多账单_2026-10-01至不限",
  },
  {
    start: "",
    end: "2026-10-17",
    partial: false,
    expected: "拼多多账单_不限至2026-10-17",
  },
  { start: "", end: "", partial: false, expected: "拼多多账单_不限至不限" },
  {
    start: "2026-10-17",
    end: "2026-10-17",
    partial: true,
    expected: "拼多多账单_2026-10-17至2026-10-17_不完整",
  },
])(
  "file names use collection dates: $expected",
  ({ start, end, partial, expected }) => {
    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : null;
    for (const format of ["csv", "json"] as const) {
      expect(exportFile([], format, startDate, endDate, partial).name).toBe(
        `${expected}.${format}`,
      );
    }
  },
);

test.each([false, true])(
  "download cleans up its link and URL even when clicking fails: %s",
  (fails) => {
    vi.useFakeTimers();
    const url = "blob:https://example.test/download";
    const createObjectURL = vi.fn(() => url);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const file = {
      name: "账单.json",
      blob: new Blob(["{}"], { type: "application/json" }),
    };
    const error = new Error("download blocked");
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.isConnected).toBe(true);
        expect(this.hidden).toBe(true);
        expect(this.href).toBe(url);
        expect(this.download).toBe(file.name);
        if (fails) throw error;
      });
    if (fails) {
      expect(() => downloadFile(file.name, file.blob)).toThrow(error);
    } else {
      downloadFile(file.name, file.blob);
    }
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(file.blob);
    expect(document.querySelector("a")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(vi.getTimerCount()).toBe(0);
  },
);
