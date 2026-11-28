import { toDevice } from '@geometry';

document.querySelector('#result').value = JSON.stringify(
  toDevice({ x: 2, y: 4 }, { origin: { x: 1, y: 1 }, zoom: 2, dpr: 2 })
);
