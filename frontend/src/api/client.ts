import type {
  Asset, AssetGroup, CanvasSnapshot, ChatMessage, ChatReply, HealthResponse, Job, JobKind, Project, ToolStatus, WorkspaceState,
} from '@canvora/shared';

const baseUrl = import.meta.env.VITE_API_URL ?? '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch {
    throw new Error('无法连接后端服务，请确认后端窗口还在运行');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// ── 工作区与项目 ──────────────────────────────────────
export function getHealth(): Promise<HealthResponse> { return request<HealthResponse>('/health'); }
export function getWorkspace(root?: string): Promise<WorkspaceState> { return request<WorkspaceState>(`/workspace${root ? `?root=${encodeURIComponent(root)}` : ''}`); }
export function getTools(root?: string): Promise<ToolStatus> { return request<ToolStatus>(`/tools${root ? `?root=${encodeURIComponent(root)}` : ''}`); }

export function createProject(name: string, root?: string): Promise<Project> {
  return request<Project>(`/projects${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('POST', { name }));
}
export function renameProject(id: string, name: string, root?: string): Promise<Project> {
  return request<Project>(`/projects/${encodeURIComponent(id)}${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('PATCH', { name }));
}
export function deleteProject(id: string, root?: string): Promise<{ ok: true; deletedFiles: number; deletedBytes: number }> {
  return request(`/projects/${encodeURIComponent(id)}${root ? `?root=${encodeURIComponent(root)}` : ''}`, { method: 'DELETE' });
}
export function getCanvas(projectId: string, root?: string): Promise<CanvasSnapshot> {
  return request<CanvasSnapshot>(`/projects/${encodeURIComponent(projectId)}/canvas${root ? `?root=${encodeURIComponent(root)}` : ''}`);
}
export function saveCanvas(projectId: string, snapshot: CanvasSnapshot, root?: string): Promise<{ ok: true }> {
  return request(`/projects/${encodeURIComponent(projectId)}/canvas${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('PUT', snapshot));
}

// ── 素材 ─────────────────────────────────────────────
export function importAssetFromPath(root: string, projectId: string, sourcePath: string): Promise<Asset> {
  return request<Asset>('/assets/import', json('POST', { root, projectId, sourcePath }));
}
export function deleteAsset(id: string, root?: string): Promise<{ ok: true }> {
  return request(`/assets/${encodeURIComponent(id)}${root ? `?root=${encodeURIComponent(root)}` : ''}`, { method: 'DELETE' });
}
export function assetFileUrl(root: string, assetId: string): string {
  return `${baseUrl}/assets/${encodeURIComponent(assetId)}/file?root=${encodeURIComponent(root)}`;
}
export function assetThumbUrl(root: string, assetId: string): string {
  return `${baseUrl}/assets/${encodeURIComponent(assetId)}/thumb?root=${encodeURIComponent(root)}`;
}

/**
 * 浏览器上传素材。用 XMLHttpRequest 而不是 fetch 是为了拿到上传进度——
 * 视频文件可能几百 MB，用户需要看到进度。内容以 application/octet-stream
 * 流式提交，后端直接落盘，不会整体进内存。
 */
export function uploadAsset(root: string, projectId: string, file: File, onProgress?: (percent: number) => void): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const url = `${baseUrl}/assets/upload?root=${encodeURIComponent(root)}&projectId=${encodeURIComponent(projectId)}&filename=${encodeURIComponent(file.name)}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as Asset); } catch { reject(new Error('后端返回的内容无法解析')); }
        return;
      }
      let message = '素材导入失败';
      try { message = (JSON.parse(xhr.responseText) as { message?: string }).message ?? message; } catch { /* 后端未返回 JSON 时保留默认中文提示 */ }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error('上传中断，请确认后端服务正在运行'));
    xhr.send(file);
  });
}

// ── 素材分组 ─────────────────────────────────────────
export function createGroup(projectId: string, name: string, assetIds: string[], root?: string): Promise<AssetGroup> {
  return request<AssetGroup>(`/groups${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('POST', { projectId, name, assetIds }));
}
export function assignGroup(groupId: string | null, assetIds: string[], root?: string): Promise<{ ok: true }> {
  const target = groupId ?? 'ungrouped';
  return request(`/groups/${encodeURIComponent(target)}/assets${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('PATCH', { groupId, assetIds }));
}
export function removeGroup(groupId: string, root?: string): Promise<{ ok: true }> {
  return request(`/groups/${encodeURIComponent(groupId)}${root ? `?root=${encodeURIComponent(root)}` : ''}`, { method: 'DELETE' });
}

// ── 批量任务 ─────────────────────────────────────────
export function listJobs(root?: string): Promise<Job[]> { return request<Job[]>(`/jobs${root ? `?root=${encodeURIComponent(root)}` : ''}`); }
export function enqueueJob(kind: JobKind, assetIds: string[], projectId: string, options: Record<string, unknown> = {}, root?: string): Promise<Job> {
  return request<Job>(`/jobs${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('POST', { kind, assetIds, projectId, options }));
}
export function cancelJob(id: string, root?: string): Promise<{ ok: boolean }> {
  return request(`/jobs/${encodeURIComponent(id)}/cancel${root ? `?root=${encodeURIComponent(root)}` : ''}`, { method: 'POST' });
}

// ── DeepSeek 对话（密钥只在后端使用）─────────────────
export interface ChatStatus { configured: boolean; last4: string | null; testStatus: 'success' | 'failed' | null; defaultModel: string }
export function getChatStatus(root?: string): Promise<ChatStatus> { return request<ChatStatus>(`/chat/status${root ? `?root=${encodeURIComponent(root)}` : ''}`); }
export function sendChat(messages: ChatMessage[], model?: string, root?: string): Promise<ChatReply> {
  return request<ChatReply>(`/chat${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('POST', { messages, model }));
}
export function saveChatKey(value: string, root?: string): Promise<{ ok: true; last4: string }> {
  return request(`/chat/key${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('PUT', { value }));
}
export function testChatKey(apiKey?: string, root?: string): Promise<{ ok: true; models: string[] }> {
  return request(`/chat/test${root ? `?root=${encodeURIComponent(root)}` : ''}`, json('POST', { apiKey }));
}
