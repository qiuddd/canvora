import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { GenerationTask } from '@canvora/shared';

export type TaskState = GenerationTask;
const taskFile = (root: string) => join(root, 'tasks.json');
export interface TaskStore { tasks: TaskState[] }
async function persist(root: string, store: TaskStore): Promise<void> { const target = taskFile(root); const temp = `${target}.${process.pid}.tmp`; await mkdir(dirname(target), { recursive: true }); await writeFile(temp, JSON.stringify(store, null, 2), 'utf8'); await rename(temp, target); }
export async function loadTasks(root: string): Promise<TaskStore> { try { const store = JSON.parse(await readFile(taskFile(root), 'utf8')) as TaskStore; for (const task of store.tasks) if (task.status === 'running' && task.engine === 'local') { task.status = 'failed'; task.statusText = '本地任务因应用重启中断'; task.errorMessage = '本地任务已中断，请重新执行'; task.finishedAt = Date.now(); } return store; } catch { return { tasks: [] }; } }
export async function createTask(root: string, input: Omit<TaskState, 'id' | 'createdAt' | 'retryCount' | 'status' | 'progress' | 'statusText' | 'resultAssetIds'>): Promise<TaskState> { const store = await loadTasks(root); const task: TaskState = { ...input, id: nanoid(), createdAt: Date.now(), retryCount: 0, status: 'queued', progress: 0, statusText: '排队中', resultAssetIds: [] }; store.tasks.push(task); await persist(root, store); return task; }
export async function getTask(root: string, id: string): Promise<TaskState | undefined> { return (await loadTasks(root)).tasks.find((task) => task.id === id); }
export async function updateTask(root: string, id: string, patch: Partial<TaskState>): Promise<TaskState | undefined> { const store = await loadTasks(root); const index = store.tasks.findIndex((task) => task.id === id); if (index < 0) return undefined; store.tasks[index] = { ...store.tasks[index], ...patch }; await persist(root, store); return store.tasks[index]; }
export async function listTasks(root: string): Promise<TaskState[]> { return (await loadTasks(root)).tasks; }
