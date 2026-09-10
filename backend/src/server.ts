import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { HealthResponse } from '@canvora/shared';

export const buildServer = () => {
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });
  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, service: 'canvora-backend', version: '0.1.0', timestamp: new Date().toISOString() }));
  app.setErrorHandler((error, _request, reply) => reply.status(500).send({ message: '服务器发生错误，请查看日志后重试', detail: error instanceof Error ? error.message : String(error) }));
  return app;
};

const port = Number(process.env.CANVORA_PORT ?? 8787);
const app = buildServer();
app.listen({ port, host: '127.0.0.1' }).then(() => console.log(`Canvora 后端已启动：http://127.0.0.1:${port}`)).catch((error) => { console.error(error); process.exit(1); });
