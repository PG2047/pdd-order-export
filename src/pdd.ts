import {
  parse,
  type ExpressionStatement,
  type AssignmentExpression,
  type MemberExpression,
  type Identifier,
  type ObjectExpression,
} from "acorn";
import { createIs, json, type tags } from "typia";
import wretch from "wretch";

/** 只声明收集所需的协议字段，其他原始字段随响应保留。 */
export interface Order extends Record<string, unknown> {
  order_sn: string;
  offset: string;
}

export interface OrderDetail extends Record<string, unknown> {
  orderSn: string;
}

export class PddError extends Error {
  override readonly name = "PddError";

  constructor(
    message: string,
    readonly code:
      "request" | "session" | "schema" | "detail-unavailable" = "request",
  ) {
    super(message);
  }
}

/** 封装拼多多请求与协议校验；分页位置由调用方维护。 */
export class PddClient {
  readonly #uid: UserId;

  constructor() {
    this.#uid = parseUserId(document.cookie);
  }

  /**
   * 读取一页原始订单；空数组表示列表结束。
   * @param offset - 上一页末笔订单的 offset，null 表示首页。
   */
  async getOrders(
    offset: string | null,
    size: number,
    signal: AbortSignal,
  ): Promise<Order[]> {
    const { orders } = await createPddRequest(signal)
      .url(
        "/proxy/api/api/aristotle/order_list_v4?" +
          new URLSearchParams({ pdduid: this.#uid }),
      )
      .post(offset === null ? { size } : { size, offset })
      .json((value) => {
        if (!isOrderList(value)) {
          throw new PddError(
            "订单列表格式不符合预期，可能缺少订单编号或分页字段。",
            "schema",
          );
        }
        return value;
      });
    return orders;
  }

  /** 读取详情并核对订单编号，防止返回登录页或其他订单的数据。 */
  async getOrderDetail(
    orderSn: string,
    signal: AbortSignal,
  ): Promise<OrderDetail> {
    const detail = await createPddRequest(signal)
      .url("/order.html?" + new URLSearchParams({ order_sn: orderSn }))
      .get()
      .text(parseOrderDetail);
    if (detail.orderSn !== orderSn) {
      throw new PddError("详情内容不符合当前订单。", "schema");
    }
    return detail;
  }
}

const isOrderList = createIs<{
  orders: Order[];
}>();

type UserId = string & tags.Pattern<"^[1-9][0-9]*$">;

const isSingleUserId = createIs<[UserId]>();

function parseUserId(cookies: string): UserId {
  try {
    const values = new Set<string>();
    for (const [, value = ""] of cookies.matchAll(
      /(?:^|;)\s*pdd_user_id=([^;]*)/g,
    )) {
      values.add(decodeURIComponent(value.trim()));
    }
    const ids = [...values];
    if (isSingleUserId(ids)) {
      return ids[0];
    }
  } catch {
    // Cookie 解码失败与身份缺失统一作为会话错误处理。
  }
  throw new PddError(
    "无法从当前页面 Cookie 读取用户标识，请在当前页面重新登录后重试。",
    "session",
  );
}

function createPddRequest(signal: AbortSignal) {
  return wretch()
    .fetchPolyfill((url, options) => fetchWithRetry(url, options, signal))
    .options({ signal, credentials: "include", redirect: "error" })
    .customError((error) => {
      if (error.status === 401 || error.status === 403) {
        return new PddError(
          "登录已失效或访问被拒绝，请在当前页面重新登录。",
          "session",
        );
      }
      if (error.status === 429) {
        return new PddError("请求过于频繁，请稍后再试。");
      }
      return new PddError(`请求失败（HTTP ${error.status}），请稍后再试。`);
    })
    .catcherFallback((error) => {
      signal.throwIfAborted();
      if (error instanceof PddError) {
        throw error;
      }
      throw new PddError("请求失败，请检查网络后重试。");
    });
}

/** 最多请求三次；初次等待、重试退避与网络请求共用取消信号。 */
async function fetchWithRetry(
  url: RequestInfo | URL,
  options: RequestInit | undefined,
  signal: AbortSignal,
): Promise<Response> {
  await scheduler.postTask(() => {}, { delay: 600, signal });
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    const isLastAttempt = attempt === 3;
    let response: Response | undefined;
    try {
      response = await globalThis.fetch(url, options);
    } catch (error) {
      if (signal.aborted || isLastAttempt) throw error;
    }
    // 只重试网络异常和 5xx；其他响应交由请求层处理。
    if (response && (response.status < 500 || isLastAttempt)) return response;

    // 清理可能挂起，因此发起清理后直接进入退避等待。
    void response?.body?.cancel().catch(() => {});
    await scheduler.postTask(() => {}, { delay: 500 * attempt, signal });
  }
}

// 只校验定位 window.rawData 所需的节点，避免展开 Acorn 的完整递归 AST。
type RawDataStatement = Pick<ExpressionStatement, "type"> & {
  expression: Pick<AssignmentExpression, "type" | "operator"> & {
    operator: "=";
    left: Pick<MemberExpression, "type" | "computed"> & {
      computed: false;
      object: Pick<Identifier, "type" | "name"> & { name: "window" };
      property: Pick<Identifier, "type" | "name"> & { name: "rawData" };
    };
    right: Pick<ObjectExpression, "type" | "start" | "end">;
  };
};

const isRawDataStatement = createIs<RawDataStatement>();
const parseRawData = json.createIsParse<{
  data: OrderDetail;
}>();

/** 从脚本源码截取 JSON 字面量，不执行页面脚本；解析后保留全部字段。 */
function parseOrderDetail(html: string): OrderDetail {
  const document = new DOMParser().parseFromString(html, "text/html");
  for (const script of document.scripts) {
    const source = script.text;
    if (!source.trim()) continue;
    try {
      const program = parse(source, { ecmaVersion: "latest" });
      for (const statement of program.body) {
        if (!isRawDataStatement(statement)) {
          continue;
        }
        const { right } = statement.expression;
        const payload = parseRawData(source.slice(right.start, right.end));
        if (payload) {
          return payload.data;
        }
      }
    } catch {
      // 页面还包含无关脚本；当前脚本无法解析时继续寻找数据赋值。
    }
  }
  throw new PddError(
    "详情页缺少可解析的数据，可能需要重新登录或接口已变更。",
    "detail-unavailable",
  );
}
