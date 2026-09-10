import { memo, useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Asset, CanvasNode, PortKind } from '@canvora/shared';
import { assetFileUrl, assetThumbUrl } from '../api/client';
import { KIND_LABELS, PORT_COLORS, PORT_ROW_HEIGHT, nodeSpec } from './ports';

/** 同一时刻只允许一个视频节点在播放（16GB 内存机器上的硬约束）。 */
let playingVideo: HTMLVideoElement | null = null;

interface Props {
  node: CanvasNode;
  zoom: number;
  root: string;
  assets: Map<string, Asset>;
  selected: boolean;
  connectingKind: PortKind | null;
  onSelect: (id: string, additive: boolean) => void;
  /** 拖动只报告位移，由上层决定是移动一个还是移动整个选区。 */
  onDragBy: (id: string, delta: { x: number; y: number }) => void;
  onUpdateData: (id: string, patch: Record<string, unknown>) => void;
  onStartConnect: (nodeId: string, portId: string, kind: PortKind, index: number) => void;
  onContextMenu: (nodeId: string, clientX: number, clientY: number) => void;
}

const SPLIT_PRESETS = ['2x2', '3x3', '1x2', '2x1', '1x3', '3x1', '4x4'];

export const CanvasNodeView = memo(function CanvasNodeView({ node, zoom, root, assets, selected, connectingKind, onSelect, onDragBy, onUpdateData, onStartConnect, onContextMenu }: Props) {
  const drag = useRef<{ clientX: number; clientY: number; moved: boolean } | null>(null);
  const spec = nodeSpec(node.kind);
  const assetId = typeof node.data.assetId === 'string' ? node.data.assetId : null;
  const asset = assetId ? assets.get(assetId) ?? null : null;

  // 只有标题栏能拖动节点；正文里的输入框、按钮、播放器都不移动节点。
  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onSelect(node.id, event.shiftKey);
    drag.current = { clientX: event.clientX, clientY: event.clientY, moved: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 合成事件没有活动指针时会失败，忽略即可 */ }
  };
  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const dx = (event.clientX - start.clientX) / zoom;
    const dy = (event.clientY - start.clientY) / zoom;
    if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) return;
    start.moved = true;
    start.clientX = event.clientX;
    start.clientY = event.clientY;
    onDragBy(node.id, { x: dx, y: dy });
  };

  const onTextChange = useCallback((value: string) => onUpdateData(node.id, { text: value }), [node.id, onUpdateData]);
  const split = (node.data.split as string) || '2x2';

  const renderBody = () => {
    if (node.kind === 'prompt' || node.kind === 'text') {
      return <textarea value={String(node.data.text ?? '')} placeholder="写下你的提示词…" onChange={(event) => onTextChange(event.target.value)} onPointerDown={(event) => event.stopPropagation()} />;
    }
    if (node.kind === 'note') {
      return <textarea className="note-text" value={String(node.data.text ?? '')} placeholder="写点备注…" onChange={(event) => onTextChange(event.target.value)} onPointerDown={(event) => event.stopPropagation()} />;
    }
    if (node.kind === 'image') {
      if (!asset) return <div className="node-placeholder"><span>还没有图片</span><small>把图片拖进画布，或从素材库拖入</small></div>;
      return <img className="node-media" src={assetFileUrl(root, asset.id)} alt={asset.originalName} draggable={false} />;
    }
    if (node.kind === 'video') {
      if (!asset) return <div className="node-placeholder"><span>还没有视频</span><small>把视频拖进画布，或从素材库拖入</small></div>;
      return <video
        className="node-media"
        src={assetFileUrl(root, asset.id)}
        poster={assetThumbUrl(root, asset.id)}
        controls
        preload="metadata"
        onPointerDown={(event) => event.stopPropagation()}
        onPlay={(event) => { if (playingVideo && playingVideo !== event.currentTarget) playingVideo.pause(); playingVideo = event.currentTarget; }}
      />;
    }
    if (node.kind === 'audio') {
      if (!asset) return <div className="node-placeholder"><span>还没有音频</span></div>;
      return <audio className="node-audio" src={assetFileUrl(root, asset.id)} controls onPointerDown={(event) => event.stopPropagation()} />;
    }
    if (node.kind === 'splitImage') {
      return <div className="node-params" onPointerDown={(event) => event.stopPropagation()}>
        <label className="param-row">切分方式
          <select value={split} onChange={(event) => onUpdateData(node.id, { split: event.target.value })}>
            {SPLIT_PRESETS.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
          </select>
        </label>
        <small className="muted tiny">接入图片后运行，会在下方生成对应数量的图片节点</small>
      </div>;
    }
    if (node.kind === 'upscale') {
      const scale = String(node.data.scale ?? '4');
      return <div className="node-params" onPointerDown={(event) => event.stopPropagation()}>
        <label className="param-row">倍数
          <select value={scale} onChange={(event) => onUpdateData(node.id, { scale: event.target.value })}>
            {['2', '3', '4'].map((value) => <option key={value} value={value}>{value}x</option>)}
          </select>
        </label>
        <small className="muted tiny">接通多张图片或多段视频后会批量处理</small>
      </div>;
    }
    if (node.kind === 'extractFrame') {
      const position = String(node.data.position ?? 'first');
      return <div className="node-params" onPointerDown={(event) => event.stopPropagation()}>
        <label className="param-row">位置
          <select value={position} onChange={(event) => onUpdateData(node.id, { position: event.target.value })}>
            <option value="first">首帧</option>
            <option value="last">尾帧</option>
            <option value="both">首帧 + 尾帧</option>
          </select>
        </label>
      </div>;
    }
    if (node.kind === 'interpolate') {
      const multiplier = String(node.data.multiplier ?? '2');
      return <div className="node-params" onPointerDown={(event) => event.stopPropagation()}>
        <label className="param-row">倍率
          <select value={multiplier} onChange={(event) => onUpdateData(node.id, { multiplier: event.target.value })}>
            <option value="2">2x</option>
            <option value="4">4x</option>
          </select>
        </label>
      </div>;
    }
    if (node.kind === 'generateImage' || node.kind === 'generateVideo') {
      return <div className="node-placeholder"><span>{node.kind === 'generateImage' ? '生图配置' : '生视频配置'}</span><small>需要先在设置里配置服务商和密钥</small></div>;
    }
    return <div className="node-placeholder"><span>等待输入</span></div>;
  };

  const mediaMeta = asset?.kind === 'video' && asset.durationSec
    ? `${asset.width ?? '?'}×${asset.height ?? '?'} · ${asset.durationSec.toFixed(1)}秒`
    : asset?.kind === 'image' && asset.width
      ? `${asset.width}×${asset.height}`
      : null;

  const rows = Math.max(spec.inputs.length, spec.outputs.length);

  return <div
    className={`canvas-node ${selected ? 'selected' : ''}`}
    style={{ left: node.x, top: node.y, width: node.width }}
    onPointerDown={(event) => { event.stopPropagation(); onSelect(node.id, event.shiftKey); }}
    onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(node.id, event.clientX, event.clientY); }}
  >
    <div className="node-header" onPointerDown={onHeaderPointerDown} onPointerMove={onHeaderPointerMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <span className="node-title">{node.title}</span>
      <span className="drag-handle" title="按住标题栏拖动">⠿</span>
    </div>
    {rows > 0 && <div className="node-ports">
      {Array.from({ length: rows }, (_, index) => {
        const input = spec.inputs[index];
        const output = spec.outputs[index];
        return <div className="port-row" key={index} style={{ height: PORT_ROW_HEIGHT }}>
          {input ? <>
            <button
              className="port port-in"
              data-port-in="true"
              data-node-id={node.id}
              data-port-id={input.id}
              data-port-kind={input.kind}
              title={`输入：${input.label}（${KIND_LABELS[input.kind]}）${input.multiple ? '，可接多条' : ''}`}
              style={{ background: PORT_COLORS[input.kind], opacity: connectingKind && connectingKind !== 'any' && input.kind !== 'any' && input.kind !== connectingKind ? 0.28 : 1 }}
              onPointerDown={(event) => event.stopPropagation()}
            />
            <span className="port-label">{input.label}</span>
          </> : <span />}
          {output ? <>
            <span className="port-label">{output.label}</span>
            <button
              className="port port-out"
              data-port-out="true"
              title={`输出：${output.label}（${KIND_LABELS[output.kind]}），按住拖到目标节点的输入口；拖到空白处会列出能接的下一步`}
              style={{ background: PORT_COLORS[output.kind] }}
              onPointerDown={(event) => { event.stopPropagation(); onStartConnect(node.id, output.id, output.kind, index); }}
            />
          </> : <span />}
        </div>;
      })}
    </div>}
    <div className="node-body" onPointerDown={(event) => event.stopPropagation()}>
      {renderBody()}
      {mediaMeta && <div className="node-meta">{mediaMeta}{asset?.originalName ? ` · ${asset.originalName}` : ''}</div>}
    </div>
  </div>;
});
