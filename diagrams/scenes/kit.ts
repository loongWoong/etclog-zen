// 供本次讨论图共用的薄封装：盒宽/落位/折线/旁注/落盘 + 门禁判决。
// 只做组装，不做排版决策（决策都在各 scenes/*.ts 里）。
import { writeFileSync } from 'node:fs';
import {
  THEMES, cardFit, placeCard, nodeFit, routeOrthogonal, textNote, tryExport,
  type AuditLevel, type Pt, type Rect, type Scene, type SceneEdge, type SceneGroup, type SceneNode,
  type SceneText, type Theme, type Tone, type Variant,
} from '@watert/svg-infovis';

export const THEME: Theme = THEMES.light;
export const OUT = 'F:/caochun/etclog/diagrams/out/';
/** 中文字形优先的字体栈：Windows 参会机器上落到微软雅黑，避免 CJK 走 fallback 出豆腐块 */
export const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", ui-sans-serif, system-ui, sans-serif';

/** 多行卡片：左对齐正文，行数定盒高，最长行定盒宽 */
export function card(id: string, lines: string[], at: Pt, opts: {
  tone?: Tone; variant?: Variant; fontSize?: number; padding?: number | [number, number];
} = {}): { node: SceneNode; rect: Rect } {
  const fontSize = opts.fontSize ?? 13;
  const fit = cardFit({ lines, fontSize, level: 'showcase', padding: opts.padding });
  const { card: rect } = placeCard(fit, at);
  return { node: { id, rect, label: lines.join('\n'), fontSize, align: 'start', tone: opts.tone, variant: opts.variant, weight: fit.weight }, rect };
}

/** 单/双行节点：标签居中，盒宽盒高由 nodeFit 反算 */
export function box(id: string, label: string, at: Pt, opts: {
  sub?: string; tone?: Tone; variant?: Variant; shape?: 'rect' | 'diamond' | 'cylinder'; fontSize?: number;
} = {}): { node: SceneNode; rect: Rect } {
  const fit = nodeFit({ label, sub: opts.sub, shape: opts.shape, fontSize: opts.fontSize, level: 'showcase' });
  const rect: Rect = { x: at.x - fit.w / 2, y: at.y - fit.h / 2, w: fit.w, h: fit.h };
  return { node: { id, rect, label, sub: opts.sub, tone: opts.tone, variant: opts.variant, shape: opts.shape, fontSize: opts.fontSize }, rect };
}

/** 正交折线：via 是作者声明的绕行点，不是避障 */
export function wire(fromId: string, toId: string, from: Rect, to: Rect, o: {
  fromSide: 'top' | 'bottom' | 'left' | 'right'; toSide: 'top' | 'bottom' | 'left' | 'right';
  fromT?: number; toT?: number; stub?: number; label?: string; tone?: Tone; via?: Pt[]; id?: string;
}): SceneEdge {
  const r = routeOrthogonal({
    from, fromPort: { side: o.fromSide, t: o.fromT }, to, toPort: { side: o.toSide, t: o.toT },
    stub: o.stub, via: o.via,
  });
  return { id: o.id ?? `e.${fromId}->${toId}`, from: fromId, to: toId, points: r.points, label: o.label, tone: o.tone };
}

/** 旁注：尺寸由 textNote 逐行量，落位是作者给的锚点 */
export function note(id: string, content: string, at: Pt, o: { anchor?: 'start' | 'middle' | 'end'; fontSize?: number; color?: string; weight?: number } = {}): SceneText {
  return textNote({ id, content, at, anchor: o.anchor, fontSize: o.fontSize, color: o.color, weight: o.weight });
}

export function sceneOf(parts: { nodes?: SceneNode[]; edges?: SceneEdge[]; texts?: SceneText[]; groups?: SceneGroup[] }): Scene {
  return { width: 0, height: 0, nodes: parts.nodes ?? [], edges: parts.edges ?? [], texts: parts.texts, groups: parts.groups };
}

/** 出口：门禁不过只出草稿；判决一律落到 exit code */
export function emit(scene: Scene, file: string, title: string, opts: { level?: AuditLevel; grid?: boolean } = {}) {
  const res = tryExport(scene, {
    level: opts.level ?? 'showcase', theme: THEME, fit: true, title, fontFamily: FONT,
    grid: opts.grid === false ? false : undefined,
  });
  writeFileSync(OUT + file, res.svg);
  console.error(`${file}: pass=${res.report.pass} draft=${res.draft} 节点=${scene.nodes.length} 边=${scene.edges.length} 文字=${(scene.texts ?? []).length} bytes=${new TextEncoder().encode(res.svg).length}`);
  for (const d of res.report.diagnostics) console.error(`  [${d.severity}] ${d.code} @ ${d.subject.kind}:${d.subject.id} — ${d.message}`);
  if (!res.report.pass) process.exitCode = 1;
  return res;
}
