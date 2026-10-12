/** 包入口:默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { PHONE } from './definition.ts';

export default PHONE;
export { PHONE };
export type { PhoneConfigSection } from './config.ts';
export { PhoneWorld } from './world.ts';
export type { PhoneWorldOptions } from './world.ts';
