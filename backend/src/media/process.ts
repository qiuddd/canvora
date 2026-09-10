import { spawn, type ChildProcess } from 'node:child_process';

export interface ProcessResult { stdout: string; stderr: string; exitCode: number }

export function runProcess(command: string, args: readonly string[], options: { cwd?: string } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? -1 }));
  });
}

export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, shell: false });
  } else {
    child.kill('SIGTERM');
  }
}
