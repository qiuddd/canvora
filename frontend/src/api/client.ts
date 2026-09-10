import type { Asset, HealthResponse, WorkspaceState } from '@canvora/shared';

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

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export function getWorkspace(root?: string): Promise<WorkspaceState> {
  return request<WorkspaceState>(`/workspace${root ? `?root=${encodeURIComponent(root)}` : ''}`);
}

/** 服务器本地路径导入，用于桌面端和测试脚本。 */
export function importAssetFromPath(root: string, projectId: string, sourcePath: string): Promise<Asset> {
  return request<Asset>('/assets/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root, projectId, sourcePath }) });
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
