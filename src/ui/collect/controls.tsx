import { Component, h } from "preact";
import { PddClient, PddError } from "../../pdd";
import { collectOrders, type CollectedOrder } from "../../collect";
import { CollectForm, type CollectOptions, type CollectStatus } from "./form";
import { CollectFeedback } from "./feedback";
import type { CollectCounts } from "./progress";
import { importOrders, resumeOrderDetails } from "../../resume";

/** 收集区域拥有任务、取消和进度，只向外交付结果快照。 */
export class CollectControls extends Component<
  {
    result: CollectResult | null;
    onStart: () => void;
    onFinish: (result: CollectResult | null) => void;
  },
  CollectionState
> {
  state: CollectionState = {
    status: "idle",
    progress: null,
    error: null,
    task: "collect",
    resumeProgress: null,
  };
  #controller: AbortController | null = null;
  #disposed = false;

  render() {
    const entries = this.props.result?.entries ?? [];
    const pending = entries.filter((entry) => entry.detail === null).length;
    const active =
      this.state.status === "collecting" || this.state.status === "cancelling";
    return (
      <div data-ui="collect">
        <CollectForm
          status={this.state.status}
          onCollect={this.#collect}
          onCancel={this.#cancel}
        />
        <section data-ui="resume-controls" aria-label="补齐已有订单详情">
          <h3>补齐已有订单详情</h3>
          <label>
            导入已有 JSON
            <input
              type="file"
              accept=".json,application/json"
              disabled={active}
              onChange={this.#import}
            />
          </label>
          <p>导入在本机读取；只请求缺失详情，保留已有详情和订单顺序。</p>
          {entries.length > 0 && (
            <p>{`已有 ${entries.length} 笔订单 · 保留详情 ${entries.length - pending} 笔 · 待补 ${pending} 笔`}</p>
          )}
          <button
            type="button"
            disabled={active || pending === 0}
            onClick={this.#resume}
          >
            {`仅补齐缺失的 ${pending} 笔详情`}
          </button>
        </section>
        <CollectFeedback {...this.state} />
      </div>
    );
  }
  componentWillUnmount() {
    this.#disposed = true;
    this.#controller?.abort();
    this.#controller = null;
  }
  #prepare() {
    if (this.#disposed || this.#controller) return null;
    try {
      return new PddClient();
    } catch (error) {
      // 准备失败不触发开始通知，保留上一次可导出的结果。
      this.setState({ error: describeError(error) });
      return null;
    }
  }
  #finish(result: CollectResult | null, error: string | null = null) {
    this.#controller = null;
    this.setState({
      status: result ? "complete" : "idle",
      progress: null,
      resumeProgress: null,
      error,
    });
    this.props.onFinish(result);
  }
  #collect = async (options: CollectOptions) => {
    const client = this.#prepare();
    if (!client) return;
    const controller = new AbortController();
    this.#controller = controller;
    this.setState({
      status: "collecting",
      progress: null,
      error: null,
      task: "collect",
      resumeProgress: null,
    });
    this.props.onStart();
    const entries: CollectedOrder[] = [];
    let pages = 0;
    let failure: string | null = null;
    let phase = "检查收集设置";
    let requestPage = 0;
    let requestDetail = 0;
    const source: Pick<PddClient, "getOrders" | "getOrderDetail"> = {
      getOrders: async (...args) => {
        phase = `读取第 ${++requestPage} 页订单列表`;
        requestDetail = 0;
        const orders = await client.getOrders(...args);
        phase = `筛选第 ${requestPage} 页订单`;
        return orders;
      },
      getOrderDetail: (...args) => {
        phase = `读取第 ${requestPage} 页第 ${++requestDetail} 笔订单详情`;
        return client.getOrderDetail(...args);
      },
    };
    try {
      pages = await this.#readPages(source, options, controller, entries);
    } catch (error) {
      if (controller !== this.#controller) return;
      if (!controller.signal.aborted) {
        failure = describeError(error, phase);
        if (!entries.length) {
          this.#finish(null, failure);
          return;
        }
      }
      // 中断时保留已完成的订单，并明确标记结果不完整。
    }
    if (controller !== this.#controller) return;
    this.#finish(
      {
        entries,
        partial:
          failure !== null ||
          controller.signal.aborted ||
          pages >= options.maxPages,
        startDate: options.startDate,
        endDate: options.endDate,
      },
      failure,
    );
  };
  #import = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || this.#disposed || this.#controller) return;
    const previous = this.props.result;
    const controller = new AbortController();
    this.#controller = controller;
    this.setState({
      status: "collecting",
      task: "import",
      progress: null,
      resumeProgress: null,
      error: null,
    });
    try {
      const entries = importOrders(await file.text());
      if (this.#disposed || controller !== this.#controller) return;
      this.#finish(
        controller.signal.aborted
          ? previous
          : {
              entries,
              partial: false,
              startDate: null,
              endDate: null,
              imported: true,
            },
      );
    } catch {
      if (controller !== this.#controller) return;
      this.#finish(
        previous,
        controller.signal.aborted
          ? null
          : "无法导入文件，请选择本工具导出的 JSON 订单数组。已有结果已保留。",
      );
    } finally {
      input.value = "";
    }
  };
  #resume = async () => {
    const result = this.props.result;
    if (!result) return;
    const total = result.entries.filter(
      (entry) => entry.detail === null,
    ).length;
    if (!total) return;
    const client = this.#prepare();
    if (!client) return;
    const controller = new AbortController();
    this.#controller = controller;
    const entries = [...result.entries];
    let progress: ResumeProgress = {
      completed: 0,
      total,
      recovered: 0,
      preserved: entries.length - total,
    };
    this.setState({
      status: "collecting",
      task: "resume",
      progress: null,
      resumeProgress: progress,
      error: null,
    });
    let failure: string | null = null;
    try {
      for await (const { index, entry } of resumeOrderDetails(
        client,
        result.entries,
        controller.signal,
      )) {
        if (controller !== this.#controller) return;
        entries[index] = entry;
        progress = {
          ...progress,
          completed: progress.completed + 1,
          recovered: progress.recovered + (entry.detail === null ? 0 : 1),
        };
        this.props.onFinish({ ...result, entries: [...entries] });
        this.setState({ resumeProgress: progress });
        if (controller.signal.aborted) break;
      }
    } catch (error) {
      if (controller !== this.#controller) return;
      if (!controller.signal.aborted)
        failure = describeError(
          error,
          `补齐第 ${progress.completed + 1}/${total} 笔缺失详情`,
        );
    }
    if (controller !== this.#controller) return;
    this.#finish({ ...result, entries }, failure);
  };
  async #readPages(
    client: Pick<PddClient, "getOrders" | "getOrderDetail">,
    options: CollectOptions,
    controller: AbortController,
    entries: CollectedOrder[],
  ) {
    let progress: CollectCounts = {
      pages: 0,
      orders: 0,
      details: 0,
      currentPage: null,
    };
    collection: for await (const { total, orders } of collectOrders(
      client,
      options,
      controller.signal,
    )) {
      if (controller !== this.#controller || controller.signal.aborted) break;
      let completed = 0;
      progress = {
        ...progress,
        pages: progress.pages + 1,
        currentPage: { completed, total },
      };
      this.#publish(controller, progress);
      for await (const entry of orders) {
        if (controller !== this.#controller) break collection;
        entries.push(entry);
        completed++;
        progress = {
          ...progress,
          orders: entries.length,
          details: progress.details + (entry.detail === null ? 0 : 1),
          currentPage: { completed, total },
        };
        this.#publish(controller, progress);
        if (controller.signal.aborted) break collection;
      }
      if (controller !== this.#controller || controller.signal.aborted) break;
      progress = { ...progress, currentPage: null };
      this.#publish(controller, progress);
    }
    return progress.pages;
  }
  #publish(controller: AbortController, progress: CollectCounts) {
    this.setState({
      status: controller.signal.aborted ? "cancelling" : "collecting",
      progress,
    });
  }
  #cancel = () => {
    const controller = this.#controller;
    if (!controller) return false;
    if (!controller.signal.aborted) {
      controller.abort();
      this.setState({ status: "cancelling" });
    }
    return true;
  };
}

export interface CollectResult {
  readonly entries: readonly CollectedOrder[];
  readonly partial: boolean;
  readonly startDate: Date | null;
  readonly endDate: Date | null;
  /** JSON 数组未携带列表完整性和日期范围，不能推断原收集范围。 */
  readonly imported?: true;
}
export interface ResumeProgress {
  readonly completed: number;
  readonly total: number;
  readonly recovered: number;
  readonly preserved: number;
}
export interface CollectionState {
  status: CollectStatus;
  progress: CollectCounts | null;
  error: string | null;
  task: "collect" | "import" | "resume";
  resumeProgress: ResumeProgress | null;
}
function describeError(error: unknown, phase = "准备收集"): string {
  if (error instanceof PddError) return error.message;
  // 只显示已知错误类别和本地进度，不显示可能包含私密数据的异常消息。
  const knownNames = [
    "Error",
    "TypeError",
    "SyntaxError",
    "RangeError",
    "TypeGuardError",
  ];
  const name =
    error instanceof Error && knownNames.includes(error.name)
      ? error.name
      : "未知错误";
  return `${phase}时发生异常（${name}），请保留此提示以便排查。`;
}
