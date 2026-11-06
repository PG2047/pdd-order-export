import { h } from "preact";
import type { CollectResult } from "../collect";
import { downloadFile, exportFile } from "../../export";

type FileFormat = Parameters<typeof exportFile>[1];
const descriptions: Record<FileFormat, string> = {
  csv: "导出为 CSV 账单表格，订单金额未扣除退款。\n\n导入表格软件时，请将订单号和快递单号设为文本。",
  json: "导出为 JSON，保留解析后的订单与详情数据。\n\n数据可能包含地址、手机号等个人信息，请妥善保管。大整数可能存在精度损失。",
};

/** 一种格式对应一个下载入口，只在明确点击时生成文件。 */
export function ExportDownload({
  result,
  format,
}: {
  result: CollectResult;
  format: FileFormat;
}) {
  return (
    <button
      type="button"
      title={descriptions[format]}
      onClick={(event) => {
        if (event.currentTarget.isConnected) save(result, format);
      }}
    >
      {`导出${result.partial ? "部分" : ""} ${format.toUpperCase()}${!result.partial && result.entries.some((entry) => entry.detailFailure) ? "（详情不完整）" : ""}`}
    </button>
  );
}
function save(
  { entries, partial, startDate, endDate, imported }: CollectResult,
  format: FileFormat,
) {
  if (!entries.length) return;
  let file;
  try {
    file = imported
      ? exportFile(entries, format, startDate, endDate, partial, true)
      : exportFile(entries, format, startDate, endDate, partial);
  } catch {
    globalThis.alert(
      format === "csv"
        ? "CSV 生成失败，请尝试导出 JSON。"
        : "JSON 生成失败，请稍后重试。",
    );
    return;
  }
  try {
    downloadFile(file.name, file.blob);
  } catch {
    globalThis.alert("无法发起下载，请检查浏览器下载权限后重试。");
  }
}
