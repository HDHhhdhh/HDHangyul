/** Pure queue and outcome rules, shared by the renderer and Node tests. */
export const TARGETS = ['hwpx', 'pdf'];
export const STATUS_LABELS = {
  ready: '준비됨', queued: '대기 중', running: '변환 중',
  success: '완료', failed: '실패', cancelled: '취소됨',
};

export function pathKey(path) {
  return String(path || '').replaceAll('/', '\\').toLowerCase();
}

export function supportsTarget(format, target) {
  return target === 'pdf' || (target === 'hwpx' && ['hwp', 'hml'].includes(format));
}

export function addDocuments(existing, incoming, idFactory = () => crypto.randomUUID()) {
  const seen = new Set(existing.map(file => pathKey(file.path)));
  const added = [];
  let duplicateCount = 0;
  let unsupportedCount = 0;
  for (const file of incoming || []) {
    // The preload resolves actual absolute paths. Never substitute a display name.
    const path = typeof file.path === 'string' ? file.path : '';
    const format = path.split('.').at(-1)?.toLowerCase();
    if (!path || !['hwp', 'hml', 'hwpx'].includes(format)) {
      unsupportedCount++;
      continue;
    }
    const key = pathKey(path);
    if (seen.has(key)) {
      duplicateCount++;
      continue;
    }
    seen.add(key);
    added.push({
      id: idFactory(), path, name: file.name || path.split(/[\\/]/).at(-1),
      size: file.size, format, targets: TARGETS.filter(target => supportsTarget(format, target)),
      status: 'ready', progress: 0, message: '', results: [], originalDeleted: false,
    });
  }
  return { documents: [...existing, ...added], addedCount: added.length, duplicateCount, unsupportedCount };
}

function putResult(results, result) {
  return [...results.filter(previous => previous.target !== result.target), result];
}

export function applyDocumentEvent(document, event) {
  if (event.taskId !== document.id) return document;
  const next = { ...document };
  if (event.type === 'started') {
    next.status = 'running';
    next.progress = 4;
  } else if (event.type === 'progress') {
    next.progress = Math.max(next.progress, Math.min(95, Number(event.progress) || 0));
  } else if (event.type === 'output') {
    next.results = putResult(next.results, {
      taskId: document.id, target: event.target, status: event.status,
      outputPath: event.outputPath, error: event.error, message: event.message,
    });
    // One successful target is not a successfully converted document.
    next.progress = Math.max(next.progress, 35 + Math.round(55 * next.results.length / next.targets.length));
  } else if (event.type === 'file-complete') {
    for (const output of event.outputs || []) {
      next.results = putResult(next.results, {
        taskId: document.id, target: output.kind, status: 'success', outputPath: output.path,
      });
    }
    const allSucceeded = next.targets.length > 0 && next.targets.every(target =>
      next.results.some(result => result.target === target && result.status === 'success'));
    next.status = event.ok !== false && allSucceeded ? 'success' : 'failed';
    next.progress = 100;
    next.originalDeleted = event.originalDeleted === true;
    next.message = next.status === 'success'
      ? (event.deletionWarning ? `완료 · 원본 보관: ${event.deletionWarning}` : next.originalDeleted ? '완료 · 원본을 휴지통으로 이동' : '완료')
      : '일부 출력이 완료되지 않았습니다.';
    return next;
  } else if (event.type === 'failed' || event.type === 'file-cancelled') {
    next.status = event.type === 'file-cancelled' ? 'cancelled' : 'failed';
    next.progress = 100;
    for (const target of next.targets) {
      if (!next.results.some(result => result.target === target && result.status === 'success')) {
        next.results = putResult(next.results, {
          taskId: document.id, target, status: next.status,
          error: event.error, message: event.message || STATUS_LABELS[next.status],
        });
      }
    }
  }
  if (event.message) next.message = event.message;
  return next;
}

export function finishUnresolved(documents, taskIds, { cancelled = false, message } = {}) {
  return documents.map(document => {
    if (!taskIds.has(document.id) || !['queued', 'running'].includes(document.status)) return document;
    return applyDocumentEvent(document, {
      type: cancelled ? 'file-cancelled' : 'failed', taskId: document.id,
      error: cancelled ? 'CANCELLED' : 'MISSING_FILE_RESULT',
      message: message || (cancelled ? '변환이 취소되었습니다.' : '문서의 완료 결과를 받지 못했습니다.'),
    });
  });
}

export function summarize(documents) {
  return {
    files: documents.length,
    targets: documents.reduce((total, file) => total + file.targets.length, 0),
    completed: documents.filter(file => file.status === 'success').length,
    failed: documents.filter(file => file.status === 'failed').length,
    cancelled: documents.filter(file => file.status === 'cancelled').length,
    progress: documents.length ? Math.round(documents.reduce((total, file) => total + file.progress, 0) / documents.length) : 0,
  };
}

/** Capture at window level so drops on buttons, options and logs follow one path. */
export function installFileDropHandlers(surface, { onFiles, onDragState, onError }) {
  let depth = 0;
  const isFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  const enter = event => {
    if (!isFiles(event)) return;
    event.preventDefault();
    depth++;
    onDragState(true);
  };
  const over = event => {
    if (!isFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const leave = event => {
    if (!isFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) onDragState(false);
  };
  const drop = event => {
    event.preventDefault();
    event.stopPropagation();
    depth = 0;
    onDragState(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length) Promise.resolve(onFiles(files)).catch(onError);
  };
  const handlers = { dragenter: enter, dragover: over, dragleave: leave, drop };
  for (const [name, handler] of Object.entries(handlers)) surface.addEventListener(name, handler, true);
  return () => {
    for (const [name, handler] of Object.entries(handlers)) surface.removeEventListener(name, handler, true);
  };
}
