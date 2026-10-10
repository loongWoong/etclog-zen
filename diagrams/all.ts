// 一次跑完 6 张图 + 结构体检。用法：bun run all.ts
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const scenes = readdirSync('scenes').filter((f) => /^\d\d-.*\.ts$/.test(f)).sort();
let failed = 0;
for (const s of scenes) {
  const r = spawnSync('bun', ['run', `scenes/${s}`], { encoding: 'utf8' });
  const line = (r.stderr ?? '').trim().split('\n').find((l) => l.includes('pass=')) ?? (r.stderr ?? '').trim();
  console.log(`${String(r.status).padStart(3)}  ${s.padEnd(28)} ${line}`);
  if (r.status !== 0) failed += 1;
}
process.exitCode = failed ? 1 : 0;
