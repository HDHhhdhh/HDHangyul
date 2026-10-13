import {
  TARGETS, STATUS_LABELS, addDocuments, supportsTarget, applyDocumentEvent,
  finishUnresolved, summarize, installFileDropHandlers,
} from './ui-model.js';

const byId = id => document.getElementById(id);
const converter = window.converter;
const state = {
  documents: [], outputDirectory: null, busy: false, cancelling: false,
  checking: false, engineReady: false, activeTaskIds: new Set(),
};
const rows = new Map();
let updateScheduled = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function log(message, level = 'info', announce = false) {
  const row = element('div', `log-row ${level}`);
  row.append(element('time', '', new Date().toLocaleTimeString('ko-KR')), element('span', '', message));
  const list = byId('log-list');
  list.append(row);
  while (list.children.length > 200) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
  byId('log-count').textContent = `${list.children.length}개 항목`;
  if (announce) {
    byId('notice').textContent = message;
    byId('notice').className = `notice ${level}`;
  }
}

function errorMessage(error) {
  return error?.message || String(error || '작업 중 오류가 발생했습니다.');
}

async function safely(action) {
  try { await action(); } catch (error) { log(errorMessage(error), 'error', true); }
}

function addFiles(files) {
  if (state.busy) {
    log('변환 중에는 문서를 추가할 수 없습니다. 완료하거나 취소한 뒤 다시 놓아 주세요.', 'warning', true);
    return;
  }
  const result = addDocuments(state.documents, files);
  state.documents = result.documents;
  if (result.addedCount) log(`${result.addedCount}개 문서를 추가했습니다.`, 'success', true);
  if (result.duplicateCount) log(`이미 목록에 있는 문서 ${result.duplicateCount}개를 제외했습니다.`, 'warning', true);
  if (result.unsupportedCount || !files?.length) log('HWP, HML, HWPX 파일만 추가할 수 있습니다.', 'warning', true);
  renderDocuments();
  renderSummary();
}

function resetDocument(file, targets) {
  return { ...file, targets, status: 'ready', progress: 0, message: '', results: [], originalDeleted: false };
}

function setTarget(id, target, selected) {
  if (state.busy) return;
  state.documents = state.documents.map(file => {
    if ((id && file.id !== id) || file.originalDeleted || !supportsTarget(file.format, target)) return file;
    const targets = new Set(file.targets);
    if (selected) targets.add(target); else targets.delete(target);
    return resetDocument(file, TARGETS.filter(item => targets.has(item)));
  });
  renderDocuments();
  renderSummary();
  renderResults();
}

function renderDocuments() {
  rows.clear();
  const fragment = document.createDocumentFragment();
  for (const file of state.documents) {
    const row = element('article', `document-row ${file.status}`);
    const mark = element('div', 'file-mark');
    mark.append(element('span', '', file.format.toUpperCase()));
    const main = element('div', 'document-main');
    const title = element('div', 'document-title-line');
    const name = element('strong', '', file.name);
    name.title = file.path;
    title.append(name);
    const path = element('div', 'document-path', file.path);
    path.title = file.path;
    const controls = element('div', 'document-controls');
    for (const target of TARGETS) {
      const label = element('label', 'check-control');
      const input = element('input');
      input.type = 'checkbox';
      input.checked = file.targets.includes(target);
      input.disabled = state.busy || file.originalDeleted || !supportsTarget(file.format, target);
      input.addEventListener('change', () => setTarget(file.id, target, input.checked));
      label.append(input, element('span', '', target.toUpperCase()));
      controls.append(label);
    }
    controls.append(element('span', 'target-summary', file.targets.map(target => target.toUpperCase()).join(' + ') || '대상 없음'));
    main.append(title, path, controls);
    const progress = element('div', 'document-progress');
    const message = element('span', '', file.message || STATUS_LABELS[file.status]);
    const track = element('div', 'progress-track');
    const fill = element('span', 'progress-fill');
    fill.style.width = `${file.progress}%`;
    track.append(fill);
    progress.append(message, track);
    const remove = element('button', 'icon-button', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `${file.name} 제거`);
    remove.disabled = state.busy;
    remove.addEventListener('click', () => {
      if (state.busy) return;
      state.documents = state.documents.filter(item => item.id !== file.id);
      renderDocuments(); renderSummary(); renderResults();
    });
    row.append(mark, main, progress, remove);
    rows.set(file.id, { row, message, fill });
    fragment.append(row);
  }
  byId('document-list').replaceChildren(fragment);
  byId('empty-state').hidden = state.documents.length > 0;
}

function renderSummary() {
  const summary = summarize(state.documents);
  byId('file-count').textContent = summary.files;
  byId('target-count').textContent = summary.targets;
  byId('completed-count').textContent = summary.completed;
  byId('failed-count').textContent = `${summary.failed} / ${summary.cancelled}`;
  byId('overall-fill').style.width = `${summary.progress}%`;
  byId('overall-label').textContent = `${summary.progress}%`;
  const eligibleCount = state.documents.filter(file => file.targets.length && !file.originalDeleted).length;
  byId('selection-count').textContent = `${eligibleCount}개 문서가 선택되었습니다.`;
  for (const id of ['select-files', 'select-folder', 'select-output', 'reset-output', 'delete-original', 'create-subfolders', 'parallelism']) byId(id).disabled = state.busy;
  byId('clear-files').disabled = state.busy || !summary.files;
  for (const button of byId('presets').querySelectorAll('button')) button.disabled = state.busy || !summary.files;
  byId('check-engine').disabled = state.busy || state.checking;
  byId('run').disabled = state.busy || !eligibleCount || !converter;
  byId('run').textContent = state.busy ? '변환 중…' : '▶ 일괄 변환 실행';
  byId('cancel').hidden = !state.busy;
  byId('cancel').disabled = state.cancelling;
  byId('cancel').textContent = state.cancelling ? '취소 처리 중…' : '변환 취소';
}

function renderResults() {
  const results = state.documents.flatMap(file => file.results.map(result => ({ ...result, name: file.name })));
  byId('result-count').textContent = `${results.length}개 출력`;
  if (!results.length) {
    byId('result-list').replaceChildren(element('div', 'result-empty', '아직 생성된 결과가 없습니다.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const result of results) {
    const row = element('div', `result-row ${result.status}`);
    row.append(element('span', 'result-symbol', result.status === 'success' ? '✓' : '!'));
    const details = element('div');
    const text = result.outputPath || result.message || result.error;
    const path = element('span', '', text);
    path.title = text || '';
    details.append(element('strong', '', `${result.name} · ${result.target?.toUpperCase() || '문서'}`), path);
    row.append(details);
    fragment.append(row);
  }
  byId('result-list').replaceChildren(fragment);
}

function scheduleProgressRender() {
  if (updateScheduled) return;
  updateScheduled = true;
  requestAnimationFrame(() => {
    updateScheduled = false;
    for (const file of state.documents) {
      const nodes = rows.get(file.id);
      if (!nodes) continue;
      nodes.row.className = `document-row ${file.status}`;
      nodes.message.textContent = file.message || STATUS_LABELS[file.status];
      nodes.fill.style.width = `${file.progress}%`;
    }
    renderSummary(); renderResults();
  });
}

function onConversionEvent(event) {
  if (event.type === 'cancel-error') {
    state.cancelling = false;
    renderSummary();
    log(event.message, 'warning', true);
    return;
  }
  if (event.type === 'log') {
    log(event.message, event.level === 'warn' ? 'warning' : event.level || 'info');
    return;
  }
  if (event.type === 'failed' && !event.taskId) {
    state.documents = finishUnresolved(state.documents, state.activeTaskIds, { message: event.message });
  } else if (event.taskId) {
    state.documents = state.documents.map(file => applyDocumentEvent(file, event));
  }
  if (event.message) log(event.message, ['failed', 'file-cancelled'].includes(event.type) || event.status === 'failed' ? 'warning' : event.type === 'file-complete' ? 'success' : 'info');
  scheduleProgressRender();
}

async function runConversion() {
  if (state.busy || !converter) return;
  const selected = state.documents.filter(file => file.targets.length > 0 && !file.originalDeleted);
  if (!selected.length) return log('변환할 원본 문서가 없습니다. 새 문서를 추가해 주세요.', 'warning', true);
  state.busy = true;
  state.cancelling = false;
  state.activeTaskIds = new Set(selected.map(file => file.id));
  state.documents = state.documents.map(file => state.activeTaskIds.has(file.id)
    ? { ...resetDocument(file, file.targets), status: 'queued', message: '대기 중' } : file);
  renderDocuments(); renderSummary(); renderResults();
  log(`${selected.length}개 문서 변환을 시작합니다. 변환 중 문서 추가는 잠시 중지됩니다.`, 'info', true);
  try {
    const summary = await converter.startConversion({
      outputDirectory: state.outputDirectory,
      tasks: selected.map(file => ({ id: file.id, inputPath: file.path, inputName: file.name, sourceFormat: file.format, targets: file.targets })),
      options: {
        deleteOriginal: byId('delete-original').checked,
        createSubfolders: byId('create-subfolders').checked,
        parallelism: Number(byId('parallelism').value),
      },
    }, onConversionEvent);
    state.documents = finishUnresolved(state.documents, state.activeTaskIds, { cancelled: summary.cancelled === true });
    const count = summarize(state.documents.filter(file => state.activeTaskIds.has(file.id)));
    log(`변환 종료: 완료 ${count.completed}개, 실패 ${count.failed}개, 취소 ${count.cancelled}개.`, count.failed || count.cancelled ? 'warning' : 'success', true);
  } catch (error) {
    state.documents = finishUnresolved(state.documents, state.activeTaskIds, { message: errorMessage(error) });
    log(errorMessage(error), 'error', true);
  } finally {
    state.busy = false;
    state.cancelling = false;
    state.activeTaskIds.clear();
    renderDocuments(); renderSummary(); renderResults();
  }
}

async function checkEngine() {
  if (state.busy || state.checking || !converter) return;
  state.checking = true;
  byId('engine-label').textContent = '점검 중';
  byId('engine-pill').className = 'engine-pill working';
  renderSummary();
  try {
    const engine = await converter.checkEngine();
    state.engineReady = engine.state === 'ready';
    byId('engine-label').textContent = state.engineReady ? '엔진 정상' : '엔진 확인 필요';
    byId('engine-pill').className = `engine-pill ${state.engineReady ? 'success' : 'danger'}`;
    byId('engine-message').textContent = engine.message;
    byId('engine-time').textContent = new Date(engine.checkedAt).toLocaleString('ko-KR');
    for (const label of document.querySelectorAll('.capability-status')) label.textContent = state.engineReady ? '정상' : '확인';
    for (const dot of document.querySelectorAll('.mini-dot')) dot.className = `mini-dot ${state.engineReady ? 'success' : 'danger'}`;
    log(engine.message, state.engineReady ? 'success' : 'warning');
  } catch (error) {
    byId('engine-label').textContent = '엔진 확인 필요';
    byId('engine-pill').className = 'engine-pill danger';
    byId('engine-message').textContent = errorMessage(error);
    log(errorMessage(error), 'error', true);
  } finally {
    state.checking = false;
    renderSummary();
  }
}

function renderOutputDirectory() {
  const common = Boolean(state.outputDirectory);
  byId('output-mode').textContent = common ? '모든 결과를 선택한 폴더에 저장' : '각 문서의 원본 폴더';
  byId('output-directory').textContent = state.outputDirectory || '문서마다 원본이 있는 폴더에 저장합니다.';
  byId('output-directory').title = state.outputDirectory || '';
  byId('output-hint').textContent = common ? '원본별 저장으로 돌아가려면 아래 버튼을 누르세요.' : '여러 경로에서 가져온 문서는 각각의 경로에 저장됩니다.';
  byId('reset-output').hidden = !common;
}

byId('select-files').addEventListener('click', () => safely(async () => addFiles(await converter.selectFiles())));
byId('select-folder').addEventListener('click', () => safely(async () => {
  const folder = await converter.selectInputDirectory();
  if (folder) addFiles(folder.files);
}));
byId('clear-files').addEventListener('click', () => {
  if (state.busy) return;
  state.documents = [];
  renderDocuments(); renderSummary(); renderResults();
  log('문서 목록을 비웠습니다.', 'info', true);
});
byId('select-output').addEventListener('click', () => safely(async () => {
  const folder = await converter.selectOutputDirectory();
  if (folder?.path) { state.outputDirectory = folder.path; renderOutputDirectory(); }
}));
byId('reset-output').addEventListener('click', () => { state.outputDirectory = null; renderOutputDirectory(); });
byId('presets').addEventListener('click', event => {
  const button = event.target.closest('button[data-target]');
  if (button) setTarget(null, button.dataset.target, button.dataset.selected === 'true');
});
byId('check-engine').addEventListener('click', checkEngine);
byId('run').addEventListener('click', runConversion);
byId('cancel').addEventListener('click', () => safely(async () => {
  if (!state.busy || state.cancelling) return;
  state.cancelling = true;
  renderSummary();
  try {
    const result = await converter.cancelConversion();
    if (result?.ok === false) throw new Error(result.message || '취소 요청을 처리하지 못했습니다.');
  } catch (error) {
    state.cancelling = false;
    renderSummary();
    throw error;
  }
  log('취소를 요청했습니다. 처리 중인 문서를 정리하고 있습니다.', 'warning', true);
}));

installFileDropHandlers(window, {
  onFiles: async files => {
    if (state.busy) { addFiles([]); return; }
    if (!converter) throw new Error('데스크톱 앱에서 실행해야 문서를 추가할 수 있습니다.');
    addFiles(await converter.resolveDroppedFiles(files));
  },
  onDragState: dragging => {
    byId('drop-overlay').hidden = !dragging;
    byId('dropzone').classList.toggle('is-dragging', dragging);
  },
  onError: error => log(errorMessage(error), 'error', true),
});

renderDocuments(); renderSummary(); renderOutputDirectory();
if (converter) checkEngine();
else {
  log('화면 미리보기입니다. 실제 변환은 데스크톱 앱에서 실행하세요.', 'warning', true);
  for (const id of ['select-files', 'select-folder', 'select-output', 'check-engine']) byId(id).disabled = true;
}
