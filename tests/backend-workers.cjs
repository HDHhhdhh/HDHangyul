'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PDFDocument } = require('../vendor/pdf-lib.cjs');

const mainPath = path.join(__dirname, '..', 'electron', 'main.cjs');
const source = fs.readFileSync(mainPath, 'utf8');
const validPdf = PDFDocument.create().then(async (document) => {
  document.addPage([595, 842]);
  return document.save();
});

async function harness(t, { trashError, diagnostics = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hangul-backend-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('hangul-backend-test-'));
    await fsp.rm(resolved, { recursive: true, force: true });
  });
  const workers = [];
  let activeWorkerCount = 0;
  let peakWorkerCount = 0;
  const events = [];
  const trashed = [];
  const handlers = new Map();
  const appHandlers = new Map();
  const warnings = [];
  let quitCount = 0;
  const userData = path.join(root, 'user-data');
  const diagnosticPath = path.join(userData, 'logs', 'latest-run.json');
  if (diagnostics === 'blocked') await fsp.writeFile(userData, 'not a directory');
  const sender = new EventEmitter();
  sender.isDestroyed = () => false;
  sender.send = (_channel, event) => {
    events.push(JSON.parse(JSON.stringify(event)));
    if (event.type === 'exit') sender.emit('run-exit', event);
  };
  const spawn = (executable, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.notEqual(executable, 'taskkill.exe');
    const payloadFile = args[args.indexOf('-InputJsonPath') + 1];
    const payload = JSON.parse(fs.readFileSync(payloadFile, 'utf8'));
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 8000 + workers.length;
    activeWorkerCount += 1;
    peakWorkerCount = Math.max(peakWorkerCount, activeWorkerCount);
    child.once('close', () => { activeWorkerCount -= 1; });
    workers.push({ child, payload, payloadFile });
    return child;
  };
  const module = { exports: {} };
  const electron = {
    app: diagnostics ? {
      whenReady: () => new Promise(() => {}),
      on: (name, handler) => appHandlers.set(name, handler),
      getPath: (name) => { assert.equal(name, 'userData'); return userData; },
      getVersion: () => '0.2.1-test',
      quit: () => { quitCount += 1; },
    } : null,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    shell: { trashItem: async (filePath) => {
      if (trashError) throw new Error(trashError);
      trashed.push(filePath);
      await fsp.unlink(filePath);
    } },
  };
  vm.runInNewContext(source, {
    module, exports: module.exports, __dirname: path.dirname(mainPath), process, Buffer,
    console: { ...console, warn: (...args) => warnings.push(args.join(' ')) },
    require: (name) => name === 'electron' ? electron : name === 'node:child_process' ? { spawn } : require(name),
  }, { filename: mainPath });
  const backend = module.exports;
  backend.registerIpcHandlers();
  const done = () => {
    if (events.some((event) => event.type === 'exit')) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Run did not finish')), 3000);
      sender.once('run-exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  const input = async (relativePath, content = 'fake HWP input') => {
    const filePath = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
    return filePath;
  };
  const emit = (worker, event) => worker.child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'));
  const output = async (task, target) => {
    const outputPath = task.plannedOutputPaths[target];
    await fsp.writeFile(outputPath, target === 'pdf' ? await validPdf : Buffer.from([80, 75, 3, 4, 20, 0, 0, 0]));
    return outputPath;
  };
  const success = async (worker, task, duplicates = false) => {
    for (const target of task.targets) {
      const outputPath = await output(task, target);
      const event = { type: 'output-complete', taskId: task.id, outputKind: target, outputPath };
      emit(worker, event);
      if (duplicates) emit(worker, event);
    }
    emit(worker, { type: 'file-complete', taskId: task.id, ok: true });
    if (duplicates) emit(worker, { type: 'file-complete', taskId: task.id, ok: true });
  };
  const complete = () => events.find((event) => ['complete', 'cancelled'].includes(event.type));
  const until = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Expected asynchronous result did not arrive');
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { root, backend, workers, sender, events, trashed, handlers, done, input, emit, output, success, complete,
    warnings, appHandlers, diagnosticPath, until, quitCount: () => quitCount, peakWorkerCount: () => peakWorkerCount };
}

test('N files use at most P persistent workers, preserve each source directory, suppress duplicate outcomes', async (t) => {
  const h = await harness(t);
  const files = await Promise.all(Array.from({ length: 9 }, (_, index) => h.input(`folder-${index}/문서-${index}.hwp`, 'x'.repeat(20 + index))));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 3 } });
  assert.equal(h.workers.length, 3);
  assert.equal(h.workers.reduce((count, worker) => count + worker.payload.tasks.length, 0), 9);
  for (const worker of h.workers) {
    assert.ok(worker.payload.tasks.length > 1);
    assert.equal(worker.payload.options.outputDir, null);
    assert.equal(worker.payload.options.deleteOriginal, false);
    assert.equal(worker.payload.options.visible, false);
    for (const task of worker.payload.tasks) {
      assert.equal(path.dirname(task.plannedOutputPaths.pdf), path.dirname(task.inputPath));
      await h.success(worker, task, true);
    }
    worker.child.emit('close', 0, null);
  }
  await h.done();
  assert.deepEqual(h.complete().summary, { total: 9, succeeded: 9, failed: 0, cancelled: 0, pdf: 9, hwpx: 9 });
  assert.equal(h.events.filter((event) => event.type === 'file-complete').length, 9);
  assert.equal(h.trashed.length, 0);
});

test('four workers start before any completion and process twelve interleaved documents once', async (t) => {
  const h = await harness(t);
  const files = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    h.input(`four-${index}/document.hwp`, 'x'.repeat(50 + index))));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 4 } });
  assert.equal(h.workers.length, 4);
  assert.equal(h.events.filter(event => event.type === 'file-complete').length, 0);
  const assigned = h.workers.flatMap(worker => worker.payload.tasks);
  assert.equal(assigned.length, 12);
  assert.equal(new Set(assigned.map(task => task.id)).size, 12);
  assert.equal(new Set(h.workers.map(worker => worker.payloadFile)).size, 4);
  assert.ok(h.workers.every(worker => worker.payload.tasks.length > 0));
  // Interleave reports from four independently active fake worker processes.
  const rounds = Math.max(...h.workers.map(worker => worker.payload.tasks.length));
  for (let round = 0; round < rounds; round++) {
    await Promise.all(h.workers.map(async worker => {
      const task = worker.payload.tasks[round];
      if (task) await h.success(worker, task);
    }));
  }
  for (const worker of [...h.workers].reverse()) worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.workers.length, 4);
  assert.deepEqual(h.complete().summary, { total: 12, succeeded: 12, failed: 0, cancelled: 0, pdf: 12, hwpx: 12 });
  assert.equal(h.events.filter(event => event.type === 'file-complete').length, 12);
});

test('one of four workers failing leaves the other three results successful', async (t) => {
  const h = await harness(t);
  const files = await Promise.all(Array.from({ length: 4 }, (_, index) => h.input(`four-fail/${index}.hwp`)));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 4 } });
  assert.equal(h.workers.length, 4);
  const failedWorker = h.workers[1];
  failedWorker.child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'fatal', ok: false, code: 'MOCK_COM_FAILED', message: 'Simulated worker failure' }) + '\n'));
  failedWorker.child.emit('close', 1, null);
  for (const worker of h.workers.filter(worker => worker !== failedWorker)) {
    await h.success(worker, worker.payload.tasks[0]);
    worker.child.emit('close', 0, null);
  }
  await h.done();
  assert.deepEqual(h.complete().summary, { total: 4, succeeded: 3, failed: 1, cancelled: 0, pdf: 3, hwpx: 3 });
  assert.equal(h.events.filter(event => event.type === 'file-complete').length, 3);
  assert.equal(h.events.filter(event => event.type === 'file-error').length, 1);
  assert.equal(h.trashed.length, 0);
});

test('output planning protects existing outputs and every input with same basenames', async (t) => {
  const h = await harness(t);
  const first = await h.input('a/report.hwp');
  const existingHwpx = await h.input('a/report.hwpx', 'original HWPX contents');
  const second = await h.input('b/report.hwp');
  const existingPdf = await h.input('a/report.pdf', 'existing PDF contents');
  await h.backend.startConversionJob(h.sender, { files: [first, existingHwpx, second], options: { outputDir: path.dirname(first), parallelism: 3 } });
  const tasks = h.workers.flatMap((worker) => worker.payload.tasks);
  const outputs = tasks.flatMap((task) => Object.values(task.plannedOutputPaths));
  assert.equal(new Set(outputs.map((value) => value.toLowerCase())).size, outputs.length);
  assert.ok(outputs.every((value) => ![first, existingHwpx, second, existingPdf].includes(value)));
  assert.ok(outputs.every((value) => /report \(\d+\)\.(pdf|hwpx)$/.test(value)));
  for (const worker of h.workers) {
    for (const task of worker.payload.tasks) await h.success(worker, task);
    worker.child.emit('close', 0, null);
  }
  await h.done();
  assert.equal(await fsp.readFile(existingHwpx, 'utf8'), 'original HWPX contents');
  assert.equal(await fsp.readFile(existingPdf, 'utf8'), 'existing PDF contents');
});

test('preflight removes case-insensitive duplicate files and rejects duplicate IDs', async (t) => {
  const h = await harness(t);
  const file = await h.input('duplicate.hwp');
  const tasks = h.backend.validateStartPayload({ files: [file, file.toUpperCase()], options: { overwrite: true } });
  assert.equal(tasks.tasks.length, 1);
  assert.equal(tasks.options.deleteOriginal, false);
  assert.equal(Object.hasOwn(tasks.options, 'overwrite'), false);
  assert.throws(() => h.backend.validateStartPayload({ tasks: [
    { id: 'same', inputPath: file }, { id: 'same', inputPath: path.join(h.root, 'other.hwp') },
  ] }), /Duplicate task ID/);
});

test('all tasks without terminal outcomes fail when a batch worker exits, including spawn errors', async (t) => {
  const h = await harness(t);
  const files = await Promise.all([0, 1, 2, 3].map((index) => h.input(`${index}.hwp`)));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 2 } });
  const [first, second] = h.workers;
  await h.success(first, first.payload.tasks[0]);
  first.child.emit('close', 0, null);
  second.child.emit('error', new Error('Spawn blocked'));
  second.child.emit('close', -1, null);
  await h.done();
  assert.equal(h.complete().summary.succeeded, 1);
  assert.equal(h.complete().summary.failed, 3);
  assert.equal(h.events.filter((event) => event.type === 'file-error').length, 3);
  assert.equal(h.complete().ok, false);
});

test('partial outputs remain failed and can never delete an original', async (t) => {
  const h = await harness(t);
  const file = await h.input('partial.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { deleteOriginal: true } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  await h.output(task, 'pdf');
  h.emit(worker, { type: 'output-complete', taskId: task.id, outputKind: 'pdf', outputPath: task.plannedOutputPaths.pdf });
  h.emit(worker, { type: 'file-complete', taskId: task.id }); // A faulty worker must not be trusted.
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.complete().summary.succeeded, 0);
  assert.equal(h.trashed.length, 0);
  assert.equal(fs.existsSync(file), true);
});

test('original deletion follows complete verified outputs only', async (t) => {
  const h = await harness(t);
  const file = await h.input('delete.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { deleteOriginal: true } });
  const worker = h.workers[0];
  await h.success(worker, worker.payload.tasks[0]);
  worker.child.emit('close', 0, null);
  await h.done();
  assert.deepEqual(h.trashed, [file]);
  assert.equal(h.events.find((event) => event.type === 'file-complete').originalDeleted, true);
});

test('source modified during conversion is retained and reported despite valid outputs', async (t) => {
  const h = await harness(t);
  const file = await h.input('changed.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { deleteOriginal: true } });
  await fsp.appendFile(file, ' user changes');
  const worker = h.workers[0];
  await h.success(worker, worker.payload.tasks[0]);
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.trashed.length, 0);
  assert.equal(h.events.find((event) => event.type === 'file-complete').originalDeleted, false);
  assert.match(h.events.find((event) => event.type === 'source-delete-skipped').message, /source changed/);
});

test('Recycle Bin failure retains source and gives an explicit warning', async (t) => {
  const h = await harness(t, { trashError: 'Source locked by another application' });
  const file = await h.input('locked.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { deleteOriginal: true } });
  const worker = h.workers[0];
  await h.success(worker, worker.payload.tasks[0]);
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(fs.existsSync(file), true);
  assert.match(h.events.find((event) => event.type === 'file-complete').deletionWarning, /locked/);
  assert.equal(h.complete().summary.succeeded, 1);
});

test('cancel is sender-owned, writes one marker, retains originals, and accounts for unstarted tasks', async (t) => {
  const h = await harness(t);
  const files = await Promise.all([0, 1, 2].map((index) => h.input(`cancel-${index}.hwp`)));
  const result = await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 1, deleteOriginal: true } });
  const cancel = h.handlers.get(h.backend.CHANNELS.cancel);
  assert.equal((await cancel({ sender: {} }, result.runId)).ok, false);
  assert.equal((await cancel({ sender: h.sender }, result.runId)).ok, true);
  assert.equal((await cancel({ sender: h.sender }, result.runId)).ok, true);
  const worker = h.workers[0];
  assert.equal(fs.existsSync(worker.payload.options.cancelPath), true);
  await h.success(worker, worker.payload.tasks[0]);
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.complete().type, 'cancelled');
  assert.equal(h.complete().summary.succeeded, 1);
  assert.equal(h.complete().summary.cancelled, 2);
  assert.equal(h.trashed.length, 0);
  assert.equal(h.events.filter((event) => event.type === 'cancel-requested').length, 1);
  assert.equal(h.workers.length, 1);
});

test('a sender cannot launch overlapping jobs even while preflight is pending', async (t) => {
  const h = await harness(t);
  const file = await h.input('single.hwp');
  const first = h.backend.startConversionJob(h.sender, { files: [file] });
  await assert.rejects(() => h.backend.startConversionJob(h.sender, { files: [file] }), /already running/);
  await first;
  const worker = h.workers[0];
  await h.success(worker, worker.payload.tasks[0]);
  worker.child.emit('close', 0, null);
  await h.done();
});

test('UTF-8 split chunks keep Korean output paths intact', async (t) => {
  const h = await harness(t);
  const file = await h.input('한글문서.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  const outputPath = await h.output(task, 'pdf');
  const line = Buffer.from(`${JSON.stringify({ type: 'output-complete', taskId: task.id, outputKind: 'pdf', outputPath })}\n`);
  const boundary = line.indexOf(Buffer.from('한')) + 1;
  worker.child.stdout.emit('data', line.subarray(0, boundary));
  worker.child.stdout.emit('data', line.subarray(boundary));
  h.emit(worker, { type: 'file-complete', taskId: task.id });
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.complete().summary.succeeded, 1);
  assert.equal(h.events.find((event) => event.type === 'output-complete').outputPath, outputPath);
});

test('an unreserved output path fails exactly once and prevents original deletion', async (t) => {
  const h = await harness(t);
  const file = await h.input('unexpected-path.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false, deleteOriginal: true } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  await h.output(task, 'pdf');
  const event = { type: 'output-complete', taskId: task.id, outputKind: 'pdf', outputPath: path.join(h.root, 'other.pdf') };
  h.emit(worker, event);
  h.emit(worker, event);
  h.emit(worker, { type: 'file-complete', taskId: task.id });
  h.emit(worker, { type: 'file-error', taskId: task.id, message: 'Duplicate error' });
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.complete().summary.succeeded, 0);
  assert.equal(h.events.filter((item) => item.type === 'file-error').length, 1);
  assert.equal(h.trashed.length, 0);
});

test('invalid output bytes are rejected even when the worker reports successful conversion', async (t) => {
  const h = await harness(t);
  const file = await h.input('corrupt.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false, deleteOriginal: true } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  await fsp.writeFile(task.plannedOutputPaths.pdf, 'not a PDF document');
  h.emit(worker, { type: 'file-complete', taskId: task.id });
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.trashed.length, 0);
  assert.equal(fs.existsSync(file), true);
});

test('a forged PDF header, startxref and EOF cannot authorize source deletion', async (t) => {
  const h = await harness(t);
  const file = await h.input('malformed-pdf.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false, deleteOriginal: true } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  await fsp.writeFile(task.plannedOutputPaths.pdf, '%PDF-1.7\nstartxref\n0\n%%EOF\n');
  h.emit(worker, { type: 'file-complete', taskId: task.id });
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.complete().summary.succeeded, 0);
  assert.equal(h.trashed.length, 0);
  assert.equal(fs.existsSync(file), true);
});

test('a parsed PDF with no pages cannot authorize source deletion', async (t) => {
  const h = await harness(t);
  const file = await h.input('empty-pages.hwp');
  const document = await PDFDocument.create();
  const emptyPdf = await document.save({ addDefaultPage: false });
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false, deleteOriginal: true } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  await fsp.writeFile(task.plannedOutputPaths.pdf, emptyPdf);
  h.emit(worker, { type: 'file-complete', taskId: task.id });
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.trashed.length, 0);
  assert.match(h.events.find((event) => event.type === 'file-error').message, /no pages/);
});

test('output changed after validation invalidates its cache and prevents source deletion', async (t) => {
  const h = await harness(t);
  const file = await h.input('changed-output.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false, deleteOriginal: true } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  const outputPath = await h.output(task, 'pdf');
  h.emit(worker, { type: 'output-complete', taskId: task.id, outputKind: 'pdf', outputPath });
  const deadline = Date.now() + 2000;
  while (!h.events.some((event) => event.type === 'output-complete')) {
    if (Date.now() >= deadline) throw new Error('Output validation did not finish');
    await new Promise((resolve) => setImmediate(resolve));
  }
  await fsp.writeFile(outputPath, '%PDF-1.7\nstartxref\n0\n%%EOF\n');
  h.emit(worker, { type: 'file-complete', taskId: task.id });
  worker.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.trashed.length, 0);
  assert.equal(fs.existsSync(file), true);
});

test('worker fatal code and original error reach every unfinished file outcome', async (t) => {
  const h = await harness(t);
  const files = await Promise.all([0, 1].map((index) => h.input(`fatal-${index}.hwp`)));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 1 } });
  const worker = h.workers[0];
  h.emit(worker, { type: 'fatal', code: 'ISOLATED_CONVERSION_FAILED', stage: 'launch',
    message: 'Exception setting OutputEncoding: The handle is invalid.', details: 'Original exception stack' });
  worker.child.emit('close', 1, null);
  await h.done();
  const failures = h.events.filter((event) => event.type === 'file-error');
  assert.equal(failures.length, 2);
  for (const failure of failures) {
    assert.equal(failure.code, 'ISOLATED_CONVERSION_FAILED');
    assert.match(failure.message, /^변환 작업 오류:.*OutputEncoding.*handle is invalid/);
    assert.equal(failure.stage, 'launch');
    assert.equal(failure.details, 'Original exception stack');
  }
});

test('early stderr failures survive close with a bounded actionable error tail', async (t) => {
  const h = await harness(t);
  const file = await h.input('early-stderr.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { parallelism: 1 } });
  const worker = h.workers[0];
  worker.child.stderr.emit('data', Buffer.from(`${'old noise '.repeat(2000)}\n`));
  worker.child.stderr.emit('data', Buffer.from('실제 오류: Console.OutputEncoding : The handle is invalid.'));
  worker.child.emit('close', 1, null);
  await h.done();
  const failure = h.events.find((event) => event.type === 'file-error');
  assert.equal(failure.code, 'WORKER_STDERR_FAILURE');
  assert.match(failure.message, /실제 오류: Console.OutputEncoding : The handle is invalid/);
  assert.ok(failure.stderrTail.length <= 8192);
  assert.ok(failure.message.length <= 8192 + 12);
});

test('latest-run diagnostics preserve failure paths and versions with at most 500 events', async (t) => {
  const h = await harness(t, { diagnostics: true });
  const file = await h.input('diagnostic.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { parallelism: 1 } });
  const worker = h.workers[0];
  for (let index = 0; index < 600; index += 1) h.emit(worker, { type: 'log', message: `Progress ${index}` });
  h.emit(worker, { type: 'fatal', code: 'REAL_STARTUP_ERROR', message: 'Actual startup exception' });
  worker.child.emit('close', 1, null);
  await h.done();
  await h.until(() => fs.existsSync(h.diagnosticPath));
  const report = JSON.parse(await fsp.readFile(h.diagnosticPath, 'utf8'));
  assert.equal(report.events.length, 500);
  assert.equal(report.events.at(-1).type, 'exit');
  assert.equal(report.versions.app, '0.2.1-test');
  assert.equal(report.versions.node, process.versions.node);
  assert.equal(report.failures[0].inputPath, file);
  assert.equal(report.failures[0].code, 'REAL_STARTUP_ERROR');
  assert.match(report.failures[0].message, /Actual startup exception/);
  assert.equal(report.summary.failed, 1);
});

test('diagnostic write errors do not crash the batch or delay graceful application exit', async (t) => {
  const h = await harness(t, { diagnostics: 'blocked' });
  const file = await h.input('logging-unavailable.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { parallelism: 1 } });
  let prevented = false;
  h.appHandlers.get('before-quit')({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  const worker = h.workers[0];
  worker.child.emit('close', 0, null);
  await h.done();
  await h.until(() => h.warnings.some((warning) => warning.includes('Could not save')) && h.quitCount() > 0);
  assert.equal(h.complete().type, 'cancelled');
  assert.equal(h.events.filter((event) => event.type === 'exit').length, 1);
});

test('failed diagnostic persistence cannot turn a successful conversion into a failure', async (t) => {
  const h = await harness(t, { diagnostics: 'blocked' });
  const file = await h.input('success-without-log.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false } });
  const worker = h.workers[0];
  await h.success(worker, worker.payload.tasks[0]);
  worker.child.emit('close', 0, null);
  await h.done();
  await h.until(() => h.warnings.some((warning) => warning.includes('Could not save')));
  assert.equal(h.complete().ok, true);
  assert.equal(h.complete().summary.succeeded, 1);
  assert.equal(h.complete().summary.failed, 0);
});

test('latest-run diagnostics retain measured stage duration and structured metrics', async (t) => {
  const h = await harness(t, { diagnostics: true });
  const file = await h.input('timed-stage.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  const metrics = { openMs: 230, saveMs: 129500, validationMs: 71, pageCount: 129, target: 'pdf' };
  h.emit(worker, { type: 'stage-timing', taskId: task.id, stage: 'save-pdf', durationMs: 129801, metrics });
  await h.success(worker, task);
  worker.child.emit('close', 0, null);
  await h.done();
  await h.until(() => fs.existsSync(h.diagnosticPath));
  const report = JSON.parse(await fsp.readFile(h.diagnosticPath, 'utf8'));
  const measured = report.events.find((event) => event.type === 'stage-timing');
  assert.equal(measured.stage, 'save-pdf');
  assert.equal(measured.durationMs, 129801);
  assert.deepEqual(measured.metrics, metrics);
  assert.equal(report.summary.succeeded, 1);
});

function requestRecycle(h, worker, task) {
  h.emit(worker, { type: 'file-start', taskId: task.id });
  h.emit(worker, { type: 'worker-recycle', taskId: task.id, code: 'PDF_OUTPUT_MISSING', message: 'SaveAs returned true but PDF was missing.' });
  worker.child.emit('close', 75, null);
}

test('fresh worker retries the missing PDF once without rerunning completed files or changing destinations', async (t) => {
  const h = await harness(t);
  const files = await Promise.all([0, 1, 2].map((index) => h.input(`recover-${index}.hwp`)));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 1, hwpx: false } });
  const first = h.workers[0];
  const [completed, missing, later] = first.payload.tasks;
  await h.success(first, completed);
  h.emit(first, { type: 'file-start', taskId: missing.id });
  h.emit(first, { type: 'worker-recycle', taskId: missing.id, code: 'PDF_OUTPUT_MISSING' });
  await h.until(() => h.events.some((event) => event.type === 'worker-recycle'));
  assert.equal(h.workers.length, 1); // The old process must close before a replacement starts.
  first.child.emit('close', 75, null);
  await h.until(() => h.workers.length === 2);
  const replacement = h.workers[1];
  assert.deepEqual(replacement.payload.tasks.map((task) => task.id), [missing.id, later.id]);
  assert.deepEqual(replacement.payload.tasks[0].plannedOutputPaths, missing.plannedOutputPaths);
  assert.equal(h.events.some((event) => event.type === 'exit'), false);
  for (const task of replacement.payload.tasks) await h.success(replacement, task);
  replacement.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.workers.length, 2);
  assert.equal(h.complete().ok, true);
  assert.equal(h.complete().summary.succeeded, 3);
  assert.equal(h.events.filter((event) => event.type === 'file-complete' && event.taskId === completed.id).length, 1);
});

test('a repeated missing PDF fails after one retry while later documents get a fresh worker', async (t) => {
  const h = await harness(t);
  const files = await Promise.all([0, 1].map((index) => h.input(`bounded-${index}.hwp`)));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 1, hwpx: false, deleteOriginal: true } });
  requestRecycle(h, h.workers[0], h.workers[0].payload.tasks[0]);
  await h.until(() => h.workers.length === 2);
  const second = h.workers[1];
  const failedTask = second.payload.tasks[0];
  requestRecycle(h, second, failedTask);
  await h.until(() => h.workers.length === 3);
  const third = h.workers[2];
  assert.equal(third.payload.tasks.length, 1);
  assert.notEqual(third.payload.tasks[0].id, failedTask.id);
  await h.success(third, third.payload.tasks[0]);
  third.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.workers.length, 3);
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.complete().summary.succeeded, 1);
  assert.equal(h.events.filter((event) => event.type === 'file-error' && event.taskId === failedTask.id).length, 1);
  assert.equal(h.events.find((event) => event.type === 'file-error').code, 'PDF_OUTPUT_MISSING_AFTER_RETRY');
  assert.equal(fs.existsSync(failedTask.inputPath), true);
});

test('cancellation after recycle request prevents replacement spawning', async (t) => {
  const h = await harness(t);
  const files = await Promise.all([0, 1].map((index) => h.input(`cancel-recycle-${index}.hwp`)));
  const run = await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 1 } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  h.emit(worker, { type: 'file-start', taskId: task.id });
  h.emit(worker, { type: 'worker-recycle', taskId: task.id, code: 'PDF_OUTPUT_MISSING' });
  await h.handlers.get(h.backend.CHANNELS.cancel)({ sender: h.sender }, run.runId);
  worker.child.emit('close', 75, null);
  await h.done();
  assert.equal(h.workers.length, 1);
  assert.equal(h.complete().type, 'cancelled');
  assert.equal(h.complete().summary.cancelled, 2);
});

test('forged foreign-task recycle request cannot restart or fail the other worker task', async (t) => {
  const h = await harness(t);
  const files = await Promise.all([0, 1].map((index) => h.input(`foreign-recycle-${index}.hwp`)));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 2, hwpx: false } });
  const [first, second] = h.workers;
  h.emit(first, { type: 'file-start', taskId: first.payload.tasks[0].id });
  h.emit(first, { type: 'worker-recycle', taskId: second.payload.tasks[0].id, code: 'PDF_OUTPUT_MISSING' });
  first.child.emit('close', 75, null);
  await h.success(second, second.payload.tasks[0]);
  second.child.emit('close', 0, null);
  await h.done();
  assert.equal(h.workers.length, 2);
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.complete().summary.succeeded, 1);
  assert.equal(h.events.find((event) => event.type === 'file-error').taskId, first.payload.tasks[0].id);
});

test('recycle is refused when any output has already been reported', async (t) => {
  const h = await harness(t);
  const file = await h.input('partial-recycle.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { deleteOriginal: true } });
  const worker = h.workers[0];
  const task = worker.payload.tasks[0];
  const outputPath = await h.output(task, 'hwpx');
  h.emit(worker, { type: 'file-start', taskId: task.id });
  h.emit(worker, { type: 'output-complete', taskId: task.id, outputKind: 'hwpx', outputPath });
  h.emit(worker, { type: 'worker-recycle', taskId: task.id, code: 'PDF_OUTPUT_MISSING' });
  worker.child.emit('close', 75, null);
  await h.done();
  assert.equal(h.workers.length, 1);
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.events.find((event) => event.type === 'file-error').code, 'INVALID_WORKER_RECYCLE_REQUEST');
  assert.equal(h.trashed.length, 0);
});

test('source edits before recycling prevent retry and preserve the original', async (t) => {
  const h = await harness(t);
  const file = await h.input('changed-recycle.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false, deleteOriginal: true } });
  const worker = h.workers[0];
  await fsp.appendFile(file, ' user edits');
  requestRecycle(h, worker, worker.payload.tasks[0]);
  await h.done();
  assert.equal(h.workers.length, 1);
  assert.equal(h.events.find((event) => event.type === 'file-error').code, 'RECOVERY_SOURCE_CHANGED');
  assert.equal(h.trashed.length, 0);
  assert.equal(fs.existsSync(file), true);
});

test('exit 75 without a validated recycle event is an ordinary failure', async (t) => {
  const h = await harness(t);
  const file = await h.input('unexpected-exit-75.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file] });
  h.workers[0].child.emit('close', 75, null);
  await h.done();
  assert.equal(h.workers.length, 1);
  assert.equal(h.complete().summary.failed, 1);
  assert.equal(h.complete().ok, false);
});

test('simultaneous recycling preserves the configured live-worker limit and final accounting', async (t) => {
  const h = await harness(t);
  const files = await Promise.all([0, 1, 2, 3].map((index) => h.input(`parallel-recovery-${index}.hwp`)));
  await h.backend.startConversionJob(h.sender, { files, options: { parallelism: 2, hwpx: false } });
  const initialWorkers = [...h.workers];
  for (const worker of initialWorkers) requestRecycle(h, worker, worker.payload.tasks[0]);
  await h.until(() => h.workers.length === 4);
  assert.equal(h.events.some((event) => event.type === 'exit'), false);
  for (const worker of h.workers.slice(2)) {
    for (const task of worker.payload.tasks) await h.success(worker, task);
    worker.child.emit('close', 0, null);
  }
  await h.done();
  assert.equal(h.peakWorkerCount(), 2);
  assert.equal(h.complete().summary.succeeded, 4);
  assert.equal(h.complete().summary.failed, 0);
  assert.equal(h.events.filter((event) => event.type === 'exit').length, 1);
});

test('published but unreported output prevents unsafe retry', async (t) => {
  const h = await harness(t);
  const file = await h.input('unreported-output.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { hwpx: false, deleteOriginal: true } });
  const worker = h.workers[0];
  await h.output(worker.payload.tasks[0], 'pdf');
  requestRecycle(h, worker, worker.payload.tasks[0]);
  await h.done();
  assert.equal(h.workers.length, 1);
  assert.equal(h.events.find((event) => event.type === 'file-error').code, 'RECOVERY_OUTPUT_EXISTS');
  assert.equal(h.trashed.length, 0);
});

test('a non-PDF task cannot authorize missing-PDF recovery', async (t) => {
  const h = await harness(t);
  const file = await h.input('hwpx-only-recycle.hwp');
  await h.backend.startConversionJob(h.sender, { files: [file], options: { pdf: false, hwpx: true } });
  const worker = h.workers[0];
  requestRecycle(h, worker, worker.payload.tasks[0]);
  await h.done();
  assert.equal(h.workers.length, 1);
  assert.equal(h.events.find((event) => event.type === 'file-error').code, 'INVALID_WORKER_RECYCLE_REQUEST');
});
