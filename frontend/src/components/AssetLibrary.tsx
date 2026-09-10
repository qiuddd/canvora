import { useMemo, useRef, useState } from 'react';
import type { Asset, AssetGroup, ToolStatus } from '@canvora/shared';
import { assetFileUrl, assetThumbUrl } from '../api/client';

export type BatchKind = 'upscale' | 'interpolate' | 'frames';

interface Props {
  assets: Asset[];
  groups: AssetGroup[];
  root: string;
  tools: ToolStatus | null;
  onImport: () => void;
  onAddToCanvas: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  onCreateGroup: (name: string, assetIds: string[]) => void;
  onAssignGroup: (groupId: string | null, assetIds: string[]) => void;
  onRemoveGroup: (groupId: string) => void;
  onBatch: (kind: BatchKind, assetIds: string[]) => void;
}

const kindLabel: Record<string, string> = { image: '图片', video: '视频', audio: '音频' };

function metaLine(asset: Asset) {
  const parts = [kindLabel[asset.kind]];
  if (asset.kind !== 'image' && asset.durationSec) parts.push(`${asset.durationSec.toFixed(1)}秒`);
  if (asset.width) parts.push(`${asset.width}×${asset.height}`);
  if (asset.source === 'upscaled') parts.push('放大产物');
  if (asset.source === 'interpolated') parts.push('补帧产物');
  if (asset.source === 'exportedFrame') parts.push('抽帧产物');
  return parts.join(' · ');
}

export function AssetLibrary({ assets, groups, root, tools, onImport, onAddToCanvas, onDelete, onCreateGroup, onAssignGroup, onRemoveGroup, onBatch }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | 'image' | 'video' | 'audio'>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const draggedRef = useRef<string | null>(null);

  const visible = useMemo(() => assets.filter((asset) => {
    if (filter !== 'all' && asset.kind !== filter) return false;
    if (groupFilter === 'ungrouped' && asset.groupId) return false;
    if (groupFilter !== 'all' && groupFilter !== 'ungrouped' && asset.groupId !== groupFilter) return false;
    if (search && !asset.originalName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [assets, filter, groupFilter, search]);

  const grouped = useMemo(() => {
    const buckets: Array<{ group: AssetGroup | null; items: Asset[] }> = [];
    const ungrouped = visible.filter((asset) => !asset.groupId);
    for (const group of groups) {
      const items = visible.filter((asset) => asset.groupId === group.id);
      if (items.length || groupFilter === group.id) buckets.push({ group, items });
    }
    if (ungrouped.length) buckets.push({ group: null, items: ungrouped });
    return buckets;
  }, [visible, groups, groupFilter]);

  const selectedAssets = useMemo(() => assets.filter((asset) => selected.includes(asset.id)), [assets, selected]);
  const selectedImages = selectedAssets.filter((asset) => asset.kind === 'image').map((asset) => asset.id);
  const selectedVideos = selectedAssets.filter((asset) => asset.kind === 'video').map((asset) => asset.id);

  const toggle = (id: string) => setSelected((list) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);
  const toggleGroupCollapse = (id: string) => setCollapsedGroups((list) => list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

  const upscaleReady = tools?.realesrgan ?? false;
  const rifeReady = tools?.rife ?? false;

  return <div className="library">
    <div className="library-toolbar">
      <input className="search" value={search} placeholder="按文件名搜索" onChange={(event) => setSearch(event.target.value)} />
      <button className="small-button" onClick={onImport}>导入素材</button>
    </div>

    <div className="library-filter">
      <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
        <option value="all">全部类型</option>
        <option value="image">图片</option>
        <option value="video">视频</option>
        <option value="audio">音频</option>
      </select>
      <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
        <option value="all">全部分组</option>
        <option value="ungrouped">未分组</option>
        {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
    </div>

    <div className="library-batch">
      <div className="batch-head">
        <span>已选 {selected.length} 个</span>
        <button className="link-button" onClick={() => setSelected(visible.map((asset) => asset.id))}>全选当前</button>
        <button className="link-button" onClick={() => setSelected([])}>清空</button>
      </div>
      <div className="batch-actions">
        <button className="batch-button" disabled={!selectedImages.length} title={upscaleReady ? '' : '还没安装 Real-ESRGAN 工具'} onClick={() => onBatch('upscale', selectedImages)}>批量放大图片（{selectedImages.length}）</button>
        <button className="batch-button" disabled={!selectedVideos.length} title={rifeReady ? '' : '还没安装 RIFE 工具'} onClick={() => onBatch('interpolate', selectedVideos)}>批量补帧视频（{selectedVideos.length}）</button>
        <button className="batch-button" disabled={!selectedVideos.length} onClick={() => onBatch('frames', selectedVideos)}>导出首尾帧（{selectedVideos.length}）</button>
        <button className="batch-button" disabled={!selected.length} onClick={() => { const name = window.prompt('分组名称', `分组 ${groups.length + 1}`); if (name?.trim()) { onCreateGroup(name.trim(), selected); setSelected([]); } }}>打组</button>
        {selected.some((id) => assets.find((asset) => asset.id === id)?.groupId) && <button className="batch-button" onClick={() => { onAssignGroup(null, selected); setSelected([]); }}>移出分组</button>}
      </div>
      {(!upscaleReady || !rifeReady) && <p className="muted tiny">放大会用 Real-ESRGAN，补帧用 RIFE。缺工具时任务会失败并提示，可运行 <code>node scripts/fetch-tools.mjs</code> 下载。</p>}
    </div>

    {assets.length === 0
      ? <div className="library-empty"><div className="library-icon">▧</div><p>这个项目还没有素材</p><span>把图片或视频拖进画布，或点上面的「导入素材」</span></div>
      : grouped.map(({ group, items }) => <section className="group-block" key={group?.id ?? 'ungrouped'}>
        <header className="group-head">
          {group ? <>
            <button className="link-button" onClick={() => toggleGroupCollapse(group.id)}>{collapsedGroups.includes(group.id) ? '▶' : '▼'} {group.name}（{items.length}）</button>
            <button className="link-button danger" onClick={() => onRemoveGroup(group.id)}>删除分组</button>
          </> : <span className="group-title">未分组（{items.length}）</span>}
        </header>
        {!collapsedGroups.includes(group?.id ?? '') && <div className="asset-grid">
          {items.map((asset) => <div
            className={`asset-card ${selected.includes(asset.id) ? 'picked' : ''}`}
            key={asset.id}
            draggable
            onDragStart={() => { draggedRef.current = asset.id; }}
            onDragEnd={() => { draggedRef.current = null; }}
            onDoubleClick={() => onAddToCanvas(asset)}
            title={`${asset.originalName} —— 拖到画布或双击加入画布`}
          >
            <label className="asset-pick" onClick={(event) => event.stopPropagation()}>
              <input type="checkbox" checked={selected.includes(asset.id)} onChange={() => toggle(asset.id)} />
            </label>
            <img src={asset.kind === 'video' ? assetThumbUrl(root, asset.id) : assetFileUrl(root, asset.id)} alt={asset.originalName} loading="lazy" />
            <span className="asset-name">{asset.originalName}</span>
            <span className="asset-meta">{metaLine(asset)}</span>
            <button className="asset-delete" title="删除素材" onClick={(event) => { event.stopPropagation(); onDelete(asset); }}>×</button>
          </div>)}
        </div>}
      </section>)}
  </div>;
}
