import type { CollectedOrder } from "./collect";
import type { Order, OrderDetail } from "./pdd";
import { createAssert, type tags } from "typia";
import { unparse } from "papaparse";

/**
 * 从收集结果生成文件，按本次收集的日期范围命名，不修改原始数据。
 * @throws CSV 字段不符合模型时抛出 Typia 详细错误；JSON 不做 CSV 校验。
 */
export function exportFile(
  entries: readonly CollectedOrder[],
  format: FileFormat,
  startDate: Date | null,
  endDate: Date | null,
  partial = false,
  imported = false,
): { name: string; blob: Blob } {
  const start = startDate?.toISOString().slice(0, 10) ?? "不限";
  const end = endDate?.toISOString().slice(0, 10) ?? "不限";
  const { encode, type } = formats[format];
  const suffix = partial
    ? "_不完整"
    : entries.some((entry) => entry.detailFailure)
      ? "_详情不完整"
      : "";
  return {
    name: `拼多多账单_${imported ? "导入订单_补齐详情" : `${start}至${end}`}${suffix}.${format}`,
    blob: new Blob(encode(entries), { type }),
  };
}

export function downloadFile(name: string, blob: Blob): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // 给浏览器读取 Blob 的时间，避免点击后立即回收导致下载失败。
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  }
}

type NonNegativeSafeInteger = number &
  tags.Minimum<0> &
  tags.TagBase<{
    target: "number";
    kind: "safeInteger";
    value: true;
    validate: "Number.isSafeInteger($input)";
  }>;

/** 在协议字段基础上补充 CSV 字段；金额单位为分，约束只影响 CSV 导出。 */
interface CsvOrder extends Order {
  mall?: { mall_name?: string };
  order_status_prompt?: string;
  order_amount?: NonNegativeSafeInteger;
  order_goods?: {
    goods_name?: string;
    spec?: string;
    goods_number?: NonNegativeSafeInteger;
    goods_price?: NonNegativeSafeInteger;
  }[];
}

interface CsvOrderDetail extends OrderDetail {
  orderDescList?: { key: string; value: string }[];
}

const formats = {
  csv: {
    encode: (entries) => [
      "\ufeff",
      unparse(toCsvRows(entries), { escapeFormulae: true }),
    ],
    type: "text/csv;charset=utf-8",
  },
  json: {
    encode: (entries) => [JSON.stringify(entries, null, 2)],
    type: "application/json;charset=utf-8",
  },
} satisfies Record<
  string,
  { encode: (entries: readonly CollectedOrder[]) => BlobPart[]; type: string }
>;

type FileFormat = keyof typeof formats;

// 模块级生成一次校验函数，保留字段路径等诊断供数据问题定位。
const assertCsvOrder = createAssert<CsvOrder>();
const assertCsvOrderDetail = createAssert<CsvOrderDetail | null>();

/** 属性插入顺序决定 CSV 列顺序；所有格式化均作用于新建的表格记录。 */
function toCsvRows(
  entries: readonly CollectedOrder[],
): Record<string, string>[] {
  const hasUncertainDates = entries.some((entry) => entry.dateUncertain);
  const hasDetailFailures = entries.some((entry) => entry.detailFailure);
  return entries.map((entry) => {
    const order = assertCsvOrder(entry.order);
    const detail = assertCsvOrderDetail(entry.detail);
    const details = indexDetailFields(detail?.orderDescList);
    const row: Record<string, string> = {
      订单编号: order.order_sn,
      订单金额: formatAmount(order.order_amount),
      店铺: order.mall?.mall_name ?? "",
      商品: formatGoods(order.order_goods),
      订单状态: order.order_status_prompt ?? "",
      支付方式: details.get("支付方式") ?? "",
      下单时间: details.get("下单时间") ?? "",
      物流公司: details.get("物流公司") ?? "",
      快递单号: details.get("快递单号") ?? "",
    };
    if (hasUncertainDates) {
      row.日期核对 = entry.dateUncertain ? "日期待核对" : "";
    }
    if (hasDetailFailures) {
      row.详情状态 =
        entry.detailFailure === "unavailable"
          ? "详情未能解析"
          : entry.detailFailure === "paused"
            ? "详情已暂停读取"
            : entry.detail === null
              ? "未请求详情"
              : "已获取";
    }
    return row;
  });
}

function formatAmount(value: NonNegativeSafeInteger | undefined): string {
  if (value === undefined) {
    return "";
  }
  // 安全整数转十进制字符串，再拆分元、分，避免浮点除法丢失一分钱。
  const cents = String(value).padStart(3, "0");
  return `${cents.slice(0, -2)}.${cents.slice(-2)}`;
}

function formatGoods(value: CsvOrder["order_goods"]): string {
  // 商品名和规格中的分隔符换成空格，避免与摘要的字段、商品边界混淆。
  const clean = (text = "") => text.replace(/[,;，；\s]+/g, " ").trim();
  return (value ?? [])
    .map((item) => {
      const spec = clean(item.spec);
      const name = clean(item.goods_name);
      const quantity = item.goods_number;
      const price = formatAmount(item.goods_price);
      return [
        name ? `商品：${name}` : "",
        spec ? `规格：${spec}` : "",
        quantity === undefined ? "" : `数量：${quantity}`,
        price === "" ? "" : `单价：${price}元`,
      ]
        .filter(Boolean)
        .join("，");
    })
    .filter(Boolean)
    .join("；");
}

function indexDetailFields(
  value: CsvOrderDetail["orderDescList"],
): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (const { key, value: content } of value ?? []) {
    const name = key.trim().replace(/[：:]$/, "");
    if (!fields.has(name)) fields.set(name, content);
  }
  return fields;
}
