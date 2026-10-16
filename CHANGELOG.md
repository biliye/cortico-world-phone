# 更新日志

市场按版本显示这里的 `## <版本号>` 一段。

## 0.4.0

- **要求 Cortico 0.2.0 及以上**：扩展契约从 world 5 升到 world 6（`cortico.api: 6`）。Cortico 0.1.x 不认识
  这个版本号，装载时直接拒绝；0.2.0 及以上照常。
- **功能与行为一个字没改**，这一版只做契约适配：`console()` → `webUi()`、面板产物改成 `dist/webui.*`，
  并按 0.2.0 新加的要求补上自描述 `describe`（六个工具与七种事件，`describe.json` 随包发布）。
- 验证：`tsc --noEmit`、195 条测试、`pnpm check:extension`（在 Cortico 0.2.0 下）全过。
