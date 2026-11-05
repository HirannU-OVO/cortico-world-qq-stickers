/**
 * 表情包直发通道：经 AstrBot Open API 把本机表情库的一张图发到指定会话。
 *
 * 存在的理由：桥接模式下两条旧投递腿在「主动搭话轮」都走不通——
 *   ① send_meme 需要 AstrBot 侧有真实 QQ 事件（meme_manager 的私有 extra）；
 *   ② astrbot_send_message 带图被桥的「120 秒发图授权闸」拦（授权只在收到 QQ 消息后有效）。
 * Open API 不依赖 event，也不受那个闸限制，是主动轮唯一能落地的投递方式。
 *
 * 链路（已实测打通）：
 *   1. POST /api/v1/files      —— 上传图片；FormData 里的 Blob 必须带 image/* 的
 *      Content-Type，附件才会被存成 image 类型，否则 QQ 端会显示成文件；
 *   2. POST /api/v1/im/messages —— 按 umo 直接发送；表情包作为独立一段
 *      （正文由模型经 astrbot_send_message 发出，这里只补图，图文拆开是预期效果）。
 *
 * 要不要发图、发哪张，仍由 gate.ts 的掷骰单例唯一仲裁；本文件只负责「送出去」。
 * 凭据走运营层配置（bridgeApi*），不进面板；token 留空即整体禁用。
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** 表情包单图上限，与 pickStickerFile 的 5.5MB 约束对齐；超限直接跳过不报错。 */
const MAX_IMAGE_BYTES = 5.5 * 1024 * 1024;

const DEFAULT_API_BASE = 'http://127.0.0.1:6185';
const DEFAULT_TIMEOUT_MS = 15_000;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export interface StickerDeliverLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface StickerDeliverConfig {
  /** AstrBot 面板地址，如 http://127.0.0.1:6185。留空用默认。 */
  bridgeApiUrl?: string;
  /** 带 im + file 两个 scope 的 Open API Key。留空 = 直发通道禁用。 */
  bridgeApiToken?: string;
  /** umo 平台名（AstrBot 里 aiocqhttp 平台的自定义 id），如「bot」。 */
  bridgePlatformId?: string;
}

/** private:/group: 地址 → AstrBot unified_msg_origin；解析失败返回 null。 */
export function buildUmo(address: string, platformId: string): string | null {
  const trimmed = typeof address === 'string' ? address.trim() : '';
  const platform = (platformId || '').trim();
  if (!platform) return null;
  let kind = 'private';
  let id = trimmed;
  const withKind = trimmed.match(/^(?:qq:)?(private|group):(\d+)$/i);
  if (withKind) {
    kind = withKind[1].toLowerCase();
    id = withKind[2];
  } else if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const type = kind === 'group' ? 'GroupMessage' : 'FriendMessage';
  return `${platform}:${type}:${id}`;
}

/**
 * 把一张表情包（相对表情库根目录的路径）作为独立一段发到指定会话。
 * 任何失败都以 { ok:false } 返回，绝不抛出；失败不影响已发出的正文。
 */
export async function deliverSticker(
  cfg: StickerDeliverConfig,
  emojiDir: string,
  rel: string,
  address: string,
  log: StickerDeliverLogger,
): Promise<{ ok: boolean; error?: string }> {
  const key = (cfg.bridgeApiToken || '').trim();
  if (!key) return { ok: false, error: '未配置 Open API Key（worlds.qq-stickers.bridgeApiToken），直发通道保持关闭' };

  const umo = buildUmo(address, cfg.bridgePlatformId ?? '');
  if (!umo) return { ok: false, error: `会话地址无法换算成 umo：${address}` };

  const mime = MIME_BY_EXT[extname(rel).toLowerCase()];
  if (!mime) return { ok: false, error: `不支持的图片格式：${rel}` };

  const file = join(emojiDir, ...rel.split('/'));
  try {
    const size = (await stat(file)).size;
    if (size > MAX_IMAGE_BYTES) return { ok: false, error: `图片太大（${Math.round(size / 1024)}KB），跳过` };

    const bytes = await readFile(file);
    const base = (cfg.bridgeApiUrl || '').trim() || DEFAULT_API_BASE;

    // 1) 上传；Content-Type 决定 AstrBot 把附件存成 image 还是 file
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), rel.split('/').pop() || 'sticker');
    const upRes = await fetch(`${base}/api/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const upData = (await upRes.json().catch(() => ({}))) as {
      data?: { attachment_id?: string; type?: string };
    };
    const attachmentId = upData?.data?.attachment_id || '';
    if (!upRes.ok || !attachmentId) {
      return { ok: false, error: `上传失败（HTTP ${upRes.status}）` };
    }
    if (upData?.data?.type !== 'image') {
      return { ok: false, error: `附件被存成了 ${upData?.data?.type ?? '未知'} 类型而不是 image` };
    }

    // 2) 独立一段发出（图文拆开是预期行为：文字先行，表情收尾）
    const sendRes = await fetch(`${base}/api/v1/im/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ umo, message: [{ type: 'image', attachment_id: attachmentId }] }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!sendRes.ok) {
      const detail = await sendRes.text().catch(() => '');
      return { ok: false, error: `发送失败（HTTP ${sendRes.status}）${detail.slice(0, 120)}` };
    }

    log.info(`[表情包] 已给 ${umo} 直发一张（${rel}）。`);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`[表情包] 直发没发出去：${reason}`);
    return { ok: false, error: reason };
  }
}
