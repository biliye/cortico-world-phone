/**
 * 配置声明与默认值必须对得上,而且**只能用框架真支持的那几种形状**。
 *
 * 这一份的存在理由是一个真踩过的坑:我一开始把"接听名单"(`callers`)声明成
 * `type: 'array'` 想当列表用 —— 而框架的 `array` **不是通用列表**:
 * `readGroupValues` 会把它强制成 `[数, 数]` 一对,写入侧还要求长度必须等于 2
 * (`config-schema.ts` 的 `needsPair`)。挂进表单只会被压成 `[号, 0]`。
 * 表现是"控制台上那一格填了也存不下来",而这类错**不会报任何错**。
 *
 * 所以这里逐条核两件事:
 * 1. 声明过的路径在 `defaults()` 里**有对应项且类型相符**(缺默认值时控制台照样渲染旋钮、
 *    照样写回 config.json,而读到的是代码里另一处的兜底值);
 * 2. `array` 类型只能是"两个数的区间"这种形状 —— 列表类配置**不许**声明成表单旋钮。
 */
import { describe, expect, it } from 'vitest';
import { PHONE_CONFIG_GROUP, PHONE_DEFAULTS, dialTarget } from '../src/config.ts';

/** 按点分路径取值(与框架读配置同一个口径)。 */
function getByPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const declared = Object.entries(PHONE_CONFIG_GROUP.schema.properties);

describe('配置声明', () => {
  it('每个声明过的路径都在 worlds.phone 段里,且不越界', () => {
    for (const [path] of declared) {
      expect(path.startsWith('worlds.phone.')).toBe(true);
    }
  });

  it('每个声明过的路径在 defaults() 里都有值,且类型对得上', () => {
    for (const [path, prop] of declared) {
      // 声明里写的是**整份配置**的路径(`worlds.phone.x`),而 PHONE_DEFAULTS 就是那一段本身,
      // 所以比之前把前缀去掉 —— 与框架读配置的口径一致,只是起点不同。
      const value = getByPath(PHONE_DEFAULTS, path.replace(/^worlds\.phone\./, ''));
      expect(value, `${path} 在 defaults() 里缺默认值`).toBeDefined();
      if (prop.type === 'boolean') expect(typeof value, path).toBe('boolean');
      else if (prop.type === 'string') expect(typeof value, path).toBe('string');
      else if (prop.type === 'integer' || prop.type === 'number') {
        expect(typeof value, path).toBe('number');
        if (prop.type === 'integer') expect(Number.isInteger(value), `${path} 该是整数`).toBe(true);
      } else if (prop.type === 'array') {
        // 只有"两个数的区间"这一种数组能在表单里活着(mouse 的 moveDurationMs 就是它)。
        expect(Array.isArray(value), `${path} 该是数组`).toBe(true);
        expect((value as unknown[]).length, `${path} 只支持两个数的区间`).toBe(2);
        for (const item of value as unknown[]) expect(typeof item).toBe('number');
      }
    }
  });

  it('列表类配置不许进表单(**回归护栏**):接听名单只从 config.json 改', () => {
    expect(PHONE_CONFIG_GROUP.schema.properties['worlds.phone.callers']).toBeUndefined();
    // 但它在**配置段**里必须有默认值,否则控制台写回时会把它弄丢。
    expect(Array.isArray(PHONE_DEFAULTS.callers)).toBe(true);
  });

  it('不可热改的旋钮(x-hot:false)都标清楚了 —— 隧道与令牌这类重启才生效', () => {
    for (const [path, prop] of declared) {
      const hot = (prop as { 'x-hot'?: boolean })['x-hot'];
      // 每个旋钮都要明确表态;没写的按框架的口径是热改,所以这里只要求它是布尔。
      if (hot !== undefined) expect(typeof hot, path).toBe('boolean');
    }
    expect((PHONE_CONFIG_GROUP.schema.properties['worlds.phone.bridgeUrl'] as { 'x-hot'?: boolean })['x-hot']).toBe(false);
    expect((PHONE_CONFIG_GROUP.schema.properties['worlds.phone.ssh.enabled'] as { 'x-hot'?: boolean })['x-hot']).toBe(false);
  });

  it('控制台旋钮不该漏掉该管的东西:名单之外的关键几格都在', () => {
    for (const path of [
      'worlds.phone.autoAnswer',
      'worlds.phone.rejectUnknown',
      'worlds.phone.ringTimeoutSec',
      'worlds.phone.bargeIn',
      'worlds.phone.tts.voiceId',
      'worlds.phone.ssh.enabled',
      'worlds.phone.ssh.recoverCommand',
      // 拨号目标是个**单值**字符串,所以它能安全地进表单(名单那种列表不能)。
      'worlds.phone.dial.target',
    ]) {
      expect(PHONE_CONFIG_GROUP.schema.properties[path], `${path} 应该能在表单里改`).toBeDefined();
    }
  });
});

describe('dialTarget:这一格是后加的,读的时候必须容错', () => {
  it('配置里根本没有 dial(他部署里那份就是)**不能崩**,一律当没配', () => {
    expect(dialTarget({})).toEqual({ target: '', label: '' });
    expect(dialTarget(undefined)).toEqual({ target: '', label: '' });
  });

  it('写过但写空了 / 类型不对:也当没配', () => {
    expect(dialTarget({ dial: {} })).toEqual({ target: '', label: '' });
    expect(dialTarget({ dial: { target: '   ' } })).toEqual({ target: '', label: '' });
    expect(dialTarget({ dial: { target: 123 as unknown as string } })).toEqual({ target: '', label: '' });
  });

  it('配了就照抄,并去掉两头的空白;称呼空着就用目标本身', () => {
    expect(dialTarget({ dial: { target: ' u_x ', label: ' 主人 ' } })).toEqual({ target: 'u_x', label: '主人' });
    expect(dialTarget({ dial: { target: 'u_x' } })).toEqual({ target: 'u_x', label: 'u_x' });
  });
});
