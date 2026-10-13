'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { PDFDocument } = require('../vendor/pdf-lib.cjs');

const CHANNELS = Object.freeze({
  selectFiles: 'conversion:select-files',
  selectInputDirectory: 'conversion:select-input-directory',
  selectOutputDirectory: 'conversion:select-output-directory',
  checkHancom: 'conversion:check-hancom',
  start: 'conversion:start',
  cancel: 'conversion:cancel',
  event: 'conversion:event',
});

const ALLOWED_INPUT_EXTENSIONS = new Set(['.hwp', '.hml', '.hwpx']);
const ALLOWED_TARGETS = new Set(['pdf', 'hwpx']);
const runningJobs = new Map();
const senderJobs = new Map();
const outputReservations = new Map();
const pendingDiagnosticWrites = new Set();
const MAX_DIAGNOSTIC_EVENTS = 500;
const MAX_STDERR_CHARS = 8192;
let diagnosticWriteQueue = Promise.resolve();

let handlersRegistered = false;
let quitWhenIdle = false;

function createWindow() {
  const iconPath = resolveAppIconPath();
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    icon: iconPath,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const rendererUrl =
    process.env.ELECTRON_RENDERER_URL ||
    process.env.VITE_DEV_SERVER_URL ||
    (!app.isPackaged ? 'http://127.0.0.1:5173' : '');
  if (rendererUrl) {
    win.loadURL(rendererUrl).catch((error) => {
      console.error('Failed to load renderer URL:', error);
    });
    return win;
  }

  const indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(indexHtml)) {
    win.loadFile(indexHtml).catch((error) => {
      console.error('Failed to load renderer file:', error);
    });
  } else {
    win.loadURL('about:blank').catch((error) => {
      console.error('Failed to load blank page:', error);
    });
  }

  return win;
}

function resolveAppIconPath() {
  const developmentIcon = path.join(__dirname, '..', 'build', 'icon.png');
  if (fs.existsSync(developmentIcon)) {
    return developmentIcon;
  }

  const packagedIcon = path.join(process.resourcesPath || '', 'build', 'icon.png');
  if (fs.existsSync(packagedIcon)) {
    return packagedIcon;
  }

  return undefined;
}

function registerIpcHandlers() {
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  ipcMain.handle(CHANNELS.selectFiles, async () => {
    const result = await showOpenDialog({
      title: 'Select Hancom documents',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Hancom documents', extensions: ['hwp', 'hml', 'hwpx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    return {
      ok: true,
      canceled: result.canceled,
      files: result.filePaths || [],
    };
  });

  ipcMain.handle(CHANNELS.selectInputDirectory, async () => {
    const result = await showOpenDialog({
      title: 'Select input folder',
      properties: ['openDirectory'],
    });

    if (result.canceled || !result.filePaths[0]) {
      return {
        ok: true,
        canceled: true,
        directory: null,
        files: [],
      };
    }

    const directory = path.normalize(result.filePaths[0]);
    const files = await collectSupportedInputFiles(directory);

    return {
      ok: true,
      canceled: false,
      directory,
      files,
    };
  });

  ipcMain.handle(CHANNELS.selectOutputDirectory, async () => {
    const result = await showOpenDialog({
      title: 'Select output folder',
      properties: ['openDirectory', 'createDirectory'],
    });

    return {
      ok: true,
      canceled: result.canceled,
      directory: result.canceled ? null : result.filePaths[0],
    };
  });

  ipcMain.handle(CHANNELS.checkHancom, async () => {
    try {
      return await runJsonScript('check-hancom.ps1');
    } catch (error) {
      return {
        ok: false,
        type: 'hancom-check',
        code: 'CHECK_SCRIPT_FAILED',
        message: error.message,
      };
    }
  });

  ipcMain.handle(CHANNELS.start, async (event, payload) => {
    try {
      return await startConversionJob(event.sender, payload);
    } catch (error) {
      return {
        ok: false,
        code: 'START_CONVERSION_FAILED',
        message: error.message,
      };
    }
  });

  ipcMain.handle(CHANNELS.cancel, async (event, runId) => {
    if (typeof runId !== 'string' || runId.trim() === '') {
      return {
        ok: false,
        code: 'INVALID_RUN_ID',
        message: 'A conversion runId string is required.',
      };
    }

    const job = runningJobs.get(runId);
    if (!job || job.webContents !== event.sender) {
      return {
        ok: false,
        code: 'UNKNOWN_RUN_ID',
        message: `No running conversion job exists for ${runId}.`,
      };
    }

    await requestJobCancellation(job);

    return {
      ok: true,
      runId,
    };
  });
}

function showOpenDialog(options) {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    return dialog.showOpenDialog(focusedWindow, options);
  }

  return dialog.showOpenDialog(options);
}

async function collectSupportedInputFiles(rootDirectory) {
  const pendingDirectories = [rootDirectory];
  const files = [];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    let entries;

    try {
      entries = await fsp.readdir(currentDirectory, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }

      if (entry.isFile() && ALLOWED_INPUT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(entryPath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right, 'ko-KR', { numeric: true, sensitivity: 'base' }));
}

async function startConversionJob(webContents, payload) {
  // Reserve the sender before preflight awaits, so simultaneous IPC starts cannot race.
  if (senderJobs.has(webContents)) {
    throw new Error('A conversion is already running in this window.');
  }
  const runId = crypto.randomUUID();
  senderJobs.set(webContents, runId);
  let job;
  try {
    const jobPayload = validateStartPayload(payload);
    const scriptPath = resolveScriptPath('convert-hwp.ps1');
    await assertFileExists(scriptPath, 'CONVERT_SCRIPT_MISSING');
    const tasks = await prepareTasks(jobPayload.tasks, jobPayload.options, runId);
    job = {
      runId,
      scriptPath,
      options: { ...jobPayload.options, cancelPath: path.join(os.tmpdir(), `hancom-cancel-${runId}`) },
      tasks,
      taskById: new Map(tasks.map((task) => [task.id, task])),
      outcomes: new Map(),
      outputEvents: new Set(),
      outputValidationCache: new Map(),
      recoveryAttempts: new Map(),
      recoveryLaunches: 0,
      diagnosticEvents: [],
      diagnosticFailures: [],
      startedAt: new Date().toISOString(),
      parallelism: Math.min(jobPayload.options.parallelism, tasks.length),
      workers: new Map(),
      tempJsonPaths: new Set(),
      webContents,
      cancelled: false,
      finished: false,
      launching: true,
      fatalCount: 0,
      summary: { total: tasks.length, succeeded: 0, failed: 0, cancelled: 0, pdf: 0, hwpx: 0 },
    };
    runningJobs.set(runId, job);
    job.destroyedListener = () => { requestJobCancellation(job).catch(() => {}); };
    webContents.once?.('destroyed', job.destroyedListener);
    sendJobEvent(job, { type: 'spawned', ok: true, scriptPath, fileCount: tasks.length, parallelism: job.parallelism });
    sendJobEvent(job, {
      type: 'start', ok: true, taskCount: tasks.length, fileCount: tasks.length,
      parallelism: job.parallelism, message: `Starting ${job.parallelism} persistent conversion worker(s).`,
    });

    // Largest files first gives a useful balance without starting a COM server per file.
    const batches = Array.from({ length: job.parallelism }, () => ({ bytes: 0, tasks: [] }));
    for (const task of [...tasks].sort((left, right) => right.sourceSnapshot.size - left.sourceSnapshot.size)) {
      const batch = batches.reduce((best, candidate) => candidate.bytes < best.bytes ? candidate : best);
      batch.tasks.push(task);
      batch.bytes += Math.max(1, task.sourceSnapshot.size);
    }
    await Promise.all(batches.map(async ({ tasks: batch }) => {
      try {
        if (!job.cancelled) await spawnConversionWorker(job, batch);
      } catch (error) {
        job.fatalCount += 1;
        for (const task of batch) recordTaskFailure(job, task, 'WORKER_LAUNCH_FAILED', error.message);
      }
    }));
    job.launching = false;
    maybeFinishJob(job);
    return { ok: true, runId };
  } catch (error) {
    if (!job) {
      senderJobs.delete(webContents);
      releaseOutputReservations(runId);
    }
    throw error;
  }
}

function pathKey(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function snapshotFile(stats) {
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, ino: stats.ino, dev: stats.dev };
}

async function prepareTasks(tasks, options, runId) {
  const uniqueTasks = [];
  const inputPaths = new Set();
  for (const task of tasks) {
    const canonicalPath = await fsp.realpath(task.inputPath);
    if (inputPaths.has(pathKey(canonicalPath))) continue;
    const stats = await fsp.stat(canonicalPath);
    if (!stats.isFile() || stats.size === 0) throw new Error(`Input is not a nonempty file: ${task.inputPath}`);
    inputPaths.add(pathKey(canonicalPath));
    uniqueTasks.push({ ...task, sourceSnapshot: snapshotFile(stats), canonicalPath });
  }
  const now = new Date();
  const dateFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const task of uniqueTasks) {
    let directory = options.outputDir || path.dirname(task.inputPath);
    if (options.createSubfolders) directory = path.join(directory, dateFolder);
    await fsp.mkdir(directory, { recursive: true });
    directory = await fsp.realpath(directory);
    const baseName = path.basename(task.inputPath, path.extname(task.inputPath));
    task.plannedOutputPaths = {};
    for (const target of task.targets) {
      let suffix = 0;
      for (;;) {
        const candidate = path.join(directory, `${baseName}${suffix ? ` (${suffix})` : ''}.${target}`);
        const key = pathKey(candidate);
        // Reserving before an await also protects concurrent jobs in different windows.
        if (inputPaths.has(key) || outputReservations.has(key)) { suffix += 1; continue; }
        outputReservations.set(key, runId);
        try {
          await fsp.lstat(candidate);
          outputReservations.delete(key);
          suffix += 1;
        } catch (error) {
          if (error.code !== 'ENOENT') { outputReservations.delete(key); throw error; }
          task.plannedOutputPaths[target] = candidate;
          break;
        }
      }
    }
  }
  return uniqueTasks;
}

function releaseOutputReservations(runId) {
  for (const [key, owner] of outputReservations) {
    if (owner === runId) outputReservations.delete(key);
  }
}

function validateStartPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload must be an object with tasks or files and options.');
  }

  const rawOptions = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const options = {
    outputDir: normalizeOptionalDirectory(rawOptions.outputDir || payload.outputDirectory),
    pdf: rawOptions.pdf !== false,
    hwpx: rawOptions.hwpx !== false,
    deleteOriginal: rawOptions.deleteOriginal === true,
    createSubfolders: rawOptions.createSubfolders === true,
    keepIntermediate: rawOptions.keepIntermediate !== false,
    parallelism: normalizeParallelism(rawOptions.parallelism),
    visible: false,
  };

  const defaultTargets = [];
  if (options.pdf) {
    defaultTargets.push('pdf');
  }
  if (options.hwpx) {
    defaultTargets.push('hwpx');
  }

  const rawTasks = Array.isArray(payload.tasks)
    ? payload.tasks
    : Array.isArray(payload.files)
      ? payload.files
      : [];

  if (rawTasks.length === 0) {
    throw new Error('At least one input task is required.');
  }

  const tasks = [];
  const paths = new Set();
  const ids = new Set();
  for (const [index, rawTask] of rawTasks.entries()) {
    const task = normalizeTask(rawTask, index, defaultTargets);
    if (paths.has(pathKey(task.inputPath))) continue;
    if (ids.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}`);
    paths.add(pathKey(task.inputPath));
    ids.add(task.id);
    tasks.push(task);
  }

  return {
    tasks,
    options,
  };
}

function normalizeParallelism(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 2;
  }

  return Math.min(4, Math.max(1, Math.round(parsed)));
}

function normalizeTask(task, index, defaultTargets) {
  const rawPath = typeof task === 'string' ? task : task && (task.inputPath || task.path);
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new Error(`Task ${index + 1} must include an inputPath string.`);
  }

  const inputPath = path.normalize(rawPath);
  if (!path.isAbsolute(inputPath)) {
    throw new Error(`Input file path must be absolute: ${rawPath}`);
  }

  const extension = path.extname(inputPath).toLowerCase();
  if (!ALLOWED_INPUT_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported input extension: ${extension || '(none)'}`);
  }

  const rawTargets = typeof task === 'object' && task ? task.targets : defaultTargets;
  const targets = Array.from(new Set((Array.isArray(rawTargets) ? rawTargets : defaultTargets)
    .map((target) => String(target).toLowerCase())
    .filter((target) => ALLOWED_TARGETS.has(target))));

  const allowedTargets = targets.filter((target) => target !== 'hwpx' || extension !== '.hwpx');
  if (allowedTargets.length === 0) {
    throw new Error(`Task ${index + 1} has no supported output targets.`);
  }

  return {
    id: typeof task === 'object' && task && typeof task.id === 'string' && task.id.trim() ? task.id : crypto.randomUUID(),
    inputPath,
    inputName: typeof task === 'object' && task && typeof task.inputName === 'string'
      ? task.inputName
      : path.basename(inputPath),
    sourceFormat: extension.slice(1),
    targets: allowedTargets,
  };
}

function normalizeOptionalDirectory(directory) {
  if (directory === undefined || directory === null || directory === '') {
    return null;
  }

  if (typeof directory !== 'string') {
    throw new Error('options.outputDir must be a string when provided.');
  }

  const normalized = path.normalize(directory);
  if (!path.isAbsolute(normalized)) {
    throw new Error(`Output directory must be absolute: ${directory}`);
  }

  return normalized;
}

async function spawnConversionWorker(job, tasks) {
  const workerId = crypto.randomUUID();
  const tempJsonPath = path.join(os.tmpdir(), `hancom-conversion-${job.runId}-${workerId}.json`);
  const childPayload = {
    runId: job.runId,
    tasks: tasks.map(({ sourceSnapshot, canonicalPath, ...task }) => task),
    options: job.options,
  };
  job.tempJsonPaths.add(tempJsonPath);
  await fsp.writeFile(tempJsonPath, JSON.stringify(childPayload, null, 2), 'utf8');
  if (job.cancelled) return;
  const child = spawn(getPowerShellExecutable(), [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA',
    '-File', job.scriptPath, '-InputJsonPath', tempJsonPath,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const worker = {
    workerId, child, tempJsonPath, tasks,
    taskIds: new Set(tasks.map((task) => task.id)),
    stdoutBuffer: '', stderrBuffer: '', stderrTail: '',
    stdoutDecoder: new StringDecoder('utf8'), stderrDecoder: new StringDecoder('utf8'),
    events: Promise.resolve(), closed: false,
  };
  job.workers.set(workerId, worker);
  attachProcessListeners(job, worker);
  sendJobEvent(job, { type: 'worker-start', ok: true, workerId, taskCount: tasks.length });
}

function attachProcessListeners(job, worker) {
  worker.child.stdout.on('data', (chunk) => {
    worker.stdoutBuffer = consumeLines(job, worker, worker.stdoutBuffer + worker.stdoutDecoder.write(chunk), 'stdout');
  });
  worker.child.stderr.on('data', (chunk) => {
    const decoded = worker.stderrDecoder.write(chunk);
    worker.stderrTail = (worker.stderrTail + decoded).slice(-MAX_STDERR_CHARS);
    worker.stderrBuffer = consumeLines(job, worker, worker.stderrBuffer + decoded, 'stderr');
  });
  worker.child.on('error', (error) => {
    worker.spawnError = error;
  });
  worker.child.on('close', (exitCode, signal) => {
    if (worker.closed) return;
    worker.closed = true;
    handleProcessLine(job, worker, worker.stdoutBuffer + worker.stdoutDecoder.end(), 'stdout');
    const stderrEnd = worker.stderrDecoder.end();
    worker.stderrTail = (worker.stderrTail + stderrEnd).slice(-MAX_STDERR_CHARS);
    handleProcessLine(job, worker, worker.stderrBuffer + stderrEnd, 'stderr');
    worker.events = worker.events.then(async () => {
      const expectedRecycle = exitCode === 75 && Boolean(worker.recycleRequest) && !worker.invalidRecycleReason && !worker.fatalReported;
      const recoveryTasks = expectedRecycle ? await prepareWorkerRecovery(job, worker) : [];
      for (const task of worker.tasks) {
        if (job.outcomes.has(task.id)) continue;
        if (recoveryTasks.includes(task)) continue;
          if (job.cancelled) {
            recordTaskCancellation(job, task);
          } else {
            const failure = describeWorkerFailure(worker, exitCode);
            recordTaskFailure(job, task, failure.code, failure.message, worker.workerId, failure.details);
        }
      }
      if (exitCode !== 0 && !expectedRecycle && !job.cancelled) job.fatalCount += 1;
      sendJobEvent(job, { type: 'worker-exit', ok: !job.cancelled && (exitCode === 0 || expectedRecycle),
        workerId: worker.workerId, exitCode, signal, recycled: expectedRecycle });
      await fsp.unlink(worker.tempJsonPath).catch(() => {});
      job.tempJsonPaths.delete(worker.tempJsonPath);
      // Reserve the replacement slot before removing this worker. Another worker's
      // close event must not finish the run while the replacement JSON is being written.
      if (recoveryTasks.length > 0) job.recoveryLaunches += 1;
      job.workers.delete(worker.workerId);
      if (recoveryTasks.length > 0) {
        try {
          if (!job.cancelled) await spawnConversionWorker(job, recoveryTasks);
          else for (const task of recoveryTasks) recordTaskCancellation(job, task);
        } catch (error) {
          for (const task of recoveryTasks) recordTaskFailure(job, task, 'WORKER_RECOVERY_LAUNCH_FAILED', error.message);
        } finally { job.recoveryLaunches -= 1; }
      }
      maybeFinishJob(job);
    }).catch((error) => {
      for (const task of worker.tasks) recordTaskFailure(job, task, 'WORKER_RESULT_FAILED', error.message);
      job.workers.delete(worker.workerId);
      maybeFinishJob(job);
    });
  });
}

function maybeFinishJob(job) {
  if (job.finished || job.launching || job.recoveryLaunches > 0 || job.workers.size > 0) return;
  for (const task of job.tasks) {
    if (job.outcomes.has(task.id)) continue;
    if (job.cancelled) recordTaskCancellation(job, task);
    else recordTaskFailure(job, task, 'MISSING_TASK_RESULT', 'No conversion result was received.');
  }
  job.finished = true;
  const ok = !job.cancelled && job.summary.failed === 0 && job.fatalCount === 0;
  sendJobEvent(job, { type: job.cancelled ? 'cancelled' : 'complete', ok, summary: { ...job.summary } });
  sendJobEvent(job, { type: 'exit', ok, exitCode: ok ? 0 : 1, parallelism: job.parallelism });
  const diagnosticWrite = queueLatestRunDiagnostic(job);
  runningJobs.delete(job.runId);
  if (senderJobs.get(job.webContents) === job.runId) senderJobs.delete(job.webContents);
  job.webContents.removeListener?.('destroyed', job.destroyedListener);
  releaseOutputReservations(job.runId);
  // A pending marker write is awaited before cleanup, preventing a leaked cancellation file.
  const cleanup = async () => {
    await job.cancelPromise;
    await Promise.all([...job.tempJsonPaths, job.options.cancelPath].map((filePath) => fsp.unlink(filePath).catch(() => {})));
    job.tempJsonPaths.clear();
    await diagnosticWrite;
  };
  cleanup().finally(() => { if (quitWhenIdle && runningJobs.size === 0 && pendingDiagnosticWrites.size === 0) app?.quit(); });
}

function describeWorkerFailure(worker, exitCode) {
  const fatal = worker.fatalEvent;
  const stderr = worker.stderrTail.trim();
  const reason = fatal?.message || worker.spawnError?.message || stderr;
  const code = fatal?.code || (worker.spawnError ? 'POWERSHELL_SPAWN_FAILED'
    : stderr ? 'WORKER_STDERR_FAILURE' : exitCode === 0 ? 'WORKER_EXITED_WITHOUT_RESULT' : 'WORKER_EXIT_FAILED');
  return {
    code,
    message: reason ? `변환 작업 오류: ${String(reason).slice(-MAX_STDERR_CHARS)}`
      : `변환 작업이 결과를 보고하지 않고 종료되었습니다. 종료 코드: ${exitCode}. 진단 로그를 확인해 주세요.`,
    details: { ...(fatal || {}), ...(stderr ? { stderrTail: stderr } : {}), exitCode },
  };
}

async function prepareWorkerRecovery(job, worker) {
  const pendingTasks = worker.tasks.filter((task) => !job.outcomes.has(task.id));
  if (job.cancelled) return [];
  const failingTask = job.taskById.get(worker.recycleRequest.taskId);
  const recoveryTasks = [];
  for (const task of pendingTasks) {
    if (task.id === failingTask.id && (job.recoveryAttempts.get(task.id) || 0) >= 1) {
      recordTaskFailure(job, task, 'PDF_OUTPUT_MISSING_AFTER_RETRY',
        `새 한글 엔진으로 한 번 재시도했지만 PDF가 생성되지 않았습니다. ${worker.recycleRequest.message || ''}`, worker.workerId);
      continue;
    }
    try {
      if (task.targets.some((target) => job.outputEvents.has(`${task.id}:${target}`))) {
        throw new Error('출력 파일이 이미 보고되어 안전하게 재시도할 수 없습니다.');
      }
      for (const outputPath of Object.values(task.plannedOutputPaths)) {
        try {
          await fsp.lstat(outputPath);
          throw Object.assign(new Error('출력 파일이 이미 존재하여 재시도를 중단했습니다. 원본을 보존합니다.'), { code: 'RECOVERY_OUTPUT_EXISTS' });
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const canonicalPath = await fsp.realpath(task.inputPath);
      const snapshot = snapshotFile(await fsp.stat(task.inputPath));
      if (pathKey(canonicalPath) !== pathKey(task.canonicalPath)
        || Object.keys(task.sourceSnapshot).some((key) => snapshot[key] !== task.sourceSnapshot[key])) {
        throw Object.assign(new Error('변환 중 원본이 변경되어 재시도를 중단했습니다. 원본을 보존합니다.'), { code: 'RECOVERY_SOURCE_CHANGED' });
      }
      recoveryTasks.push(task);
    } catch (error) {
      recordTaskFailure(job, task, error.code || 'WORKER_RECOVERY_UNSAFE', error.message, worker.workerId);
    }
  }
  if (job.cancelled) return [];
  if (recoveryTasks.includes(failingTask)) {
    job.recoveryAttempts.set(failingTask.id, (job.recoveryAttempts.get(failingTask.id) || 0) + 1);
  }
  if (recoveryTasks.length > 0) sendJobEvent(job, {
    type: 'log', ok: true, level: 'warn', code: 'WORKER_RECOVERY_STARTING', taskId: failingTask.id,
    inputPath: failingTask.inputPath, message: '한글 엔진을 새로 시작하여 미완료 문서를 계속 변환합니다.',
  });
  return recoveryTasks;
}

function consumeLines(job, worker, text, source) {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() || '';
  for (const line of lines) handleProcessLine(job, worker, line, source);
  return remainder.slice(-262144);
}

function handleProcessLine(job, worker, line, source) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let event;
  try { event = JSON.parse(trimmed); } catch (_error) {
    sendJobEvent(job, { workerId: worker.workerId, type: 'log', ok: source !== 'stderr', source,
      level: source === 'stderr' ? 'error' : 'info', message: trimmed });
    return;
  }
  // Serialize asynchronous output verification and trashing before the worker's close event.
  worker.events = worker.events.then(() => handleWorkerEvent(job, worker, event, source)).catch((error) => {
    const task = job.taskById.get(event?.taskId);
    if (task && worker.taskIds.has(task.id)) recordTaskFailure(job, task, 'RESULT_VERIFICATION_FAILED', error.message, worker.workerId);
    else {
      job.fatalCount += 1;
      sendJobEvent(job, { type: 'fatal', ok: false, workerId: worker.workerId, code: 'INVALID_WORKER_EVENT', message: error.message });
    }
  });
}

async function handleWorkerEvent(job, worker, event, source) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
  if (['start', 'complete', 'exit', 'cancelled'].includes(event.type)) return;
  if (event.type === 'worker-recycle') {
    const task = job.taskById.get(event.taskId);
    const valid = event.code === 'PDF_OUTPUT_MISSING' && task && worker.taskIds.has(task.id)
      && worker.activeTaskId === task.id && task.targets.includes('pdf') && !job.outcomes.has(task.id)
      && !task.targets.some((target) => job.outputEvents.has(`${task.id}:${target}`));
    if (!valid || (worker.recycleRequest && worker.recycleRequest.taskId !== event.taskId)) {
      worker.invalidRecycleReason = '유효한 현재 문서와 출력 상태를 확인할 수 없어 엔진 재시도를 거부했습니다.';
      worker.fatalEvent = { code: 'INVALID_WORKER_RECYCLE_REQUEST', message: worker.invalidRecycleReason };
      sendJobEvent(job, { type: 'log', ok: false, level: 'error', workerId: worker.workerId, ...worker.fatalEvent });
      return;
    }
    if (worker.recycleRequest) return;
    worker.recycleRequest = { taskId: task.id, code: event.code, message: event.message };
    sendJobEvent(job, { ...event, source, workerId: worker.workerId });
    return;
  }
  if (event.type === 'fatal') {
    if (worker.fatalReported) return;
    worker.fatalReported = true;
    worker.fatalEvent = event;
    job.fatalCount += 1;
    sendJobEvent(job, { ...event, source, workerId: worker.workerId, ok: false });
    return; // close reports every unfinished task, including COM startup failures.
  }
  const task = job.taskById.get(event.taskId);
  if (event.taskId && (!task || !worker.taskIds.has(task.id))) return;
  if (task && job.outcomes.has(task.id)) return;
  if (worker.recycleRequest && ['file-start', 'file-complete', 'file-error', 'output-complete'].includes(event.type)) {
    worker.invalidRecycleReason = '엔진 재시도 요청 이후 예상하지 못한 문서 결과를 받았습니다.';
    worker.fatalEvent = { code: 'INVALID_WORKER_RECYCLE_REQUEST', message: worker.invalidRecycleReason };
    return;
  }
  if (event.type === 'file-start' && task) worker.activeTaskId = task.id;
  if (event.type === 'file-error') {
    if (task) recordTaskFailure(job, task, event.code || 'CONVERSION_FAILED', event.message || 'Conversion failed.', worker.workerId, event);
    return;
  }
  if (event.type === 'file-cancelled') {
    if (task) recordTaskCancellation(job, task);
    return;
  }
  if (event.type === 'output-complete') {
    if (!task || !task.targets.includes(event.outputKind)) return;
    const planned = task.plannedOutputPaths[event.outputKind];
    if (typeof event.outputPath !== 'string' || pathKey(event.outputPath) !== pathKey(planned)) {
      throw new Error('Worker reported an output outside the reserved destination.');
    }
    const key = `${task.id}:${event.outputKind}`;
    if (job.outputEvents.has(key)) return;
    await assertValidOutput(planned, event.outputKind, job.outputValidationCache);
    job.outputEvents.add(key);
    job.summary[event.outputKind] += 1;
  }
  if (event.type === 'file-complete') {
    if (!task) return;
    const outputs = [];
    for (const target of task.targets) {
      await assertValidOutput(task.plannedOutputPaths[target], target, job.outputValidationCache);
      outputs.push({ kind: target, path: task.plannedOutputPaths[target] });
    }
    const deletion = job.options.deleteOriginal ? await maybeDeleteOriginal(job, task) : {};
    job.outcomes.set(task.id, 'succeeded');
    job.summary.succeeded += 1;
    for (const target of task.targets) {
      const key = `${task.id}:${target}`;
      if (!job.outputEvents.has(key)) { job.outputEvents.add(key); job.summary[target] += 1; }
    }
    sendJobEvent(job, { ...event, source, workerId: worker.workerId, taskId: task.id,
      inputPath: task.inputPath, ok: true, outputs, ...deletion });
    return;
  }
  sendJobEvent(job, { ...event, source, workerId: worker.workerId, ...(task ? { taskId: task.id, inputPath: task.inputPath } : {}) });
}

function recordTaskFailure(job, task, code, message, workerId, details = {}) {
  if (job.outcomes.has(task.id)) return;
  job.outcomes.set(task.id, 'failed');
  job.summary.failed += 1;
  job.diagnosticFailures.push({ taskId: task.id, inputPath: task.inputPath, code, message: String(message).slice(-MAX_STDERR_CHARS) });
  if (job.diagnosticFailures.length > MAX_DIAGNOSTIC_EVENTS) job.diagnosticFailures.shift();
  sendJobEvent(job, { ...details, type: 'file-error', ok: false, source: 'main', taskId: task.id,
    inputPath: task.inputPath, code, message, workerId });
}

function recordTaskCancellation(job, task) {
  if (job.outcomes.has(task.id)) return;
  job.outcomes.set(task.id, 'cancelled');
  job.summary.cancelled += 1;
  sendJobEvent(job, { type: 'file-cancelled', ok: false, taskId: task.id, inputPath: task.inputPath,
    code: 'CANCELLED', message: 'Conversion was cancelled; the original was retained.' });
}

async function assertValidOutput(filePath, target, validationCache) {
  const stat = await fsp.lstat(filePath);
  if (!stat.isFile() || stat.size < 5) throw new Error(`Output is missing or empty: ${filePath}`);
  const snapshot = snapshotFile(stat);
  const cacheKey = `${target}:${pathKey(filePath)}`;
  const cached = validationCache?.get(cacheKey);
  if (cached && Object.keys(snapshot).every((key) => snapshot[key] === cached[key])) return;
  const file = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(5);
    await file.read(header, 0, header.length, 0);
    const valid = target === 'pdf' ? header.toString('ascii') === '%PDF-'
      : header[0] === 0x50 && header[1] === 0x4b && header[2] === 3 && header[3] === 4;
    if (!valid) throw new Error(`Output has an invalid ${target.toUpperCase()} header: ${filePath}`);
    if (target === 'pdf') {
      const bytes = await file.readFile();
      const document = await PDFDocument.load(bytes, {
        throwOnInvalidObject: true, ignoreEncryption: false, updateMetadata: false,
      });
      const pages = document.getPages();
      if (pages.length === 0) throw new Error(`PDF contains no pages: ${filePath}`);
      for (const page of pages) {
        const { width, height } = page.getSize();
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error(`PDF contains an invalid page size: ${filePath}`);
        }
      }
    }
  } finally { await file.close(); }
  const finalStat = await fsp.lstat(filePath);
  const finalSnapshot = snapshotFile(finalStat);
  if (!finalStat.isFile() || Object.keys(snapshot).some((key) => snapshot[key] !== finalSnapshot[key])) {
    throw new Error(`Output changed during validation: ${filePath}`);
  }
  // Cache only the verified file identity, never the document/bytes. Before trashing,
  // another stat check invalidates this cache if any output changed or was replaced.
  validationCache?.set(cacheKey, snapshot);
}

async function maybeDeleteOriginal(job, task) {
  try {
    if (job.cancelled) throw new Error('Cancellation requested; original retained.');
    const canonicalPath = await fsp.realpath(task.inputPath);
    const current = snapshotFile(await fsp.stat(task.inputPath));
    if (pathKey(canonicalPath) !== pathKey(task.canonicalPath)
      || Object.keys(task.sourceSnapshot).some((key) => current[key] !== task.sourceSnapshot[key])) {
      throw new Error('The source changed during conversion; original retained.');
    }
    // Every selected output is checked again immediately before moving the source to the Recycle Bin.
    for (const target of task.targets) await assertValidOutput(task.plannedOutputPaths[target], target, job.outputValidationCache);
    const finalSnapshot = snapshotFile(await fsp.stat(task.inputPath));
    if (job.cancelled || Object.keys(task.sourceSnapshot).some((key) => finalSnapshot[key] !== task.sourceSnapshot[key])) {
      throw new Error('The source changed or cancellation was requested; original retained.');
    }
    await shell.trashItem(task.inputPath);
    return { originalDeleted: true };
  } catch (error) {
    sendJobEvent(job, { type: 'source-delete-skipped', ok: false, level: 'warn', taskId: task.id,
      inputPath: task.inputPath, code: 'ORIGINAL_RETAINED', message: error.message });
    return { originalDeleted: false, deletionWarning: error.message };
  }
}

function requestJobCancellation(job) {
  if (job.finished) return Promise.resolve();
  if (job.cancelPromise) return job.cancelPromise;
  job.cancelled = true;
  job.cancelPromise = fsp.writeFile(job.options.cancelPath, 'cancel', 'utf8').catch((error) => {
    sendJobEvent(job, { type: 'log', ok: false, level: 'error', code: 'CANCEL_MARKER_FAILED', message: error.message });
  });
  sendJobEvent(job, { type: 'cancel-requested', ok: true,
    message: 'Stopping after the current Hancom operation. Originals will be retained.' });
  return job.cancelPromise;
}

function sendJobEvent(job, payload) {
  const event = { ...payload, timestamp: new Date().toISOString(), runId: job.runId };
  job.diagnosticEvents.push(toDiagnosticEvent(event));
  if (job.diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) job.diagnosticEvents.shift();
  if (!job.webContents || job.webContents.isDestroyed()) return;
  job.webContents.send(CHANNELS.event, event);
}

function toDiagnosticEvent(event) {
  const keys = ['timestamp', 'runId', 'type', 'ok', 'workerId', 'taskId', 'inputPath', 'outputPath',
    'outputKind', 'code', 'message', 'level', 'source', 'stage', 'exitCode', 'signal', 'originalDeleted',
    'deletionWarning', 'details', 'stderrTail', 'scriptStackTrace', 'summary', 'durationMs', 'metrics'];
  const result = {};
  for (const key of keys) {
    const value = event[key];
    if (value === undefined) continue;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'string') result[key] = value.slice(-MAX_STDERR_CHARS);
    else if (key === 'summary') result[key] = { ...value };
    else if (key === 'metrics') {
      const serialized = JSON.stringify(value);
      result[key] = serialized.length <= MAX_STDERR_CHARS ? JSON.parse(serialized)
        : { truncated: true, preview: serialized.slice(0, MAX_STDERR_CHARS) };
    }
    else result[key] = JSON.stringify(value).slice(-MAX_STDERR_CHARS);
  }
  return result;
}

function queueLatestRunDiagnostic(job) {
  let diagnosticPath;
  let appVersion;
  try {
    if (!app?.getPath) return Promise.resolve();
    diagnosticPath = path.join(app.getPath('userData'), 'logs', 'latest-run.json');
    appVersion = app.getVersion?.() || 'unknown';
  } catch (error) {
    console.warn('Could not resolve the conversion diagnostic path:', error.message);
    return Promise.resolve();
  }
  const report = {
    schemaVersion: 1,
    runId: job.runId,
    startedAt: job.startedAt,
    finishedAt: new Date().toISOString(),
    versions: { app: appVersion, electron: process.versions.electron || null, node: process.versions.node,
      platform: process.platform, arch: process.arch, osRelease: os.release() },
    scriptPath: job.scriptPath,
    summary: { ...job.summary },
    cancelled: job.cancelled,
    failures: [...job.diagnosticFailures],
    events: [...job.diagnosticEvents],
  };
  const write = diagnosticWriteQueue.then(async () => {
    const temporaryPath = path.join(path.dirname(diagnosticPath), `latest-run-${job.runId}.tmp`);
    try {
      await fsp.mkdir(path.dirname(diagnosticPath), { recursive: true });
      await fsp.writeFile(temporaryPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(temporaryPath, diagnosticPath);
    } catch (error) {
      await fsp.unlink(temporaryPath).catch(() => {});
      console.warn('Could not save the conversion diagnostic log:', error.message);
    }
  });
  diagnosticWriteQueue = write.catch(() => {});
  pendingDiagnosticWrites.add(write);
  write.finally(() => pendingDiagnosticWrites.delete(write));
  return write;
}


function runJsonScript(scriptName) {
  return new Promise(async (resolve, reject) => {
    const scriptPath = resolveScriptPath(scriptName);

    try {
      await assertFileExists(scriptPath, 'SCRIPT_MISSING');
    } catch (error) {
      reject(error);
      return;
    }

    const child = spawn(getPowerShellExecutable(), [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      scriptPath,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let lastJson = null;

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseJsonLine(line);
        if (parsed) {
          lastJson = parsed;
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (exitCode) => {
      const trailingJson = parseJsonLine(stdoutBuffer);
      if (trailingJson) {
        lastJson = trailingJson;
      }

      if (lastJson) {
        resolve({
          ...lastJson,
          exitCode,
        });
        return;
      }

      resolve({
        ok: false,
        type: 'script-result',
        code: 'SCRIPT_DID_NOT_RETURN_JSON',
        message: 'The PowerShell script finished without a JSON result.',
        exitCode,
        stderr: stderrBuffer.trim(),
      });
    });
  });
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return null;
  }
}

function resolveScriptPath(scriptName) {
  const developmentPath = path.join(__dirname, '..', 'scripts', scriptName);
  if (fs.existsSync(developmentPath)) {
    return developmentPath;
  }

  if (process.resourcesPath) {
    return path.join(process.resourcesPath, 'scripts', scriptName);
  }

  return developmentPath;
}

async function assertFileExists(filePath, code) {
  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${filePath} is not a file.`);
    }
  } catch (error) {
    error.code = code;
    throw error;
  }
}

function getPowerShellExecutable() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const windowsPowerShell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

  return fs.existsSync(windowsPowerShell) ? windowsPowerShell : 'powershell.exe';
}

if (app) {
  app.whenReady().then(() => {
    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    if (runningJobs.size === 0 && pendingDiagnosticWrites.size === 0) return;
    // Let the owned workers release COM cleanly; never kill the user's other Hancom documents.
    event.preventDefault();
    quitWhenIdle = true;
    for (const job of runningJobs.values()) requestJobCancellation(job).catch(() => {});
  });
}

module.exports = {
  CHANNELS,
  validateStartPayload,
  resolveScriptPath,
  startConversionJob,
  registerIpcHandlers,
};
