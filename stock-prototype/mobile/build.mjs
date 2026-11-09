// 앱용 번들 빌드: server/ 코드를 WebView에서 돌도록 일부 모듈만 앱용으로 바꿔 끼운다.
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = process.argv[2] || path.join(here, '..', 'android', 'build', 'assets', 'www', 'mobile-bundle.js');

const swap = {
  name: 'mobile-swap',
  setup(b) {
    // 패키지 바꿔 끼우기
    b.onResolve({ filter: /^express$/ }, () => ({ path: path.join(here, 'express-shim.js') }));
    b.onResolve({ filter: /^crypto$/ }, () => ({ path: path.join(here, 'crypto-shim.js') }));
    b.onResolve({ filter: /^(fs|path)$/ }, () => ({ path: 'empty', namespace: 'empty' }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'module.exports = {}' }));
    // 파일 바꿔 끼우기: DB 저장소, 외부 HTTP 호출
    b.onResolve({ filter: /^\.\/(storage|http)$/ }, (args) => {
      const dir = path.basename(args.resolveDir);
      if (args.path === './storage' && dir === 'server') return { path: path.join(here, 'storage.js') };
      if (args.path === './http' && dir === 'providers') return { path: path.join(here, 'http.js') };
      return undefined;
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(here, 'entry.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome80',
  minify: true,
  outfile,
  loader: { '.wasm': 'binary' },
  define: { 'process.env.DATA_PROVIDER': '"live"', 'process.env.NODE_ENV': '"production"' },
  plugins: [swap],
  logLevel: 'warning',
});
console.log('bundle:', outfile);
