import { resolve } from 'node:path';
import type { WorldDefinition } from 'cortico/world.ts';
import { PHONE_DEFAULTS, type PhoneConfigSection } from './config.ts';
import { PhoneWorld } from './world.ts';

export const PHONE: WorldDefinition<PhoneConfigSection> = {
  id: 'phone',
  label: '电话',
  defaults: () => ({ ...PHONE_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.phone` 的活引用:热改的键现读即生效。
  create: (ctx) =>
    new PhoneWorld({
      cfg: ctx.cfg,
      timezone: ctx.timezone,
      // 通话音频与诊断落盘都放这儿;`logAudio` 默认关，所以平时不会用上。
      dataDir: resolve(ctx.dataDir),
      secret: (name) => ctx.secret(name),
    }),
};
