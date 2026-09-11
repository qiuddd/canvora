import type { GenerationTask, Job } from '@canvora/shared';
import { cancelGeneration, cancelJob, deleteGenerationTask, deleteJob } from '../api/client';

interface Props { jobs: Job[]; generationTasks: GenerationTask[]; root: string; onRefresh: () => void }

const KIND_LABEL: Record<Job['kind'], string> = { exportFrames: '导出首尾帧', upscaleImage: '图片放大', upscaleVideo: '视频放大', interpolateVideo: '视频补帧', splitImage: '图片分割', exportTimeline: '导出成片' };
const STATUS_LABEL: Record<Job['status'], string> = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const CLOUD_LABEL: Record<GenerationTask['kind'], string> = { image: '云端生图', video: '云端生视频', text: '云端文本', upscale: '放大', interpolate: '补帧', extractFrame: '抽帧', export: '导出', proxy: '代理文件' };

function duration(startedAt?: number, finishedAt?: number) {
  if (!startedAt) return '—';
  const end = finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function JobsPanel({ jobs, generationTasks, root, onRefresh }: Props) {
  const finishedCloud = generationTasks.filter((task) => task.status !== 'queued' && task.status !== 'running');
  return <div className="jobs">
    <div className="jobs-head">
      <span>云端生成任务</span>
      <button className="small-button" onClick={onRefresh}>刷新</button>
    </div>
    {generationTasks.length === 0
      ? <p className="muted">还没有云端生成任务。在画布上给「生图 / 生视频」节点写好提示词后点生成。</p>
      : <ul className="job-list">
        {generationTasks.map((task) => <li key={task.id} className={`job-item ${task.status}`}>
          <div className="job-row">
            <strong>{CLOUD_LABEL[task.kind]}</strong>
            <span className={`job-status ${task.status}`}>{STATUS_LABEL[task.status]}</span>
          </div>
          <div className="job-bar"><div className="job-bar-fill" style={{ width: `${Math.round((task.progress ?? 0) * 100)}%` }} /></div>
          <div className="job-meta">
            <span>{task.statusText || '等待中'}</span>
            <span>用时 {duration(task.startedAt, task.finishedAt)}</span>
            <span>{task.modelId ?? '默认模型'}</span>
          </div>
          {task.errorMessage && <div className="job-error">{task.errorMessage}{task.errorDetail && <details><summary>技术细节</summary><pre>{task.errorDetail}</pre></details>}</div>}
          {task.resultAssetIds.length > 0 && <div className="job-meta">产出 {task.resultAssetIds.length} 个素材，已放回画布</div>}
          {(task.status === 'queued' || task.status === 'running') && <button className="link-button danger" onClick={() => void cancelGeneration(task.id, root).then(onRefresh)}>取消</button>}
        </li>)}
      </ul>}
    {finishedCloud.length > 0 && <div className="jobs-head" style={{ marginTop: 12 }}>
      <span className="muted tiny">已结束的云端任务会保留在记录里，点右侧清掉</span>
      <button className="small-button" onClick={() => void Promise.all(finishedCloud.map((task) => deleteGenerationTask(task.id, root))).then(onRefresh)}>清理已结束</button>
    </div>}

    <div className="jobs-head" style={{ marginTop: 18 }}>
      <span>本地任务（同时只跑 1 个）</span>
      <button className="small-button" onClick={onRefresh}>刷新</button>
    </div>
    {jobs.length === 0
      ? <p className="muted">还没有任务。在素材库里选中素材后点「批量放大」「批量补帧」或「导出首尾帧」。</p>
      : <ul className="job-list">
        {jobs.map((job) => <li key={job.id} className={`job-item ${job.status}`}>
          <div className="job-row">
            <strong>{KIND_LABEL[job.kind]}</strong>
            <span className={`job-status ${job.status}`}>{STATUS_LABEL[job.status]}</span>
          </div>
          <div className="job-bar"><div className="job-bar-fill" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} /></div>
          <div className="job-meta">
            <span>{job.statusText || '等待中'}</span>
            <span>用时 {duration(job.startedAt, job.finishedAt)}</span>
            <span>{job.assetIds.length} 个素材</span>
          </div>
          {job.errorMessage && <div className="job-error">{job.errorMessage}{job.errorDetail && <details><summary>技术细节</summary><pre>{job.errorDetail}</pre></details>}</div>}
          {job.resultAssetIds.length > 0 && <div className="job-meta">产出 {job.resultAssetIds.length} 个新素材</div>}
          {(job.status === 'queued' || job.status === 'running')
            ? <button className="link-button danger" onClick={() => void cancelJob(job.id, root).then(onRefresh)}>取消</button>
            : <button className="link-button" onClick={() => void deleteJob(job.id, root).then(onRefresh)}>从列表移除</button>}
        </li>)}
      </ul>}
  </div>;
}
