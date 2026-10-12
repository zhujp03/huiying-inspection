// 生成小程序 tabBar 图标（81×81 PNG，纯 Node 内置模块，零依赖）。
// 常规色 #8a8d92 / 选中色 #f25f42，与 app.json tabBar 配置一致。
// 用法：node scripts/generate-tabbar-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 81;
const SUPERSAMPLE = 3;
const STROKE_HALF = 2.6;
const NORMAL = [138, 141, 146];
const ACTIVE = [242, 95, 66];
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/miniapp/miniprogram/assets/tabbar");

// ---------- PNG 编码 ----------
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  head.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([head, data])), 8 + data.length);
  return out;
}
function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = SIZE * 4 + 1;
  const raw = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 距离场（线性图标：线段/圆/圆角矩形并集 + 描边） ----------
const seg = (ax, ay, bx, by) => (px, py) => {
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
};
const circle = (cx, cy, r) => (px, py) => Math.hypot(px - cx, py - cy) - r;
const roundRect = (cx, cy, hw, hh, r) => (px, py) => {
  const qx = Math.abs(px - cx) - (hw - r), qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const GLYPHS = {
  home: [
    seg(19, 42, 40.5, 23), seg(40.5, 23, 62, 42),
    seg(26, 38, 26, 63), seg(26, 63, 55, 63), seg(55, 38, 55, 63),
    seg(36, 63, 36, 51), seg(36, 51, 45, 51), seg(45, 51, 45, 63),
  ],
  schedule: [
    roundRect(40.5, 42, 19.5, 17, 6),
    seg(31, 25, 31, 17), seg(50, 25, 50, 17), seg(21, 36, 60, 36),
    circle(30.5, 45, 2.2), circle(40.5, 45, 2.2), circle(50.5, 45, 2.2),
    circle(30.5, 53, 2.2), circle(40.5, 53, 2.2), circle(50.5, 53, 2.2),
  ],
  profile: [circle(40.5, 33, 11), circle(40.5, 68, 20)],
};

function renderGlyph(primitives, color) {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let coverage = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE, py = y + (sy + 0.5) / SUPERSAMPLE;
          let d = Infinity;
          for (const primitive of primitives) d = Math.min(d, primitive(px, py));
          if (d < STROKE_HALF) coverage++;
        }
      }
      const i = (y * SIZE + x) * 4;
      out[i] = color[0]; out[i + 1] = color[1]; out[i + 2] = color[2];
      out[i + 3] = Math.round((coverage / (SUPERSAMPLE * SUPERSAMPLE)) * 255);
    }
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, primitives] of Object.entries(GLYPHS)) {
  writeFileSync(join(OUT_DIR, `${name}.png`), encodePng(renderGlyph(primitives, NORMAL)));
  writeFileSync(join(OUT_DIR, `${name}-active.png`), encodePng(renderGlyph(primitives, ACTIVE)));
  console.log(`generated ${name}.png / ${name}-active.png`);
}
console.log(`done → ${OUT_DIR}`);
