/** 这一包里几处都要用到的小东西。放一处,免得各模块各写一份。 */

/** 日志接口(只要求这几个方法;WorldHost 的 Logger 天然满足)。 */
export interface VoiceLoggerLike {
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

/** 把任何东西变成一句能写进日志/回执的话。 */
export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 秒数说成人话:38 秒 / 2 分 05 秒。事件正文与回执里都用它。 */
export function humanSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m} 分 ${String(s).padStart(2, '0')} 秒`;
}

/** 秒数化成 mm:ss，状态栏用。 */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
