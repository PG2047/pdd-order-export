import { h } from "preact";
import type { CollectionState } from "./controls";
import { CollectProgress } from "./progress";

export function CollectFeedback({
  status,
  progress,
  error,
  task,
  resumeProgress,
}: CollectionState) {
  const active = status === "collecting" || status === "cancelling";
  return (
    <div data-ui="collect-feedback">
      <p role="alert" hidden={!error}>
        {error}
      </p>
      <hr hidden={!active} />
      {active && task === "import" && (
        <p role="status">正在读取本地 JSON 文件…</p>
      )}
      {active && task === "resume" && resumeProgress && (
        <section aria-label="补齐进度">
          <p role="status">{`正在补齐详情（${resumeProgress.completed}/${resumeProgress.total}）…`}</p>
          <progress
            aria-label="缺失详情补齐进度"
            value={resumeProgress.completed}
            max={resumeProgress.total}
          />
          <p>{`保留原有详情 ${resumeProgress.preserved} 笔 · 本次新增 ${resumeProgress.recovered} 笔`}</p>
        </section>
      )}
      {active && task === "collect" && (
        <CollectProgress
          cancelling={status === "cancelling"}
          counts={progress}
        />
      )}
    </div>
  );
}
