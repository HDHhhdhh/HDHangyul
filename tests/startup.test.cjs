'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const mainPath = path.join(__dirname, '..', 'electron', 'main.cjs');
const source = fs.readFileSync(mainPath, 'utf8');
const mainRequire = createRequire(mainPath);

async function startup(isPackaged, env = {}) {
  const loads = [];
  let ready;
  class BrowserWindow {
    loadURL(url) {
      loads.push(['url', url]);
      return Promise.resolve();
    }
    loadFile(file) {
      assert.ok(fs.existsSync(file));
      loads.push(['file', file]);
      return Promise.resolve();
    }
  }
  const electron = {
    app: {
      isPackaged,
      whenReady: () => ({
        then(callback) { ready = Promise.resolve().then(callback); },
      }),
      on() {},
    },
    BrowserWindow,
    ipcMain: { handle() {} },
  };
  vm.runInNewContext(source, {
    module: { exports: {} },
    __dirname: path.dirname(mainPath),
    process: { env, resourcesPath: '', platform: process.platform },
    console,
    require: (name) => name === 'electron' ? electron : mainRequire(name),
  }, { filename: mainPath });
  await ready;
  return loads;
}

for (const isPackaged of [false, true]) {
  test(`${isPackaged ? 'packaged' : 'source'} startup opens the bundled UI without a server`, async () => {
    assert.deepEqual(await startup(isPackaged), [
      ['file', path.join(__dirname, '..', 'dist', 'index.html')],
    ]);
  });
}

for (const name of ['ELECTRON_RENDERER_URL', 'VITE_DEV_SERVER_URL']) {
  test(`source startup uses explicit ${name}`, async () => {
    const url = 'http://127.0.0.1:5173';
    assert.deepEqual(await startup(false, { [name]: url }), [['url', url]]);
  });
}

test('ELECTRON_RENDERER_URL takes precedence over VITE_DEV_SERVER_URL', async () => {
  assert.deepEqual(await startup(false, {
    ELECTRON_RENDERER_URL: 'http://127.0.0.1:4000',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
  }), [['url', 'http://127.0.0.1:4000']]);
});
