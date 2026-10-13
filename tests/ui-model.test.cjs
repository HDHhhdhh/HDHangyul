'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const model = import(pathToFileURL(path.join(__dirname, '../dist/ui-model.js')).href);

function source(path, id = 'file-1') {
  return { id, name: path.split('\\').at(-1), path, format: 'hwp', targets: ['hwpx', 'pdf'], status: 'running', progress: 4, results: [] };
}

test('queue deduplicates case and separator variants within and between drops', async () => {
  const { addDocuments } = await model;
  let id = 0;
  const result = addDocuments([source('C:\\first\\One.hwp')], [
    { path: 'c:/FIRST/one.HWP' }, { path: 'D:\\other\\two.hwpx' },
    { path: 'd:\\OTHER\\TWO.HWPX' }, { path: 'D:\\other\\image.png' }, { name: 'fake.hwp' },
  ], () => `new-${++id}`);
  assert.equal(result.addedCount, 1);
  assert.equal(result.duplicateCount, 2);
  assert.equal(result.unsupportedCount, 2);
  assert.equal(result.documents[1].path, 'D:\\other\\two.hwpx');
  assert.deepEqual(result.documents[1].targets, ['pdf']);
});

test('one successful output never marks a multi-target document complete', async () => {
  const { applyDocumentEvent } = await model;
  const file = applyDocumentEvent(source('C:\\one.hwp'), { type: 'output', taskId: 'file-1', target: 'hwpx', status: 'success', outputPath: 'C:\\one.hwpx' });
  assert.equal(file.status, 'running');
  assert.ok(file.progress < 100);
  const failed = applyDocumentEvent(file, { type: 'failed', taskId: 'file-1', error: 'PDF_FAILED', message: 'PDF 실패' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.results.find(item => item.target === 'hwpx').status, 'success');
  assert.equal(failed.results.find(item => item.target === 'pdf').status, 'failed');
});

test('final file success requires all targets and reflects retained-original warning', async () => {
  const { applyDocumentEvent } = await model;
  const file = source('C:\\one.hwp');
  const incomplete = applyDocumentEvent(file, { type: 'file-complete', taskId: file.id, ok: true, outputs: [{ kind: 'pdf', path: 'C:\\one.pdf' }] });
  assert.equal(incomplete.status, 'failed');
  const complete = applyDocumentEvent(file, {
    type: 'file-complete', taskId: file.id, ok: true,
    outputs: [{ kind: 'pdf', path: 'C:\\one.pdf' }, { kind: 'hwpx', path: 'C:\\one.hwpx' }],
    originalDeleted: false, deletionWarning: '원본이 변경됨',
  });
  assert.equal(complete.status, 'success');
  assert.match(complete.message, /원본 보관/);
  assert.equal(complete.originalDeleted, false);
});

test('missing terminal events fail, cancellation only affects active batch', async () => {
  const { finishUnresolved } = await model;
  const files = [source('C:\\one.hwp', 'active'), { ...source('D:\\two.hwp', 'next'), status: 'ready' }];
  const failed = finishUnresolved(files, new Set(['active']));
  assert.equal(failed[0].status, 'failed');
  assert.equal(failed[1].status, 'ready');
  const cancelled = finishUnresolved(files, new Set(['active']), { cancelled: true });
  assert.equal(cancelled[0].status, 'cancelled');
  assert.deepEqual(cancelled[0].results.map(item => item.status), ['cancelled', 'cancelled']);
});

test('capture handles drops over sidebar, buttons, list and log exactly once', async () => {
  const { installFileDropHandlers } = await model;
  const listeners = new Map();
  const surface = {
    addEventListener(name, handler, capture) { assert.equal(capture, true); listeners.set(name, handler); },
    removeEventListener(name, handler, capture) { assert.equal(capture, true); assert.equal(listeners.get(name), handler); listeners.delete(name); },
  };
  const drops = [];
  const states = [];
  const remove = installFileDropHandlers(surface, {
    onFiles: files => drops.push(files), onDragState: value => states.push(value), onError: error => { throw error; },
  });
  for (const target of ['sidebar', 'button', 'document-list', 'log']) {
    let prevented = 0;
    let stopped = 0;
    const event = { target, dataTransfer: { types: ['Files'], files: [{ name: `${target}.hwp` }] }, preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
    listeners.get('dragenter')(event);
    listeners.get('dragover')(event);
    listeners.get('drop')(event);
    assert.equal(prevented, 3);
    assert.equal(stopped, 1);
  }
  assert.equal(drops.length, 4);
  assert.equal(states.at(-1), false);
  remove();
  assert.equal(listeners.size, 0);
});

test('the primary run action is placed directly beside the top title', () => {
  const html = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
  const titleGroup = html.match(/<div class="topbar-primary">([\s\S]*?)<\/div>\s*<div class="topbar-actions">/);
  assert.ok(titleGroup, 'top title group was not found');
  assert.match(titleGroup[1], /<h1>한귤변환기<\/h1>[\s\S]*?<button id="run"/);
  assert.equal((html.match(/id="run"/g) || []).length, 1);
});

test('delete original is selected by default', () => {
  const html = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
  assert.match(html, /<input id="delete-original" type="checkbox" checked>/);
});
