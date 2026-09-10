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
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onUpdateData: (id: string, patch: Record<string, unknown>) => void;
  onStartConnect: (nodeId: string, portId: string, kind: PortKind, index: number) => void;
}

export const CanvasNodeView = memo(function CanvasNodeView({ node, zoom, root, assets, selected, connectingKind, onSelect, onMove, onUpdateData, onStartConnect }: Props) {
  const drag = useRef<{ clientX: number; clientY: number; nodeX: number; nodeY: number } | null>(null);
  const spec = nodeSpec(node.kind);
  const assetId = typeof node.data.assetId === 'string' ? node.data.assetId : null;
  const asset = assetId ? assets.get(assetId) ?? null : null;

  // 只有标题栏能拖动节点；正文里的输入框、按钮、播放器都不移动节点。
  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    onSelect(node.id);
    drag.current = { clientX: event.clientX, clientY: event.clientY, nodeX: node.x, nodeY: node.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dx = (event.clientX - drag.current.clientX) / zoom;
    const dy = (event.clientY - drag.current.clientY) / zoom;
    onMove(node.id, Math.max(0, drag.current.nodeX + dx), Math.max(0, drag.current.nodeY + dy));
  };
  const stopDrag = () => { drag.current = null; };

  const onTextChange = useCallback((value: string) => onUpdateData(node.id, { text: value }), [node.id, onUpdateData]);

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
    if (node.kind === 'generateImage' || node.kind === 'generateVideo') {
      return <div className="node-placeholder"><span>{node.kind === 'generateImage' ? '生图配置' : '生视频配置'}</span><small>需要先在设置里配置服务商和密钥</small></div>;
    }
    if (node.kind === 'upscale' || node.kind === 'interpolate') {
      return <div className="node-placeholder"><span>{node.kind === 'upscale' ? '图片放大' : '视频补帧'}</span><small>需要工作区 bin/ 下有对应工具</small></div>;
    }
    if (node.kind === 'extractFrame') {
      return <div className="node-placeholder"><span>抽取首帧 / 尾帧</span><small>接入视频节点后可用</small></div>;
    }
    return <div className="node-placeholder"><span>等待输入</span></div>;
  };

  const mediaMeta = asset && asset.kind === 'video' && asset.durationSec
    ? `${asset.width ?? '?'}×${asset.height ?? '?'} · ${asset.durationSec.toFixed(1)}秒`
    : asset && asset.kind === 'image' && asset.width
      ? `${asset.width}×${asset.height}`
      : null;

  const rows = Math.max(spec.inputs.length, spec.outputs.length);

  return <div
    className={`canvas-node ${selected ? 'selected' : ''}`}
    style={{ left: node.x, top: node.y, width: node.width }}
    onPointerDown={(event) => { event.stopPropagation(); onSelect(node.id); }}
  >
    <div className="node-header" onPointerDown={onHeaderPointerDown} onPointerMove={onHeaderPointerMove} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
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
              title={`输入：${input.label}（${KIND_LABELS[input.kind]}）`}
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
              title={`输出：${output.label}（${KIND_LABELS[output.kind]}），按住拖到下个节点的输入口`}
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
