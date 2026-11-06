import { createIs, createAssert, type tags } from "typia";
import { PddError, type PddClient, type Order, type OrderDetail } from "./pdd";

export interface CollectedOrder {
  readonly order: Order;
  /** 未请求或未能取得详情；读取失败时由 detailFailure 说明。 */
  readonly detail: OrderDetail | null;
  readonly detailFailure?: "unavailable" | "paused";
  /** 已设置日期范围，但无法从订单编号估算日期；保留该订单供核对。 */
  readonly dateUncertain?: true;
}

type SelectedOrder = Pick<CollectedOrder, "order" | "dateUncertain">;

/** 外层按需分页并筛选，内层按配置获取详情；消费方自行保存已产出的条目。 */
export async function* collectOrders(
  source: Pick<PddClient, "getOrders" | "getOrderDetail">,
  collectionOptions: CollectionOptions,
  signal: AbortSignal,
): AsyncGenerator<OrderPage, void, void> {
  const { startDate, endDate, pageSize, maxPages, includeDetails } =
    assertCollectionOptions(collectionOptions);
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const pageOrders = await source.getOrders(cursor, pageSize, signal);
    if (pageOrders.length === 0) return;
    const { selectedOrders, reachedStart } = selectPageOrders(
      pageOrders,
      startDate,
      endDate,
    );
    const total = selectedOrders.length;
    const orders = collectPageOrders(
      source,
      selectedOrders,
      includeDetails,
      signal,
    );
    yield { total, orders };
    if (reachedStart) return;
    // 上游游标不透明，不能从订单号或页数推算。
    cursor = pageOrders.at(-1)!.offset;
  }
}

type CollectionOptions = {
  startDate: Date | null;
  endDate: Date | null;
  pageSize: number & tags.Type<"uint32"> & tags.Maximum<50>;
  maxPages: number & tags.Type<"uint32">;
  includeDetails: boolean;
};

type OrderPage = {
  readonly total: number;
  readonly orders: AsyncGenerator<CollectedOrder, void, void>;
};

const assertCollectionOptions = createAssert<CollectionOptions>();

function selectPageOrders(
  orders: readonly Order[],
  startDate: Date | null,
  endDate: Date | null,
): { selectedOrders: SelectedOrder[]; reachedStart: boolean } {
  const selectedOrders: SelectedOrder[] = [];
  for (const order of orders) {
    if (startDate || endDate) {
      const date = estimateOrderDate(order.order_sn);
      if (date === null) {
        selectedOrders.push({ order, dateUncertain: true });
        continue;
      }
      if (startDate && date < startDate)
        return { selectedOrders, reachedStart: true };
      if (endDate && date > endDate) continue;
    }
    selectedOrders.push({ order });
  }
  return { selectedOrders, reachedStart: false };
}

async function* collectPageOrders(
  source: Pick<PddClient, "getOrderDetail">,
  orders: readonly SelectedOrder[],
  includeDetails: boolean,
  signal: AbortSignal,
): AsyncGenerator<CollectedOrder, void, void> {
  for (const selected of orders) {
    signal.throwIfAborted();
    let detail: OrderDetail | null = null;
    if (includeDetails) {
      try {
        detail = await source.getOrderDetail(selected.order.order_sn, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (
          !(error instanceof PddError) ||
          error.code !== "detail-unavailable"
        ) {
          throw error;
        }
        yield { ...selected, detail: null, detailFailure: "unavailable" };
        continue;
      }
    }
    yield { ...selected, detail };
  }
}

const isCalendarDateText = createIs<string & tags.Format<"date">>();

/**
 * 从订单号前六位估算订单日期，不等同于支付时间。
 * 无法识别日期或日期不存在时返回 null，不丢弃整页订单。
 */
function estimateOrderDate(id: string): Date | null {
  const parts = /^(\d{2})(\d{2})(\d{2})-/.exec(id);
  const date = parts ? `20${parts[1]}-${parts[2]}-${parts[3]}` : "";
  if (!isCalendarDateText(date)) {
    return null;
  }
  return new Date(date);
}
