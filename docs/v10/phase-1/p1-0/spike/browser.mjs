import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const [profile, probe] = process.argv.slice(2);
let port;
for (let attempt = 0; attempt < 50 && !port; attempt++) {
  try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]; }
  catch { await pause(200); }
}
if (!port) throw new Error('Edge did not expose a debugging port');
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
const target = targets.find(entry => entry.type === 'page' && entry.url === 'about:blank');
if (!target) throw new Error('No blank browser page');
const socket = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const replies = new Map();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  const handle = replies.get(message.id);
  if (!handle) return;
  replies.delete(message.id);
  if (message.error) handle.reject(new Error(message.error.message));
  else handle.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const call = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence;
  replies.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
try {
  await call('Network.enable');
  await call('Page.navigate', { url: pathToFileURL(probe).href });
  let observed;
  for (let attempt = 0; attempt < 50 && !observed; attempt++) {
    const { result } = await call('Runtime.evaluate', {
      expression: 'document.querySelector("#result")?.textContent'
    });
    if (result.value?.startsWith('{')) observed = result.value;
    else await pause(200);
  }
  if (!observed) {
    const { result } = await call('Runtime.evaluate', {
      expression: 'JSON.stringify({ url: location.href, ready: document.readyState, status: document.querySelector("#result")?.textContent, text: document.body?.innerText.slice(0, 180) })'
    });
    throw new Error('No finished result: ' + result.value);
  }
  console.log(observed);
  const results = JSON.parse(observed);
  if (Object.values(results).some(result => result.error)) process.exitCode = 1;
} finally {
  socket.close();
}
