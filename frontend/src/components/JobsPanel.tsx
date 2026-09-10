import type { Job } from '@canvora/shared';
import { cancelJob } from '../api/client';

interface Props { jobs: Job[]; root: string; onRefresh: () => void }

const KIND_LABEL: Record<Job['kind'], string> = { exportFrames: '导出首尾帧', upscaleImage: '图片放大', upscaleVideo: '视频放大', interpolateVideo: '视频补帧' };
const STATUS_LABEL: Record<Job['status'], string> = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };

function duration(job: Job) {
  if (!job.startedAt) return '—';
  const end = job.finishedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - job.startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function JobsPanel({ jobs, root, onRefresh }: Props) {
  return <div className="jobs">
    <div className="jobs-head">
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
            <span>用时 {duration(job)}</span>
            <span>{job.assetIds.length} 个素材</span>
          </div>
          {job.errorMessage && <div className="job-error">{job.errorMessage}{job.errorDetail && <details><summary>技术细节</summary><pre>{job.errorDetail}</pre></details>}</div>}
          {job.resultAssetIds.length > 0 && <div className="job-meta">产出 {job.resultAssetIds.length} 个新素材</div>}
          {(job.status === 'queued' || job.status === 'running') && <button className="link-button danger" onClick={() => void cancelJob(job.id, root).then(onRefresh)}>取消</button>}
        </li>)}
      </ul>}
  </div>;
}
