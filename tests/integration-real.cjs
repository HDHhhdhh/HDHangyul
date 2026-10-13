'use strict';
// Exercise the application's actual queue and PowerShell conversion API, without an Electron UI.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const applicationRoot = process.env.HANGUL_CONVERTER_ROOT || path.resolve(__dirname, '..');
const mainPath = path.join(applicationRoot, 'electron/main.cjs');
const realRequire = createRequire(mainPath);
const [jobFile, logFile] = process.argv.slice(2);
if (!jobFile || !logFile) throw new Error('Pass input job JSON and output log JSONL.');
const payload = JSON.parse(fs.readFileSync(jobFile, 'utf8').replace(/^\uFEFF/, ''));
const output = fs.createWriteStream(logFile, { flags: 'w' });
const sender = new EventEmitter();
sender.isDestroyed = () => false;
const started = performance.now();
let terminalResolve;
const terminal = new Promise(resolve => { terminalResolve = resolve; });
sender.send = (_channel, event) => {
  output.write(JSON.stringify(event) + '\n');
  if (['fatal','file-error','file-complete','complete','worker-exit'].includes(event.type)) console.log(JSON.stringify(event));
  if (event.type === 'exit') terminalResolve(event);
};
const mainModule = { exports: {} };
const fakeElectron = {
  app: null,
  ipcMain: { handle() {} },
  shell: { trashItem() { throw new Error('Original deletion is prohibited in this integration check.'); } },
};
vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
  module: mainModule, exports: mainModule.exports, __dirname: path.dirname(mainPath),
  process, Buffer, console, setTimeout, clearTimeout,
  require: name => name === 'electron' ? fakeElectron : realRequire(name),
}, { filename: mainPath });
(async () => {
  payload.options = { ...payload.options, deleteOriginal: false };
  await mainModule.exports.startConversionJob(sender, payload);
  const result = await terminal;
  await new Promise(resolve => output.end(resolve));
  console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - started), result }));
  process.exitCode = result.ok ? 0 : 1;
})().catch(error => { console.error(error); output.end(); process.exitCode = 1; });
