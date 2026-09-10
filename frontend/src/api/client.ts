import type { HealthResponse } from '@canvora/shared';

const baseUrl = import.meta.env.VITE_API_URL ?? '/api';
export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) throw new Error('后端服务暂时不可用');
  return response.json() as Promise<HealthResponse>;
}
