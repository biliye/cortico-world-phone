import { describe, expect, it } from 'vitest';
import { billableChars, flushSentence, speakable, takeSentences, worthSpeaking } from '../src/sentences.ts';

describe('speakable:删掉的是排版记号,不是她的话', () => {
  it('围栏代码块整块不留', () => {
    expect(speakable('看这个\n```js\nconst a = 1;\n```\n就这样')).toBe('看这个 就这样');
  });

  it('行内代码留内容不留反引号', () => {
    expect(speakable('调 `phone_status` 看看')).toBe('调 phone_status 看看');
  });

  it('链接只留文字,裸网址整个删', () => {
    expect(speakable('见 [文档](https://a.b/c)')).toBe('见 文档');
    expect(speakable('去 https://a.b/c/d 看看')).toBe('去 看看');
  });

  it('markdown 记号与列表前缀', () => {
    expect(speakable('**重点**在这里')).toBe('重点在这里');
    expect(speakable('# 标题\n- 第一条\n1. 第二条')).toBe('标题 第一条 第二条');
    expect(speakable('> 引用')).toBe('引用');
  });

  it('emoji 与变体选择符一起删', () => {
    expect(speakable('好耶🎉🎉')).toBe('好耶');
    expect(speakable('爱你❤️')).toBe('爱你');
  });

  it('**不删括号里的内容**:那可能是她的真话,宁可念一句旁白也不吞一句真话', () => {
    expect(speakable('（小声）我在呢')).toBe('（小声）我在呢');
    expect(speakable('(笑了笑) 你继续说')).toBe('(笑了笑) 你继续说');
  });

  it('纯空白变成空串', () => {
    expect(speakable('   \n\n  ')).toBe('');
  });
});

describe('takeSentences:切句', () => {
  it('句末标点断开,尾引号跟着上一句走', () => {
    const { sentences, rest } = takeSentences('我说「好的。」然后呢', 200);
    expect(sentences).toEqual(['我说「好的。」']);
    expect(rest).toBe('然后呢');
  });

  it('逗号不断句', () => {
    const { sentences, rest } = takeSentences('先这样,再那样,然后就好了。接着', 200);
    expect(sentences).toEqual(['先这样,再那样,然后就好了。']);
    expect(rest).toBe('接着');
  });

  it('一次能切出多句', () => {
    const { sentences, rest } = takeSentences('一。二！三？', 200);
    expect(sentences).toEqual(['一。', '二！', '三？']);
    expect(rest).toBe('');
  });

  it('长流水句到上限就在逗号处断,不让她写完整段才出声', () => {
    const long = `${'啊'.repeat(30)}，${'哦'.repeat(30)}，${'嗯'.repeat(30)}`;
    const { sentences, rest } = takeSentences(long, 40);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences[0]!.endsWith('，')).toBe(true);
    expect(rest.length).toBeGreaterThan(0);
  });

  it('没有任何标点且没到上限时,一句都不切', () => {
    const { sentences, rest } = takeSentences('还在写', 200);
    expect(sentences).toEqual([]);
    expect(rest).toBe('还在写');
  });
});

describe('flushSentence 与 worthSpeaking', () => {
  it('一轮收尾时把没标点的尾巴交出来', () => {
    expect(flushSentence('  你好呀  ')).toBe('你好呀');
    expect(flushSentence('   ')).toBeNull();
  });

  it('没有字母数字汉字的东西不值得念', () => {
    expect(worthSpeaking('你好')).toBe(true);
    expect(worthSpeaking('ok')).toBe(true);
    expect(worthSpeaking('123')).toBe(true);
    expect(worthSpeaking('……')).toBe(false);
    expect(worthSpeaking('，。！')).toBe(false);
  });
});

describe('billableChars:与她别处的口径一致', () => {
  it('一个汉字算 2,其余算 1', () => {
    expect(billableChars('你好')).toBe(4);
    expect(billableChars('ab')).toBe(2);
    expect(billableChars('好a')).toBe(3);
  });
});
