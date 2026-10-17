import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { build } from 'electron-builder';

const root = resolve(import.meta.dirname, '..');
const stage = join(root, '.runtime', 'desktop-package-' + Date.now());
mkdirSync(stage, { recursive: true });
for (const dir of ['server', 'shared', 'desktop']) {
  mkdirSync(join(stage, dir), { recursive: true });
  for (const name of readdirSync(join(root, dir))) if ((name.endsWith('.mjs') && !name.endsWith('.test.mjs') && name !== 'build.mjs') || name === 'preload.cjs') cpSync(join(root, dir, name), join(stage, dir, name));
}
cpSync(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(root, 'node_modules', 'ws'), join(stage, 'node_modules', 'ws'), { recursive: true });
const version = JSON.parse(readFileSync(join(root, 'package.json'))).version;
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'valheim-resource-manager', productName: 'Valheim Resource Manager', version, description: 'Локальный учёт ресурсов Valheim', author: 'HarryCane1995', license: 'UNLICENSED', type: 'module', main: 'desktop/main.mjs', dependencies: { ws: JSON.parse(readFileSync(join(root, 'node_modules', 'ws', 'package.json'))).version } }, null, 2));
// Rasterize our own geometric favicon; no game images enter the package.
function crc32(bytes) { let crc = -1; for (const value of bytes) { crc ^= value; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ -1) >>> 0; }
function chunk(type, data) { const head = Buffer.from(type), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); head.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([head, data])), data.length + 8); return result; }
function distance(x,y,a,b) { const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy))); return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy); }
const size=256, raw=Buffer.alloc((size*4+1)*size), lines=[[[24,5],[41,15]],[[41,15],[41,34]],[[41,34],[24,44]],[[24,44],[7,34]],[[7,34],[7,15]],[[7,15],[24,5]],[[24,10],[24,39]],[[14,17],[24,35]],[[24,35],[34,17]],[[14,17],[24,23]],[[24,23],[34,17]]];
for(let y=0;y<size;y++) for(let x=0;x<size;x++){ const index=y*(size*4+1)+1+x*4; const gold=lines.some(([a,b])=>distance((x+.5)*48/size,(y+.5)*48/size,a,b)<1); raw.set(gold?[209,168,100,255]:[23,30,34,255],index); }
const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);
const icon=join(stage,'desktop','icon.ico');writeFileSync(icon,Buffer.concat([ico,png]));
const artifacts=await build({ config: { appId:'HarryCane1995.ValheimResourceManager', productName:'Valheim Resource Manager', electronVersion:'44.9.0', electronDist:join(root,'node_modules','electron','dist'), directories:{app:stage,output:join(root,'output','desktop','build-'+Date.now())}, npmRebuild:false, nodeGypRebuild:false, files:['**/*'], asar:true, win:{target:[{target:'portable',arch:['x64']}],icon,signAndEditExecutable:false}, portable:{artifactName:'ValheimResourceManager-${version}-portable.exe',requestExecutionLevel:'user',unpackDirName:false}, compression:'normal', publish:null } });
const exe=artifacts.find(path=>path.endsWith('.exe'));
if(!exe)throw Error('Portable executable was not produced');
copyFileSync(exe,join(root,'ValheimResourceManager.exe'));
console.log('Portable EXE ready: ValheimResourceManager.exe');
