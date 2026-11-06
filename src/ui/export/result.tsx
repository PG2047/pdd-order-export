import { h } from "preact";
import type { CollectResult } from "../collect";

export function ExportResult({
  result: { entries, partial, startDate, endDate, imported },
}: {
  result: CollectResult;
}) {
  const missingDetails = entries.filter((entry) => entry.detailFailure).length;
  const pausedDetails = entries.filter(
    (entry) => entry.detailFailure === "paused",
  ).length;
  const status = imported
    ? missingDetails
      ? "已保留导入订单，仍有详情待补齐。"
      : "导入订单的详情已齐全。"
    : partial
      ? "结果不完整，已保留收到的订单。"
      : missingDetails
        ? "订单列表收集完成，详情不完整。"
        : entries.length
          ? "收集完成。"
          : "未找到订单，请调整日期范围。";
  const details = entries.filter((entry) => entry.detail !== null).length;
  const uncertainDates = entries.filter((entry) => entry.dateUncertain).length;
  return (
    <div data-ui="export-result">
      <h3>收集结果</h3>
      <p role="status">{status}</p>
      <p>{`已收集 ${entries.length} 笔订单 · 详情 ${details} 笔`}</p>
      <p>
        {imported
          ? "订单范围沿用导入文件，未重新读取订单列表。"
          : `结果日期：${formatDate(startDate)} 至 ${formatDate(endDate)}`}
      </p>
      {missingDetails > 0 && (
        <p role="note">
          {`有 ${missingDetails} 笔订单缺少详情，订单列表信息已保留，导出文件已标记。`}
          {pausedDetails > 0 &&
            `其中 ${pausedDetails} 笔沿用之前的暂停标记，可继续补齐。`}
        </p>
      )}
      {uncertainDates > 0 && (
        <p role="note">
          {`有 ${uncertainDates} 笔订单无法按编号核对日期，已保留并在导出文件中标记，可能超出所选日期范围。`}
        </p>
      )}
    </div>
  );
}
function formatDate(date: Date | null) {
  return date?.toISOString().slice(0, 10) ?? "不限";
}
