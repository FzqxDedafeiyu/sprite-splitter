import { fileURLToPath } from 'node:url';

export default {
  base: './',
  resolve: { alias: { '@geometry': fileURLToPath(new URL('./src/geometry.ts', import.meta.url)) } }
};
