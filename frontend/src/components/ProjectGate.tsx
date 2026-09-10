import { useState } from 'react';
import type { Project } from '@canvora/shared';

interface Props {
  projects: Project[];
  workspaceRoot: string;
  busy: boolean;
  onCreate: (name: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onChangeRoot: (root: string) => void;
}

function ProjectGateComponent({ projects, workspaceRoot, busy, onCreate, onOpen, onDelete, onRename, onChangeRoot }: Props) {
  const [name, setName] = useState('');
  const [rootDraft, setRootDraft] = useState(workspaceRoot);
  const [showRoot, setShowRoot] = useState(false);
  return <div className="gate">
    <div className="gate-inner">
      <header className="gate-header">
        <span className="brand-mark">C</span>
        <div>
          <h1>Canvora</h1>
          <p>本机的无限画布 · AI 创作 · 视频剪辑工作台</p>
        </div>
      </header>

      <section className="gate-create">
        <h2>新建项目</h2>
        <p className="muted">每个项目单独存放它自己的素材、画布和任务结果。</p>
        <div className="gate-input-row">
          <input
            value={name}
            placeholder="例如：猫咪短片"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && name.trim()) onCreate(name.trim()); }}
          />
          <button className="primary-button" disabled={busy || !name.trim()} onClick={() => onCreate(name.trim())}>
            {busy ? '正在创建…' : '创建并进入'}
          </button>
        </div>
      </section>

      <section className="gate-projects">
        <h2>已有项目（{projects.length}）</h2>
        {projects.length === 0
          ? <p className="muted">还没有项目。上面输入名字就能建一个。</p>
          : <ul className="gate-list">
            {projects.map((project) => <li key={project.id}>
              <button className="gate-open" onClick={() => onOpen(project.id)}>
                <span className="gate-name">{project.name}</span>
                <span className="gate-time">{new Date(project.updatedAt).toLocaleString('zh-CN')}</span>
              </button>
              <button className="gate-action" onClick={() => { const next = window.prompt('重命名项目', project.name); if (next?.trim()) onRename(project.id, next.trim()); }}>重命名</button>
              <button className="gate-action danger" onClick={() => onDelete(project.id)}>删除</button>
            </li>)}
          </ul>}
      </section>

      <section className="gate-workspace">
        <button className="link-button" onClick={() => setShowRoot((value) => !value)}>工作区：{workspaceRoot || '（未设置）'} {showRoot ? '▲' : '▼'}</button>
        {showRoot && <div className="gate-input-row">
          <input value={rootDraft} onChange={(event) => setRootDraft(event.target.value)} placeholder="F:/Canvora" />
          <button className="ghost-button" onClick={() => onChangeRoot(rootDraft)}>切换</button>
        </div>}
        <p className="muted">素材会复制到这个目录，请选空间充足的磁盘（推荐 F: 或 G:），不要选快满的 C 盘。</p>
      </section>
    </div>
  </div>;
}

/** 进入画布前的项目入口页。没有选中项目时就显示它。 */
export const ProjectGate = ProjectGateComponent;
