// 穹顶讲解放映协议——消息类型与共享定义。
// 控制台（讲解员）与观众窗（穹顶）通过 BroadcastChannel 交换下列消息。
// 所有命令均携带会话 ID（sessionId）与该会话内单调递增的序号（seq）。

export const CHANNEL_NAME = 'dome-presenter/v1';
export const PROTOCOL_VERSION = 1;

/** 节目单中的一页（节目单在“开始放映”时冻结快照，观众窗只认冻结内容）。 */
export interface ProgramPage {
  id: string;
  name: string;
  /** 导入时解码已失败的页：控制台仍可操作，但观众窗呈现时回 FAIL。 */
  decodeBroken: boolean;
}

// ---------------------------------------------------------------------------
// 消息定义
// ---------------------------------------------------------------------------

export type CommandKind = 'GOTO' | 'SET_BLACKOUT';

interface BaseCommand {
  kind: CommandKind;
  seq: number;
  sessionId: string;
}

/** 切到指定页。pageId 由控制台根据冻结节目单解析，观众窗无需自行翻页。 */
export interface GotoCommand extends BaseCommand {
  kind: 'GOTO';
  pageId: string;
  /** 命令生效后应处的遮黑状态（通常为 false）。 */
  blackout: false;
}

/** 设置遮黑（true=遮黑，false=解除遮黑，解除时展示 pageId 指定页）。 */
export interface BlackoutCommand extends BaseCommand {
  kind: 'SET_BLACKOUT';
  blackout: boolean;
  pageId: string;
}

export type Command = GotoCommand | BlackoutCommand;

export type AckStatus = 'OK' | 'FAIL';

export interface Ack {
  type: 'ACK';
  sessionId: string;
  seq: number;
  status: AckStatus;
  /** status=FAIL 时给出原因，当前仅 'IMAGE_FAILED'（图片呈现失败）。 */
  reason?: 'IMAGE_FAILED';
}

export interface SnapshotReq {
  type: 'SNAPSHOT_REQ';
  sessionId: string;
  /** 请求方生成的关联 ID，防止恢复期间采用其他恢复过程的旧应答。 */
  reqId: string;
}

export interface SnapshotRes {
  type: 'SNAPSHOT_RES';
  sessionId: string;
  reqId: string;
  /** 最后“已确认”的页；可能为 null（从未成功呈现过）。 */
  pageId: string | null;
  blackout: boolean;
  /** 已确认（含失败终结）的最大序号；观众窗据此拒绝旧序号、识别重复重试。 */
  lastSeq: number;
  /** 冻结节目单，重开窗据此恢复完整画面，而不仅是一个页号。 */
  pages: ProgramPage[];
}

export type ChannelMessage = Command | Ack | SnapshotReq | SnapshotRes;

/** 判别通道消息是否为我方协议（忽略同源环境里的其他消息）。 */
export function isChannelMessage(value: unknown): value is ChannelMessage {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { type?: unknown; kind?: unknown }).type;
  if (t === 'ACK' || t === 'SNAPSHOT_REQ' || t === 'SNAPSHOT_RES') {
    return typeof (value as { sessionId?: unknown }).sessionId === 'string';
  }
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'GOTO' || kind === 'SET_BLACKOUT';
}

export function isAck(m: ChannelMessage): m is Ack {
  return 'type' in m && m.type === 'ACK';
}
export function isSnapshotReq(m: ChannelMessage): m is SnapshotReq {
  return 'type' in m && m.type === 'SNAPSHOT_REQ';
}
export function isSnapshotRes(m: ChannelMessage): m is SnapshotRes {
  return 'type' in m && m.type === 'SNAPSHOT_RES';
}
export function isCommand(m: ChannelMessage): m is Command {
  return 'kind' in m;
}

export function createChannel(): BroadcastChannel {
  return new BroadcastChannel(CHANNEL_NAME);
}

export function newSessionId(): string {
  // 会话 ID：会话边界标识。重开观众窗沿用同一会话；结束后再开始是新会话。
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
