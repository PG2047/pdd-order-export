import { Component, h } from "preact";
import { CollectControls, type CollectResult } from "./collect";
import { ExportControls } from "./export";
import { ExportDialog } from "./dialog";
import { SCRIPT_VERSION } from "../version";

/** 持有结果快照并连接区域接口；收集进度仍留在收集区域。 */
export class ExportPanel extends Component<
  {},
  { result: CollectResult | null }
> {
  state = { result: null as CollectResult | null };

  render() {
    return (
      <div data-ui="panel">
        <ExportDialog>
          <p>{`固定版 ${SCRIPT_VERSION}`}</p>
          <CollectControls
            result={this.state.result}
            onStart={this.#onStart}
            onFinish={this.#onFinish}
          />
          <ExportControls result={this.state.result} />
        </ExportDialog>
      </div>
    );
  }

  #onStart = () => {
    this.setState({ result: null });
  };
  #onFinish = (result: CollectResult | null) => {
    this.setState({ result });
  };
}
