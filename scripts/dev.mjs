import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * 同时拉起后端和前端。
 * 不用 `a & b` 这种写法：Windows 的 cmd 会先阻塞在第一个命令上，前端永远起不来。
 * 也不用 concurrently：为一个开发脚本额外引入依赖不值得。
 */
const children = [
  spawn(npm, ['run', 'dev:backend'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev:frontend'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }),
];

const shutdown = (signal) => {
  for (const child of children) child.kill(signal);
};
process.on('SIGINT', () => { shutdown('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); process.exit(0); });
for (const child of children) child.on('exit', (code) => { if (code !== 0 && code !== null) console.error(`子进程退出，退出码 ${code}`); });

console.log('Canvora 开发服务已启动：前端 http://127.0.0.1:5173 ，后端 http://127.0.0.1:8787');
