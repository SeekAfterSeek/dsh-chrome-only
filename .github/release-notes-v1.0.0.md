首个可安装版本 / First installable release.

- `chrome_open` / `chrome_status` / `chrome_install`：只走 chrome.exe，未授权不安装
- `tools.guard()`：拒绝默认浏览器与任何非 Chrome 浏览器启动
- 每轮注入的系统提示规则（含 Chrome 缺失时的授权流程）
- `dsh web` 不再调用系统默认浏览器：`web-runtime.openBrowser=false` + 插件用 Chrome 接管同一个带 token 的地址
- PowerShell 打开脚本、web profile 安装脚本、单元测试、asar 诊断工具

安装 / Install：见 README。
