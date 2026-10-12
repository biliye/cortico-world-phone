/**
 * 耳朵里那几个**纯判断**的单测。
 *
 * 分段器那部分与 hearing 同源、在 world.test.ts 里连着整条路一起验;
 * 这里只验"猜错的语言"那条新判据 —— 它是在真数据上换来的(碎片段被猜成 `Yeah.` / `やて。` / `그.`),
 * 而它的分寸全在**宁可漏、不可误杀真人话**上,那正是最需要钉住的地方。
 */
import { describe, expect, it } from 'vitest';
import { hasCjk, hasWords, looksLikeWrongLanguage } from '../src/ear.ts';

describe('hasCjk / hasWords', () => {
  it('汉字算汉字;假名、谚文、拉丁字母不算', () => {
    expect(hasCjk('你好呀')).toBe(true);
    expect(hasCjk('やて。')).toBe(false);
    expect(hasCjk('Yeah.')).toBe(false);
    expect(hasCjk('123')).toBe(false);
  });

  it('有没有"话":字母或数字都算', () => {
    expect(hasWords('🎼')).toBe(false);
    expect(hasWords('❓')).toBe(false);
    expect(hasWords('OK')).toBe(true);
    expect(hasWords('3')).toBe(true);
  });
});

describe('looksLikeWrongLanguage:像不像这一通该说的话', () => {
  it('假名 / 谚文一律算猜错(中文电话里不可能出现)', () => {
    expect(looksLikeWrongLanguage('やて。', 'auto')).toBe(true);
    expect(looksLikeWrongLanguage('그.', 'auto')).toBe(true);
    expect(looksLikeWrongLanguage('소리', 'zh')).toBe(true);
  });

  it('配成中文时:一个汉字都没有的正文算"没听清"(含 `Yeah.` 这种)', () => {
    expect(looksLikeWrongLanguage('Yeah.', 'zh')).toBe(true);
    expect(looksLikeWrongLanguage('OK', 'zh')).toBe(true);
    expect(looksLikeWrongLanguage('hello world', 'zh')).toBe(true);
    // 有汉字就是认出来了,别动它。
    expect(looksLikeWrongLanguage('你好', 'zh')).toBe(false);
    expect(looksLikeWrongLanguage('OK,你好', 'zh')).toBe(false);
  });

  it('★ auto 下的拉丁短词**不动** —— 那可能就是他真说的话', () => {
    expect(looksLikeWrongLanguage('OK', 'auto')).toBe(false);
    expect(looksLikeWrongLanguage('Yeah.', 'auto')).toBe(false);
    expect(looksLikeWrongLanguage('好的', 'auto')).toBe(false);
    expect(looksLikeWrongLanguage('OK', '')).toBe(false);
  });

  it('配的是别的语言(比如 en)就尊重配置,不拿中文去判它', () => {
    expect(looksLikeWrongLanguage('hello', 'en')).toBe(false);
  });

  it('没有话的正文交给另一条判据(hasWords 那一关),这里返回 false', () => {
    expect(looksLikeWrongLanguage('🎼', 'zh')).toBe(false);
    expect(looksLikeWrongLanguage('', 'zh')).toBe(false);
  });
});
