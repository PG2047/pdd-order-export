import { json } from "typia";
import type { CollectedOrder } from "./collect";
import { PddError, type PddClient } from "./pdd";

const parseEntries = json.createIsParse<CollectedOrder[]>();

/** 只导入导出数组，不执行文件内容；成功的订单和详情保持原样。 */
export function importOrders(text: string): CollectedOrder[] {
  const entries = parseEntries(text);
  if (!entries) throw new Error("请导入本工具导出的 JSON 订单数组。");
  return entries.map((entry) =>
    entry.detail === null && !entry.detailFailure
      ? { ...entry, detailFailure: "paused" as const }
      : entry,
  );
}

/** 仅产出缺失详情的更新，不读取列表，不修改原数组或已成功的详情。 */
export async function* resumeOrderDetails(
  source: Pick<PddClient, "getOrderDetail">,
  entries: readonly CollectedOrder[],
  signal: AbortSignal,
): AsyncGenerator<{ index: number; entry: CollectedOrder }, void, void> {
  for (const [index, entry] of entries.entries()) {
    if (entry.detail !== null) continue;
    signal.throwIfAborted();
    try {
      const detail = await source.getOrderDetail(entry.order.order_sn, signal);
      const { detailFailure: _failure, ...kept } = entry;
      yield { index, entry: { ...kept, detail } };
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof PddError) || error.code !== "detail-unavailable") {
        throw error;
      }
      yield { index, entry: { ...entry, detailFailure: "unavailable" } };
    }
  }
}
