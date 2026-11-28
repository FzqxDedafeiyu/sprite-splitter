import { buildWorkbench } from '../workbench/build.mjs';
import { crc32, deflateRawSync } from 'node:zlib';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const browserPath = process.env.V10_BROWSER;
if (!browserPath) throw new Error('Set V10_BROWSER to a Chromium or Edge executable');
const artifactDir = resolve(process.env.V10_BROWSER_ARTIFACTS ?? '.v10-browser-tests');
const defaultPackage = new URL('../../docs/v10/phase-1/p1-0/spike/package.json', import.meta.url);
const require = createRequire(process.env.V10_SPIKE_PACKAGE ?? defaultPackage);
const { build } = require('esbuild');
const fixture = new URL('./project-store.browser.ts', import.meta.url);
const bundle = await build({ stdin: { sourcefile: 'cross-tab.ts', resolveDir: fileURLToPath(new URL('.', fixture)), contents: `
  export { createProject } from '../src/project.ts';
  export { ProjectStore } from '../src/project-store.ts';
` }, bundle: true, write: false, format: 'esm' });
const completeFixture = await build({ entryPoints: [fileURLToPath(fixture)],
  bundle: true, write: false, format: 'esm' });
const runtimeFixture = await build({
  entryPoints: [fileURLToPath(new URL('./interaction.browser.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm'
});
const v9Fixture = await build({
  entryPoints: [fileURLToPath(new URL('./v9-archive.browser.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm'
});
const agentFixture = await readFile(new URL('../../docs/v10/phase-0/results/A-009-agent-json-roundtrip/agent_result.json', import.meta.url));
const v9ArchivePath = new URL('../../docs/v10/phase-0/results/A-010-v9-export-check.zip', import.meta.url);
const v9Archive = await readFile(v9ArchivePath);

function deflatedManifest() {
  const name = Buffer.from('manifest.json');
  const data = Buffer.from(JSON.stringify({ format: 'spatial-scene-layout/v2', sprites: [] }));
  const packed = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}
const deflatedArchive = deflatedManifest();
const html = '<!doctype html><meta charset="utf-8"><pre id="result">pending</pre>';
const server = createServer((request, response) => {
  if (request.url === '/a009-agent-result.json') {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(agentFixture);
  } else if (request.url === '/a010.zip' || request.url === '/deflated.zip') {
    response.setHeader('content-type', 'application/zip');
    response.end(request.url === '/a010.zip' ? v9Archive : deflatedArchive);
  } else if (request.url === '/v9.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(v9Fixture.outputFiles[0].text);
  } else if (request.url === '/v9') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html + '<script type="module" src="/v9.js"></script>');
  } else if (request.url === '/module.js' || request.url === '/fixture.js' || request.url === '/runtime.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end((request.url === '/module.js' ? bundle : request.url === '/runtime.js' ? runtimeFixture : completeFixture).outputFiles[0].text);
  } else {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html + (request.url === '/fixture' ? '<script type="module" src="/fixture.js"></script>' : request.url === '/runtime' ? '<script type="module" src="/runtime.js"></script>' : ''));
  }
});

async function waitFor(read, label) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await pause(100);
  }
  throw new Error('Timed out waiting for ' + label, { cause: lastError });
}

async function openTab(endpoint, url) {
  const response = await fetch(endpoint + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  if (!response.ok) throw new Error('Cannot open browser tab: ' + response.status);
  const target = await response.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const requests = new Map();
  let nextId = 0;
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    for (const { reject } of requests.values()) reject(new Error('Browser tab disconnected'));
    requests.clear();
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  function send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    },
    reload: () => send('Page.reload'),
    async selectFile(selector, path) {
      const { root } = await send('DOM.getDocument');
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId, files: [path] });
    },
    downloads: downloadPath => send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath }),
    mouse: params => send('Input.dispatchMouseEvent', params),
    activate: () => send('Page.bringToFront'),
    close: () => ws.close()
  };
}

await mkdir(artifactDir, { recursive: true });
const profile = await mkdtemp(join(artifactDir, 'profile-'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = 'http://127.0.0.1:' + server.address().port;
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--disable-extensions', '--disable-background-networking', '--disable-crash-reporter',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
let launchError;
browser.on('error', error => { launchError = error; });
const tabs = [];
try {
  const port = await waitFor(async () => {
    if (launchError) throw launchError;
    return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
  }, 'DevTools port');
  const endpoint = 'http://127.0.0.1:' + port;
  const fixtureTab = await openTab(endpoint, url + '/fixture');
  tabs.push(fixtureTab);
  const outcome = await waitFor(async () => {
    const value = await fixtureTab.evaluate('document.querySelector("#result")?.textContent');
    return value && value !== 'pending' ? JSON.parse(value) : undefined;
  }, 'project store fixture');
  if (outcome.test?.error) throw new Error(outcome.test.error);

  const runtimeTab = await openTab(endpoint, url + '/runtime');
  tabs.push(runtimeTab);
  const runtime = await waitFor(async () => {
    const value = await runtimeTab.evaluate('document.querySelector("#result")?.textContent');
    return value && value !== 'pending' ? JSON.parse(value) : undefined;
  }, 'interaction fixture');
  if (runtime.test?.error) throw new Error(runtime.test.error);
  await runtimeTab.activate();
  await runtimeTab.evaluate('new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
  await runtimeTab.mouse({ type: 'mousePressed', x: 45, y: 145, button: 'left', buttons: 1, clickCount: 1 });
  await runtimeTab.mouse({ type: 'mouseMoved', x: 250, y: 240, button: 'left', buttons: 1 });
  await runtimeTab.mouse({ type: 'mouseReleased', x: 250, y: 240, button: 'left', buttons: 0, clickCount: 1 });
  const native = await waitFor(async () => {
    const state = JSON.parse(await runtimeTab.evaluate('document.querySelector("#native-result").textContent'));
    return state.commandCount ? state : undefined;
  }, 'native pointer completion');
  if (!native.captured || native.commandCount !== 1 || !native.inactive) {
    throw new Error('Native pointer capture or release failed: ' + JSON.stringify(native));
  }

  const v9Tab = await openTab(endpoint, url + '/v9');
  tabs.push(v9Tab);
  const v9 = await waitFor(async () => {
    const value = await v9Tab.evaluate('document.querySelector("#result")?.textContent');
    return value && value !== 'pending' ? JSON.parse(value) : undefined;
  }, 'V9 archive fixture');
  if (v9.test?.error) throw new Error(v9.test.error);

  const uiPath = join(profile, 'sprite-v10-test.html');
  await writeFile(uiPath, await buildWorkbench(), 'utf8');
  const app = await openTab(endpoint, pathToFileURL(uiPath).href);
  tabs.push(app);
  const appStatus = () => app.evaluate('document.querySelector("#status")?.textContent');
  await waitFor(async () => (await appStatus())?.includes('请选择 V9'), 'workbench ready');
  await app.selectFile('#zip', fileURLToPath(v9ArchivePath));
  await waitFor(async () => (await appStatus())?.includes('预览已就绪'), 'migration preview');
  const expectedId = await app.evaluate(`(() => {
    const items = document.querySelectorAll('#sprites button');
    if (items.length !== 30 || document.querySelector('#save').disabled) throw Error('Preview table or save unavailable');
    return items[0].dataset.spriteId;
  })()`);
  await app.evaluate('document.querySelector("#save").click()');
  await waitFor(async () => (await appStatus())?.includes('已保存为 V10'), 'project save');
  const savedProjectId = await app.evaluate('document.querySelector("#projects").value');
  if (!savedProjectId) throw new Error('Missing saved workbench project ID');
  await app.reload();
  await waitFor(async () => (await appStatus())?.includes('请选择 V9'), 'workbench reload');
  await app.evaluate(`(() => {
    const select = document.querySelector('#projects');
    select.value = ${JSON.stringify(savedProjectId)};
    select.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(async () => (await appStatus())?.includes('已打开 V10'), 'project reopen');
  const reopenedId = await app.evaluate('document.querySelector("#sprites button").dataset.spriteId');
  if (reopenedId !== expectedId) throw new Error('Reopened workbench changed sprite identity');
  await app.downloads(profile);
  await app.evaluate('document.querySelector("#export").click()');
  await waitFor(async () => (await appStatus())?.includes('兼容 ZIP 已生成'), 'workbench export');
  const downloaded = await waitFor(async () => (await readdir(profile)).find(name => name.endsWith('-v9.zip')), 'downloaded V9 archive');
  const output = await readFile(join(profile, downloaded));
  if (output.length < 22 || output.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid workbench download');
  const workbench = { actualFileInput: 'pass', savedAndReopened: 'pass', exportedDownload: 'pass' };

  const first = await openTab(endpoint, url);
  tabs.push(first);
  const second = await openTab(endpoint, url);
  tabs.push(second);
  async function initialize(tab) {
    await waitFor(() => tab.evaluate('location.origin === ' + JSON.stringify(url)), 'browser page');
    await tab.evaluate(`(async () => {
      globalThis.api = await import('/module.js');
      globalThis.store = await api.ProjectStore.open('v10-cross-tab');
    })()`);
  }
  await Promise.all([initialize(first), initialize(second)]);
  const id = await first.evaluate(`(async () => {
    const document = api.createProject();
    await store.create(document);
    return document.projectId;
  })()`);
  const quotedId = JSON.stringify(id);
  for (const tab of [first, second]) {
    await tab.evaluate(`(async () => {
      globalThis.snapshot = (await store.load(${quotedId})).document;
      if (snapshot.revision !== 1) throw new Error('Did not read original snapshot');
    })()`);
  }
  const outcomes = await Promise.all([first, second].map((tab, index) => tab.evaluate(`(async () => {
    const next = structuredClone(snapshot);
    const key = 'projectSettings:' + next.projectId;
    next.revision++;
    next.projectSettings.revision++;
    next.projectSettings.defaultFps = ${18 + index};
    next.revisionLedger.entities[key]++;
    try {
      await store.commit(next, { projectRevision: 1, entities: { [key]: { state: 'present', revision: 1 } },
        resources: {} });
      return { saved: next.projectSettings.defaultFps };
    } catch (error) { return { conflict: error.kind }; }
  })()`)));
  const saved = outcomes.filter(value => value.saved);
  if (saved.length !== 1 || !outcomes.some(value => value.conflict === 'target-entity')) {
    throw new Error('Cross-tab write did not reject a stale entity: ' + JSON.stringify(outcomes));
  }
  await second.reload();
  await waitFor(() => second.evaluate('typeof globalThis.snapshot === "undefined"'), 'fresh page context');
  await initialize(second);
  const reopened = await second.evaluate(`(async () => {
    const { document } = await store.load(${quotedId});
    return [document.revision, document.projectSettings.defaultFps];
  })()`);
  if (reopened[0] !== 2 || reopened[1] !== saved[0].saved) throw new Error('Reload did not read the winning commit');
  console.log(JSON.stringify({ fixture: outcome, runtime, native, v9, workbench, twoTabs: 'one commit, one stale entity conflict', reloaded: reopened }));
} finally {
  for (const tab of tabs) tab.close();
  browser.kill();
  server.close();
}
