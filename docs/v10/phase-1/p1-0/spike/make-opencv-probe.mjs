import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [assetPath, outputPath] = process.argv.slice(2);
const asset = readFileSync(assetPath);
const hash = createHash('sha256').update(asset).digest('hex');
if (hash !== 'c7d6967284acc7eb50897eeb4186690444396bbe834aeb7caf7a565285976829') {
  throw new Error('Unexpected OpenCV.js SHA-256: ' + hash);
}
const task = String.raw`
(async () => {
  try {
    const cv = self.cv;
    await new Promise(resolve => cv.then(() => resolve()));
    const cut = () => {
      const size = 32;
      const image = new cv.Mat(size, size, cv.CV_8UC3, new cv.Scalar(255, 255, 255));
      const mask = new cv.Mat();
      const bg = new cv.Mat();
      const fg = new cv.Mat();
      try {
        for (let y = 9; y < 23; y++) for (let x = 9; x < 23; x++) image.ucharPtr(y, x).fill(0);
        cv.grabCut(image, mask, new cv.Rect(6, 6, 20, 20), bg, fg, 1, cv.GC_INIT_WITH_RECT);
        return { center: mask.ucharPtr(16, 16)[0] & 1, edge: mask.ucharPtr(0, 0)[0] & 1 };
      } finally { image.delete(); mask.delete(); bg.delete(); fg.delete(); }
    };
    onmessage = ({data}) => {
      if (data === 'cut') postMessage({ type: 'cut', ...cut() });
      if (data === 'cancel') {
        postMessage({ type: 'started' });
        for (let index = 0; index < 1000; index++) cut();
        postMessage({ type: 'finished' });
      }
    };
    postMessage({ type: 'ready' });
  } catch (error) { postMessage({ type: 'failure', error: String(error) }); }
})();
`;
const driver = String.raw`
const result = document.querySelector('#result');
const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(asset), x => x.charCodeAt(0)), '\n', task], { type: 'text/javascript' }));
const worker = new Worker(url);
let stopped = false;
let pixels;
const timer = setTimeout(() => fail(new Error('OpenCV probe timed out')), 8000);
function fail(error) {
  clearTimeout(timer);
  worker.terminate();
  URL.revokeObjectURL(url);
  result.textContent = JSON.stringify({ opencv: { error: String(error) } });
}
worker.onerror = event => fail(event.message);
worker.onmessage = ({data}) => {
  if (data.type === 'ready') worker.postMessage('cut');
  else if (data.type === 'failure') fail(data.error);
  else if (data.type === 'cut') {
    if (data.center !== 1 || data.edge !== 0) return fail(new Error('GrabCut mask mismatch'));
    pixels = [data.center, data.edge];
    worker.postMessage('cancel');
  } else if (data.type === 'started') {
    worker.terminate();
    stopped = true;
    setTimeout(() => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      result.textContent = JSON.stringify({ opencv: { pixels, cancelledBeforeFinish: stopped } });
    }, 300);
  } else if (data.type === 'finished') fail(new Error('Cancelled worker delivered completion'));
};
`;
writeFileSync(outputPath, '<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script>const asset=' + JSON.stringify(asset.toString('base64')) + ';const task=' + JSON.stringify(task) + ';' + driver + '</script>');

