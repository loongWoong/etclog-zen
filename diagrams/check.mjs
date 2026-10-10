// 出图后的体检：XML prolog / xmlns / 跨图重复 id / url(#…) 引用 / 根尺寸 / 文字条数。
// 用法：bun run check.mjs
import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'F:/caochun/etclog/diagrams/out/';
const files = readdirSync(DIR).filter((f) => /^\d\d-.*\.svg$/.test(f)).sort();
const idOwner = new Map();
const problems = [];

for (const f of files) {
  const raw = readFileSync(DIR + f, 'utf8');
  const prolog = raw.startsWith('<?xml');
  const root = raw.match(/<svg[^>]*>/)?.[0] ?? '';
  const w = root.match(/width="([^"]+)"/)?.[1];
  const h = root.match(/height="([^"]+)"/)?.[1];
  const xmlns = /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(root);
  const ids = [...raw.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const refs = [...raw.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  const texts = (raw.match(/<text/g) ?? []).length;
  const nan = /NaN|undefined/.test(raw);
  for (const id of ids) {
    if (idOwner.has(id)) problems.push(`跨图重复 id "${id}": ${idOwner.get(id)} 与 ${f}`);
    else idOwner.set(id, f);
  }
  const missing = [...new Set(refs)].filter((r) => !ids.includes(r));
  console.log(`${f.padEnd(26)} ${String(w).padStart(5)}x${String(h).padEnd(6)} prolog=${prolog ? 'ok ' : 'no '} xmlns=${xmlns ? 'ok' : 'MISSING'} ids=${String(ids.length).padStart(3)} text=${String(texts).padStart(3)} bytes=${String(raw.length).padStart(6)}`);
  if (!prolog) problems.push(`${f} 缺 XML prolog（独立 .svg 文件应有）`);
  if (!xmlns) problems.push(`${f} 根元素缺 xmlns`);
  if (missing.length) problems.push(`${f} 引用了不存在的 id: ${missing.join(',')}`);
  if (nan) problems.push(`${f} 产物里出现 NaN / undefined`);
}
// 索引页是把 SVG 剥掉 prolog 后内嵌的：这里反向确认内嵌副本干净
try {
  const page = readFileSync('F:/caochun/etclog/diagrams/讨论图索引.html', 'utf8');
  const inlined = (page.match(/<svg /g) ?? []).length;
  if (/<\?xml/.test(page)) problems.push('讨论图索引.html 里残留了 XML prolog');
  if (inlined !== files.length) problems.push(`讨论图索引.html 内嵌 ${inlined} 张，磁盘上有 ${files.length} 张`);
  console.log(`\n讨论图索引.html: 内嵌 ${inlined} 张 SVG，无 XML prolog`);
} catch {
  problems.push('讨论图索引.html 不存在（先跑 bun run index.mjs）');
}
console.log(problems.length ? `\n问题:\n  ${problems.join('\n  ')}` : '\n结论：prolog/xmlns 齐、跨图无重复 id、无 NaN、索引页内嵌一致 —— 可交付。');
