'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function setup(invoke) {
  let api;
  let resolveCount = 0;
  const emitter = new EventEmitter();
  emitter.invoke = invoke;
  const context = {
    require(name) {
      if (name === 'node:path') return path;
      if (name === 'electron') return {
        contextBridge: { exposeInMainWorld(_name, value) { api = value; } }, ipcRenderer: emitter,
        webUtils: { getPathForFile(file) { resolveCount++; return file.absolutePath; } },
      };
      throw new Error(`Unexpected module ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), context);
  return { api, emit: event => emitter.emit('conversion:event', {}, event), emitter, resolveCount: () => resolveCount };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('drop paths resolve exactly once and normalize through Windows path rules', async () => {
  const bridge = setup(async () => ({}));
  const files = await bridge.api.resolveDroppedFiles([{ absolutePath: 'C:/docs/../a/one.HWP', size: 55 }]);
  assert.equal(bridge.resolveCount(), 1);
  assert.equal(files[0].path, 'C:\\a\\one.HWP');
  assert.equal(files[0].name, 'one.HWP');
});

test('payload defaults to per-source output and hidden workers; no overwrite options', async () => {
  let payload;
  const bridge = setup(async (_channel, request) => { payload = request; return { ok: true, runId: 'run' }; });
  const running = bridge.api.startConversion({ tasks: [{ id: '1', inputPath: 'C:\\one.hwp', targets: ['pdf'] }], options: { deleteOriginal: true } }, () => {});
  await flush();
  assert.equal(payload.options.outputDir, null);
  assert.equal(payload.options.deleteOriginal, true);
  assert.equal(payload.options.visible, false);
  assert.equal(payload.options.parallelism, 2);
  assert.equal('overwrite' in payload.options, false);
  assert.equal('keepIntermediate' in payload.options, false);
  bridge.emit({ type: 'exit', runId: 'run', ok: true });
  await running;
  assert.equal(bridge.emitter.listenerCount('conversion:event'), 0);
});

test('terminal file details and cancellation are not collapsed into output success', async () => {
  const bridge = setup(async () => ({ ok: true, runId: 'run' }));
  const events = [];
  const running = bridge.api.startConversion({ tasks: [] }, event => events.push(event));
  await flush();
  bridge.emit({ type: 'output-complete', taskId: '1', outputKind: 'pdf', outputPath: 'C:\\one.pdf', runId: 'other' });
  assert.equal(events.length, 0);
  bridge.emit({ type: 'file-complete', taskId: '1', ok: true, outputs: [{ kind: 'pdf', path: 'C:\\one.pdf' }], originalDeleted: true, runId: 'run' });
  assert.equal(events[0].type, 'file-complete');
  assert.equal(events[0].originalDeleted, true);
  bridge.emit({ type: 'cancelled', summary: { succeeded: 1, failed: 0, cancelled: 1 }, runId: 'run' });
  bridge.emit({ type: 'exit', ok: false, runId: 'run' });
  const summary = await running;
  assert.equal(summary.completed, 1);
  assert.equal(summary.cancelled, true);
});

test('cancel immediately after start waits for run id and sends one cancellation', async () => {
  let finishStart;
  const cancels = [];
  const bridge = setup((channel, payload) => {
    if (channel === 'conversion:start') return new Promise(resolve => { finishStart = resolve; });
    cancels.push(payload);
    return Promise.resolve({ ok: true });
  });
  const running = bridge.api.startConversion({ tasks: [] }, () => {});
  const result = await bridge.api.cancelConversion();
  assert.equal(result.pending, true);
  finishStart({ ok: true, runId: 'run' });
  await flush();
  await bridge.api.cancelConversion();
  assert.deepEqual(cancels, ['run']);
  bridge.emit({ type: 'exit', runId: 'run', cancelled: true });
  assert.equal((await running).cancelled, true);
});

test('one worker fatal is logged and does not synthesize a failure for other tasks', async () => {
  const bridge = setup(async () => ({ ok: true, runId: 'run' }));
  const events = [];
  const running = bridge.api.startConversion({ tasks: [] }, event => events.push(event));
  await flush();
  bridge.emit({ type: 'fatal', runId: 'run', workerId: 1, message: 'worker failed' });
  assert.equal(events[0].type, 'log');
  assert.equal(events[0].level, 'error');
  bridge.emit({ type: 'exit', runId: 'run', ok: false });
  await running;
});
