/**
 * 把本地 AI 工具下载到工作区的 bin/ 下（PRD 0.5.1）。
 *
 * 用法：
 *   node scripts/fetch-tools.mjs                 下载到默认工作区（F:/Canvora）
 *   node scripts/fetch-tools.mjs --force         已有 exe 也重新下载
 *   node scripts/fetch-tools.mjs --workspace=G:/Canvora
 *   node scripts/fetch-tools.mjs --only=realesrgan --from-file=D:/下载的.zip
 *                                                网络下不动时，手动下载 zip 后用它安装
 *
 * 工作区默认取环境变量 CANVORA_WORKSPACE，其次 F:/Canvora。
 *
 * 许可证：realesrgan-ncnn-vulkan 是 BSD-3-Clause，rife-ncnn-vulkan 是 MIT，都是商用友好的。
 * 解压用系统自带的 PowerShell Expand-Archive（解压失败时退回 Windows 自带的 bsdtar），
 * 所以本脚本不引入任何 npm 依赖 —— 见 DEPENDENCIES.md 的登记。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const TOOLS = [
  {
    key: 'realesrgan',
    label: 'Real-ESRGAN 图片/视频放大',
    exe: 'realesrgan-ncnn-vulkan.exe',
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',
    license: 'BSD-3-Clause',
    /** 装完要能看到的模型，缺了说明压缩包结构变了，得提醒用户。 */
    expectedModels: ['realesrgan-x4plus.param', 'realesr-animevideov3-x4.param'],
  },
  {
    key: 'rife',
    label: 'RIFE 补帧',
    exe: 'rife-ncnn-vulkan.exe',
    url: 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip',
    license: 'MIT',
    expectedModels: ['rife-v4.6'],
  },
];

// 中文输出在 cmd 里会被按 GBK 解读成乱码，先把控制台代码页切到 UTF-8（失败也不影响功能）。
if (process.platform === 'win32') spawnSync('chcp.com', ['65001'], { stdio: 'ignore', windowsHide: true });

const log = (message) => console.log(message);
const warn = (message) => console.warn(message);

/** 直连 GitHub 常被重置，默认走本机代理；用 --no-proxy 可以关掉。 */
const DEFAULT_PROXY = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? 'http://127.0.0.1:7897';

function parseArgs(argv) {
  const options = { force: false, workspace: process.env.CANVORA_WORKSPACE ?? 'F:/Canvora', only: undefined, fromFile: undefined };
  for (const arg of argv) {
    if (arg === '--force' || arg === '-f') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--workspace=')) options.workspace = arg.slice('--workspace='.length);
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length);
    else if (arg.startsWith('--from-file=')) options.fromFile = arg.slice('--from-file='.length);
    else if (arg.startsWith('--proxy=')) options.proxy = arg.slice('--proxy='.length) || undefined;
    else if (arg === '--no-proxy') options.proxy = undefined;
    else if (!arg.startsWith('-')) options.workspace = arg;
  }
  return options;
}

function usage() {
  log('把 Canvora 需要的本地 AI 工具下载到工作区 bin/ 目录。');
  log('');
  log('  node scripts/fetch-tools.mjs [工作区路径] [--force] [--only=realesrgan|rife] [--from-file=zip路径]');
  log('');
  log(`  工作区默认取环境变量 CANVORA_WORKSPACE，其次 F:/Canvora。`);
  log('');
  log('  如果这个网络访问不了 GitHub，可以手动把下面两个 zip 下载到本机，再逐个装：');
  log('    node scripts/fetch-tools.mjs --only=realesrgan --from-file=D:/下载/realesrgan-ncnn-vulkan-20220424-windows.zip');
  log('    node scripts/fetch-tools.mjs --only=rife --from-file=D:/下载/rife-ncnn-vulkan-20221029-windows.zip');
  for (const tool of TOOLS) log(`    ${tool.exe} ← ${tool.url}`);
}

/** 一律用参数数组 spawn，不拼 shell 字符串。 */
function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: false, ...options });
    } catch (error) {
      resolve({ ok: false, stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => resolve({ ok: false, stderr: error.message }));
    child.once('close', (code) => resolve({ ok: code === 0, stderr }));
  });
}

const powershellPath = () => {
  const absolute = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  return existsSync(absolute) ? absolute : 'powershell.exe';
};

const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

/**
 * 解压 zip。
 * PowerShell 的 Expand-Archive 用 -EncodedCommand 传脚本：路径里有空格和中文也不会被拆开，
 * 也不经过任何 shell 解析。失败时退回 Windows 自带的 bsdtar（tar.exe，能读 zip）。
 */
async function extractZip(zipPath, destination) {
  await mkdir(destination, { recursive: true });
  const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)} -Force`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const viaPowershell = await runProcess(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  if (viaPowershell.ok) return;

  const systemTar = 'C:/Windows/System32/tar.exe';
  const viaTar = await runProcess(existsSync(systemTar) ? systemTar : 'tar', ['-xf', zipPath, '-C', destination]);
  if (viaTar.ok) return;

  throw new Error(`解压失败：${viaPowershell.stderr.trim() || viaTar.stderr.trim()}`);
}

/**
 * 下载。
 * 直连 GitHub 的 release 在国内经常被重置连接，所以默认走本机代理；有代理时用 curl，
 * 因为 Node 的 fetch 不认代理环境变量，而 Windows 自带 curl 并且 `--proxy` 实测可用。
 */
async function download(url, destination, proxy) {
  log(`  正在下载：${url}`);
  if (proxy) {
    log(`  走代理：${proxy}`);
    const args = ['-sS', '-L', '--proxy', proxy, '-o', destination, url];
    const result = await new Promise((resolve) => {
      const child = spawn('curl', args, { windowsHide: true });
      child.stderr.on('data', (chunk) => process.stderr.write(`  ${chunk}`));
      child.once('error', () => resolve({ ok: false, message: '找不到 curl' }));
      child.once('close', (code) => resolve({ ok: code === 0, message: `curl 退出码 ${code}` }));
    });
    if (result.ok) {
      const size = await stat(destination).then((info) => info.size).catch(() => 0);
      if (size > 1024 * 1024) { log(`  下载完成，共 ${(size / 1024 / 1024).toFixed(1)} MB`); return; }
      throw new Error(`下载到的文件只有 ${size} 字节，可能是代理不通或地址失效`);
    }
    log(`  代理下载失败（${result.message}），改回直连试试`);
  }

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
  const totalBytes = Number(response.headers.get('content-length') ?? 0);
  let received = 0;
  let lastPrint = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastPrint < 400) return;
    lastPrint = now;
    const receivedMb = (received / 1024 / 1024).toFixed(1);
    const text = totalBytes > 0 ? `${receivedMb} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB（${Math.round((received / totalBytes) * 100)}%）` : `${receivedMb} MB`;
    process.stdout.write(`\r  已下载 ${text}      `);
  });
  await pipeline(source, createWriteStream(destination));
  process.stdout.write(`\r  下载完成，共 ${(received / 1024 / 1024).toFixed(1)} MB      \n`);
}

async function findFile(root, fileName, depth = 0) {
  if (depth > 6) return undefined;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(root, entry.name), fileName, depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function installTool(tool, options) {
  const binDir = join(options.workspace, 'bin');
  const target = join(binDir, tool.exe);
  log('');
  log(`【${tool.label}】`);
  log(`  许可证：${tool.license}`);

  if (existsSync(target) && !options.force) {
    log(`  已经装好了，跳过：${target}`);
    log('  （要重新下载请加 --force）');
    return true;
  }

  await mkdir(binDir, { recursive: true });
  const cacheDir = join(binDir, '.cache');
  await mkdir(cacheDir, { recursive: true });
  const downloadedZip = join(cacheDir, `${tool.key}.zip`);
  const extractDir = join(cacheDir, `extract-${tool.key}`);
  let zipPath = downloadedZip;

  try {
    if (options.fromFile) {
      if (!existsSync(options.fromFile)) throw new Error(`找不到文件：${options.fromFile}`);
      zipPath = options.fromFile;
      log(`  用本地压缩包安装：${zipPath}`);
    } else {
      try {
        await download(tool.url, downloadedZip, options.proxy);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n  如果这台机器访问不了 GitHub，请用浏览器手动下载上面的 zip，再运行：node scripts/fetch-tools.mjs --only=${tool.key} --from-file=<zip 路径>`);
      }
    }
    const zipInfo = await stat(zipPath);
    if (zipInfo.size < 1024) throw new Error('压缩包太小，八成是没下载完整，请重试');

    log('  正在解压…');
    await rm(extractDir, { recursive: true, force: true });
    await extractZip(zipPath, extractDir);

    const exePath = await findFile(extractDir, tool.exe);
    if (!exePath) throw new Error(`解压后没找到 ${tool.exe}，压缩包结构可能变了，请到项目里提一下`);

    // 把 exe 所在目录的内容整体并进 bin/（含 models/ 和可能需要的 dll）。
    // 两个工具的 models/ 里是不同的模型子目录，合并不会互相覆盖。
    const sourceDir = dirname(exePath);
    await cp(exePath, target, { force: true });
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase() === tool.exe.toLowerCase()) continue;
      await cp(join(sourceDir, entry.name), join(binDir, entry.name), { recursive: true, force: true });
    }

    if (!existsSync(target)) throw new Error(`复制后没有找到 ${target}`);
    log(`  已安装：${target}`);

    const modelsDir = existsSync(join(binDir, 'models')) ? join(binDir, 'models') : join(options.workspace, 'models');
    const missing = [];
    for (const model of tool.expectedModels) {
      if (existsSync(join(modelsDir, model))) continue;
      missing.push(model);
    }
    if (missing.length > 0) warn(`  注意：没找到模型 ${missing.join('、')}（应该在 ${modelsDir} 下），界面里选模型时可能失败`);
    else log(`  模型就位：${modelsDir}`);
    return true;
  } finally {
    // 手工指定的 zip 是用户自己的文件，不能删。
    if (zipPath === downloadedZip) await rm(downloadedZip, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.proxy === undefined) options.proxy = DEFAULT_PROXY;
  if (options.help) {
    usage();
    return;
  }

  log('Canvora 本地工具下载');
  log(`工作区：${options.workspace}`);
  await mkdir(join(options.workspace, 'bin'), { recursive: true });
  await mkdir(join(options.workspace, 'models'), { recursive: true });

  const selected = options.only ? TOOLS.filter((tool) => tool.key === options.only) : TOOLS;
  if (selected.length === 0) {
    warn(`--only 只认识 ${TOOLS.map((tool) => tool.key).join(' 和 ')}`);
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const tool of selected) {
    try {
      const ok = await installTool(tool, options);
      if (!ok) failed += 1;
    } catch (error) {
      failed += 1;
      warn(`  失败：${error instanceof Error ? error.message : String(error)}`);
      warn('  可以稍后重新运行本脚本，它支持断点重来（没装完的会重新下载）。');
    }
  }

  log('');
  if (failed > 0) {
    warn(`有 ${failed} 个工具没装好。请检查网络后重新运行：node scripts/fetch-tools.mjs`);
    process.exitCode = 1;
    return;
  }

  const ffmpegOnPath = (process.env.PATH ?? '').split(';').some((dir) => dir && existsSync(join(dir, 'ffmpeg.exe')));
  log('全部就绪。');
  log(`  工具目录：${join(options.workspace, 'bin')}`);
  if (!existsSync(join(options.workspace, 'bin', 'ffmpeg.exe')) && !ffmpegOnPath) {
    warn('  提醒：没找到 ffmpeg。请安装 ffmpeg 7.x 并加入 PATH，或把 ffmpeg.exe / ffprobe.exe 放到上面的 bin/ 目录里。');
  }
  log('  现在回到 Canvora，就能对素材做放大和补帧了。');
}

main().catch((error) => {
  warn(`脚本出错：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
