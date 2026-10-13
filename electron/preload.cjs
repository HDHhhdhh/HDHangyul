'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('node:path');

const CHANNELS = Object.freeze({
  selectFiles: 'conversion:select-files', selectInputDirectory: 'conversion:select-input-directory',
  selectOutputDirectory: 'conversion:select-output-directory', checkHancom: 'conversion:check-hancom',
  start: 'conversion:start', cancel: 'conversion:cancel', event: 'conversion:event',
});
let activeRun = null;

function subscribe(listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(CHANNELS.event, wrapped);
  return () => ipcRenderer.removeListener(CHANNELS.event, wrapped);
}

function normalizeFile(filePath, metadata = {}) {
  if (typeof filePath !== 'string' || !path.win32.isAbsolute(filePath)) return null;
  const normalizedPath = path.win32.normalize(filePath);
  return {
    path: normalizedPath, name: path.win32.basename(normalizedPath),
    format: path.win32.extname(normalizedPath).slice(1).toLowerCase(), size: metadata.size,
  };
}

function normalizeSelectedFiles(result) {
  const files = Array.isArray(result) ? result : result?.files || [];
  return files.map(file => typeof file === 'string'
    ? normalizeFile(file) : normalizeFile(file?.path || file?.inputPath, file)).filter(Boolean);
}

function normalizeDroppedFiles(files) {
  return Array.from(files || []).map(file => normalizeFile(webUtils.getPathForFile(file), file)).filter(Boolean);
}

function normalizeDirectory(result) {
  if (!result || result.canceled) return null;
  const directory = typeof result === 'string' ? result : result.directory || result.path;
  if (!directory) return null;
  return { path: path.win32.normalize(directory), displayName: path.win32.basename(directory) || directory };
}

function normalizeEngineResult(result) {
  const ready = result?.ok === true;
  return {
    state: ready ? 'ready' : result?.code === 'HANCOM_COM_UNAVAILABLE' ? 'missing' : 'error',
    checkedAt: new Date().toISOString(), version: result?.version,
    message: ready
      ? `한컴 자동화 엔진이 준비되었습니다.${result.version ? ` (${result.version})` : ''}`
      : result?.message || '한컴 자동화 엔진을 사용할 수 없습니다.',
  };
}

function normalizeConversionRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('변환 요청이 비어 있습니다.');
  const options = request.options || {};
  return {
    tasks: (Array.isArray(request.tasks) ? request.tasks : []).map(task => ({
      id: task.id, inputPath: task.inputPath, inputName: task.inputName,
      sourceFormat: task.sourceFormat, targets: Array.isArray(task.targets) ? task.targets : [],
    })),
    options: {
      outputDir: request.outputDirectory || null, deleteOriginal: options.deleteOriginal === true,
      createSubfolders: options.createSubfolders === true,
      parallelism: Number.isFinite(Number(options.parallelism)) ? Number(options.parallelism) : 2,
      visible: false,
    },
  };
}

function toUiEvent(raw) {
  const taskId = raw?.taskId;
  const target = raw?.outputKind || raw?.target;
  switch (raw?.type) {
    case 'spawned':
      return { type: 'log', level: 'info', message: `백그라운드 변환을 시작했습니다. 동시 작업 ${raw.parallelism || 1}개` };
    case 'start':
      return { type: 'log', level: 'info', message: '변환 작업을 시작합니다.' };
    case 'file-start':
      return { type: 'started', taskId, message: `${raw.inputName || path.win32.basename(raw.inputPath || '')} 변환 중` };
    case 'file-opened':
      return { type: 'progress', taskId, progress: 35, message: '문서를 열었습니다.' };
    case 'output-complete':
      return { type: 'output', taskId, target, status: 'success', outputPath: raw.outputPath, message: `${String(target || '').toUpperCase()} 저장 완료` };
    case 'output-error':
    case 'output-skipped':
      return { type: 'output', taskId, target, status: 'failed', error: raw.code || 'OUTPUT_FAILED', message: raw.message || '출력을 저장하지 못했습니다.' };
    case 'file-complete':
      return {
        type: 'file-complete', taskId, ok: raw.ok, outputs: raw.outputs,
        originalDeleted: raw.originalDeleted, deletionWarning: raw.deletionWarning,
        message: raw.message || '문서 변환을 마쳤습니다.',
      };
    case 'file-error':
      return { type: 'failed', taskId, error: raw.code || 'CONVERSION_FAILED', message: raw.message || '문서 변환에 실패했습니다.' };
    case 'fatal':
      // A worker failure does not fail healthy workers. Main emits each task's terminal outcome.
      return { type: 'log', level: 'error', taskId, message: raw.message || '변환 작업자 오류가 발생했습니다.' };
    case 'file-cancelled':
      return { type: 'file-cancelled', taskId, error: raw.code || 'CANCELLED', message: raw.message || '문서 변환이 취소되었습니다.' };
    case 'complete':
    case 'cancelled':
      return { type: 'summary', ...raw.summary, message: raw.type === 'cancelled' ? '변환이 취소되었습니다.' : '변환 작업이 끝났습니다.' };
    case 'source-delete-skipped':
      return { type: 'log', taskId, level: 'warning', message: raw.message || '결과를 저장했지만 원본은 보관했습니다.' };
    case 'cancel-requested':
      return { type: 'log', level: 'warning', message: '취소 요청을 처리하고 있습니다.' };
    case 'log':
      return { type: 'log', taskId, level: raw.level || (raw.ok === false ? 'warning' : 'info'), message: raw.message || raw.code || '변환 로그' };
    default: return null;
  }
}

function startConversion(request, onEvent) {
  if (activeRun) return Promise.reject(new Error('이미 변환 작업이 진행 중입니다.'));
  const payload = normalizeConversionRequest(request);
  const run = { runId: null, cancelPending: false, cancelSent: false };
  activeRun = run;
  return new Promise((resolve, reject) => {
    const summary = { completed: 0, failed: 0, cancelled: false };
    const unsubscribe = subscribe(raw => {
      if (!raw || (run.runId && raw.runId && raw.runId !== run.runId)) return;
      if (raw.type === 'complete' || raw.type === 'cancelled') {
        summary.completed = raw.summary?.succeeded || 0;
        summary.failed = raw.summary?.failed || 0;
        summary.cancelled = raw.type === 'cancelled' || Number(raw.summary?.cancelled) > 0;
      }
      const uiEvent = toUiEvent(raw);
      if (uiEvent && typeof onEvent === 'function') onEvent(uiEvent);
      if (raw.type === 'exit') {
        summary.cancelled = summary.cancelled || raw.cancelled === true;
        unsubscribe();
        if (activeRun === run) activeRun = null;
        resolve(summary);
      }
    });
    ipcRenderer.invoke(CHANNELS.start, payload).then(async started => {
      if (!started?.ok) throw new Error(started?.message || '변환 프로세스를 시작하지 못했습니다.');
      run.runId = started.runId;
      if (run.cancelPending && !run.cancelSent && activeRun === run) {
        run.cancelSent = true;
        try {
          const result = await ipcRenderer.invoke(CHANNELS.cancel, run.runId);
          if (!result?.ok) throw new Error(result?.message || '취소 요청을 처리하지 못했습니다.');
        } catch (error) {
          run.cancelSent = false;
          if (typeof onEvent === 'function') onEvent({ type: 'cancel-error', message: error.message });
        }
      }
    }).catch(error => {
      unsubscribe();
      if (activeRun === run) activeRun = null;
      reject(error);
    });
  });
}

async function cancelConversion() {
  const run = activeRun;
  if (!run) return { ok: false, message: '진행 중인 변환이 없습니다.' };
  run.cancelPending = true;
  if (!run.runId || run.cancelSent) return { ok: true, pending: true };
  run.cancelSent = true;
  try {
    const result = await ipcRenderer.invoke(CHANNELS.cancel, run.runId);
    if (!result?.ok) run.cancelSent = false;
    return result;
  } catch (error) {
    run.cancelSent = false;
    throw error;
  }
}

contextBridge.exposeInMainWorld('converter', {
  async selectFiles() { return normalizeSelectedFiles(await ipcRenderer.invoke(CHANNELS.selectFiles)); },
  async selectInputDirectory() {
    const result = await ipcRenderer.invoke(CHANNELS.selectInputDirectory);
    const directory = normalizeDirectory(result);
    return directory ? { ...directory, files: normalizeSelectedFiles(result) } : null;
  },
  async resolveDroppedFiles(files) { return normalizeDroppedFiles(files); },
  async selectOutputDirectory() { return normalizeDirectory(await ipcRenderer.invoke(CHANNELS.selectOutputDirectory)); },
  async checkEngine() { return normalizeEngineResult(await ipcRenderer.invoke(CHANNELS.checkHancom)); },
  startConversion, cancelConversion,
});
