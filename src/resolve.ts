/**
 * 出站消息的表情解析：发送方（如 qq-proactive 的 OneBot 直发）把整条正文交给这里，
 * 拿回「净化后的正文 + 图片段」，自己只管传输。
 *
 * 本文件是「表情怎么进一条待发消息」的唯一所有者：
 * - 兜底掷骰（正文缺标记时按概率补一张）——走 gate.ts 同一单例账本；
 * - [表情包:分类/文件名] 标记 → 本机图片段（路径安全：只允许表情库内的文件）。
 *
 * 治理规矩：ownerActive（qq-stickers World 是否在运行）为假时一律原样放行、
 * 绝不出图——表情管理关了，无论哪条链路都不该发图。
 *
 * 段数组而非 CQ 码：不受路径里的逗号、空格、中文影响（做法对齐 qq-final 的 normalize.ts）。
 */
import { existsSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { autoPick, gateRoot, ownerIsActive } from './gate.ts';

/** OneBot 发送段（只覆盖发送方用到的两种；与 onebot 侧同形）。 */
export type OutgoingSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file: string } };

export interface ResolveLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
}

const IMAGE_EXTENSIONS = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];

/** 在表情库根目录内解析标记里的文件名；找不到或越界则返回 null。 */
function resolveSticker(base: string, name: string): string | null {
  if (!base || !name) return null;
  const cleaned = name.trim().replace(/^[\\/]+/, '');
  if (!cleaned || cleaned.includes('..')) return null;

  const root = resolve(base);
  const candidates = extname(cleaned) ? [cleaned] : IMAGE_EXTENSIONS.map((ext) => cleaned + ext);
  for (const rel of candidates) {
    const abs = resolve(root, rel);
    // 必须仍在根目录内
    if (abs !== root && !abs.startsWith(root + sep)) continue;
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** 正文里是否已带表情/图片标记（兜底只补全裸文本）。 */
export function hasStickerMarker(text: string): boolean {
  return /\[(?:表情包|图片)\s*[:：]/.test(text);
}

/** [表情包:分类/文件名] → 图片段；解析不到文件时丢弃该标记，不把标记原样发出去。 */
export function buildOutgoingSegments(text: string): OutgoingSegment[] {
  const body = typeof text === 'string' ? text : String(text ?? '');
  const root = gateRoot();
  if (!root || !body.includes('[表情包:')) {
    return body ? [{ type: 'text', data: { text: body } }] : [];
  }

  const segments: OutgoingSegment[] = [];
  const pattern = /\[表情包:([^\[\]]{1,120})\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    if (m.index > last) {
      segments.push({ type: 'text', data: { text: body.slice(last, m.index) } });
    }
    const file = resolveSticker(root, m[1]);
    if (file) segments.push({ type: 'image', data: { file } });
    last = m.index + m[0].length;
  }
  if (last < body.length) {
    segments.push({ type: 'text', data: { text: body.slice(last) } });
  }
  return segments;
}

/**
 * 出站解析总入口。
 * - 表情扩展未运行：正文原样、无图片段（任何链路都不出图）；
 * - 正文缺标记：走掷骰兜底（概率/保底/冷却同 gate 账本），通过则补一张收尾；
 * - 标记统一转成图片段。
 */
export function resolveOutgoing(
  text: string,
  log?: ResolveLogger,
): { text: string; segments: OutgoingSegment[] } {
  const body = typeof text === 'string' ? text : String(text ?? '');
  if (!ownerIsActive()) {
    return { text: body, segments: [] };
  }

  let bodyToSend = body;
  if (!hasStickerMarker(body)) {
    const pick = autoPick();
    if (pick.pass && pick.rel) {
      bodyToSend = `${body}\n[表情包:${pick.rel}]`;
    } else if (log && pick.reason) {
      log.info(`[表情包] 兜底未通过：${pick.reason}`);
    }
  }

  return { text: bodyToSend, segments: buildOutgoingSegments(bodyToSend) };
}
