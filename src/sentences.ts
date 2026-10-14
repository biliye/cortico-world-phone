/**
 * 把她的正文变成"能念出来的句子"。
 *
 * 这一段存在的理由:她写的是**给眼睛看**的文本,而电话那头是**耳朵**。
 * 直接把正文丢给合成,`**加粗**`会被念成"星号星号加粗星号星号",代码块会一字一字念完,
 * emoji 会被念成它的名字或者干脆变成一声怪响。
 *
 * 两条纪律:
 * - **只删看得见的东西,不改她的话**。删掉的都是排版记号(代码、链接、markdown 记号、emoji);
 *   正文一个字都不替换、不改写。她想说什么还是什么。
 * - **拿不准就留着**。比如括号里的内容(可能是她的旁白,也可能是真话)一律保留 ——
 *   宁可念一句旁白,也不要把一句真话吞掉。要她别写旁白,是提示词的事,不是这里的事。
 */

/** 句末标点:这些之后可以断开合成。逗号不断——断在逗号上会让每句都太短,停顿反而更怪。 */
const SENTENCE_END = /[。！？!?…；;]+/;
/** 句末标点后面还挂着的收尾引号/括号，跟着上一句一起切走。 */
const TRAILING = /^[」』）)】”"'\]]*/;

/**
 * 去掉不该被念出来的东西。
 *
 * emoji 用 `\p{Extended_Pictographic}` 而不是写一张清单:她的表情包会变,
 * 而"哪些码位是图形符号"这件事 Unicode 已经定义了。
 */
export function speakable(text: string): string {
  const cleaned = text
    // 围栏代码块整块删掉(里面的内容按定义不是给耳朵的)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    // 行内代码只留内容
    .replace(/`([^`]*)`/g, '$1')
    // 链接只留文字；裸 URL 整个删掉(念一串域名没有意义)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    // markdown 记号:强调、标题、引用、列表前缀、分隔线
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/(\*\*|__|~~|\*)/g, '')
    // 单个下划线只在下划线式强调的位置删,不碰 `phone_status` 这种词内下划线 ——
    // 工具名与文件名里全是它,一律删会把"调 phone_status"念成"调 phonestatus"。
    .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '')
    // 表格竖线与制表符
    .replace(/\|/g, ' ')
    .replace(/\t/g, ' ')
    // emoji 与图形符号；变体选择符与零宽连接符跟着一起删
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    // 空白收敛成单空格
    .replace(/\s+/g, ' ');
  return cleaned.trim();
}

export interface SentenceSplit {
  /** 可以立刻合成的整句(已去排版记号，且非空)。 */
  sentences: string[];
  /** 还没凑成整句的尾巴，留在缓冲里。 */
  rest: string;
}

/**
 * 从缓冲区里切出可以念的整句。
 *
 * `maxChars` 是**安全阀**:她偶尔会写一大段没有句号的流水句(或者标点全用逗号),
 * 那就到 maxChars 处找一个逗号断,再不行就硬断 —— 不然这一句要等她写完全段才出声,
 * 电话里就是"她哑了很久然后一口气念完"。
 */
export function takeSentences(buffer: string, maxChars: number): SentenceSplit {
  const sentences: string[] = [];
  let rest = buffer;

  for (;;) {
    const match = SENTENCE_END.exec(rest);
    if (!match) break;
    const cut = match.index + match[0].length;
    const tail = TRAILING.exec(rest.slice(cut))?.[0] ?? '';
    const piece = speakable(rest.slice(0, cut + tail.length));
    if (piece) sentences.push(piece);
    rest = rest.slice(cut + tail.length);
  }

  // 长流水句的安全阀
  while (maxChars > 0 && rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const at = Math.max(window.lastIndexOf('，'), window.lastIndexOf(','), window.lastIndexOf('、'));
    const cut = at > maxChars * 0.4 ? at + 1 : maxChars;
    const piece = speakable(rest.slice(0, cut));
    if (piece) sentences.push(piece);
    rest = rest.slice(cut);
  }

  return { sentences, rest };
}

/** 一轮结束时把剩下的尾巴也交出来(没有句末标点的那半句)。 */
export function flushSentence(buffer: string): string | null {
  const piece = speakable(buffer);
  return piece === '' ? null : piece;
}

/**
 * 一句话的"是不是同一句"指纹(去重用)。
 *
 * 为什么需要:她那一侧出声有**两条路** —— 调 `phone_say`、或者直接写下正文(这一路会念它)。
 * 两条都通,所以她完全可能把同一句既写进正文又塞进工具参数,而不去重他那边就会**听两遍**。
 * 只抹掉空白与句末标点(先过一遍 `speakable`,把 markdown/emoji 那层也归一),
 * **话本身一个字不动**。
 */
export function speechKey(text: string): string {
  return speakable(text).replace(/\s+/g, '').replace(/[。！？!?…；;，,、.]+$/u, '');
}

/**
 * 这段话值不值得合成。
 *
 * 一个字母、数字、汉字都没有的东西(纯标点、纯记号)不值得花钱去念 ——
 * 它在电话那头只会是一声怪响。与 hearing 那条(`hasWords`)同一个判据。
 */
export function worthSpeaking(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * 计费字符数:**一个汉字算 2 个字符**，其余 1 个。这是 MiniMax 账单的口径。
 * 与 pet 包那份一字不差 —— 两边对不上，配额就对不上。
 */
export function billableChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    const wide = /[\u3000-\u303f\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(ch);
    n += wide ? 2 : 1;
  }
  return n;
}
