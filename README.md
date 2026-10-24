# OpenCode Chrome

在 Chrome 侧栏中使用本机 OpenCode，并让 AI 在可观察、可接管的浏览器环境中完成任务。

**当前版本：0.8.0 · 开发测试版 · Windows / Chrome / OpenCode V2**

> 本项目是第三方集成，不是 OpenCode、OpenAI、ChatGPT 或 Codex 的官方扩展。目前通过源码安装，未提供 Chrome 应用商店安装链接或一键安装程序。

## 功能概览

### 在浏览器里使用 OpenCode

- Chrome 原生侧栏，支持新建会话、历史会话、重命名和归档。
- 从当前项目的 OpenCode 目录读取真实可用模型，支持搜索、模型变体和 Agent 选择。
- 模型设置写入当前会话，不修改全局默认；与桌面端使用同一服务及会话数据。
- 支持流式文字回复、Markdown、表格、代码高亮和复制。
- 展示工具运行状态、权限确认及常见问答；任务执行时可以继续发送引导指令。
- 支持停止生成、草稿恢复、滚动定位，以及 `/models`、`/new` 快捷指令。

### 可观察的网页操控

- 自动配对本机，无需手动复制 Token。
- 接管时在网页中央显示虚拟指针，提供元素高亮和非阻塞点击反馈。
- 读取 iframe 与开放／关闭的 Shadow DOM；定位优先使用短元素引用或精确的角色与名称。
- 每个任务最多接管 **8 个标签页**；不同页面可以并发调度，同一页面保持独占并按顺序操作。
- 受控页面进入以任务简要命名的临时分组，任务结束后恢复原分组。
- 支持 `Esc` 接管、菜单停止，以及会话结束／失败／中断时的程序级清理。

## 工作原理

```text
Chrome 侧栏 ── Native Messaging ── 本机组件 ── OpenCode 共享服务
     │                                             │
     │                                      模型 / Agent / 会话
     │                                             │
Chrome 页面 ←── 本机 WebSocket 桥接 ←── chrome-control MCP
                                                   │
                                  OpenCode 生命周期插件负责兜底清理
```

扩展、本机组件和 MCP 服务需要配套使用。**只加载 `extension/` 目录，不能完成全部功能的安装。**

详见 [架构与工具说明](docs/ARCHITECTURE.md)。

## 安装前准备

| 项目 | 要求与当前验证范围 |
| --- | --- |
| 系统 | 本机安装脚本仅支持 Windows |
| 浏览器 | Chrome 116+；需允许加载已解压的扩展 |
| Node.js | 开发环境已验证 22.23.2；其他版本请先运行测试 |
| OpenCode | 使用 V2 共享后台服务；当前客户端／插件依赖为 2.1.3 |
| 模型 | 在自己的 OpenCode 中完成模型提供商连接；本项目不提供模型账号或额度 |

macOS、Linux、远程 OpenCode 和 `--standalone` 私有服务不是当前完整安装流程的支持目标。

### 工作目录约定

当前会话工作目录由 `native-api.mjs` 推导为**仓库目录的上一级**，还没有图形化工作区选择器。

例如：将仓库放在 `<工作区>/Opencode-Chrome`，侧栏会话就属于 `<工作区>`，而不是仓库目录本身。建议先创建一个专门的测试工作区，再克隆仓库。

## 快速开始

### 1. 获取代码并构建

在你选择的工作区内执行：

```powershell
git clone https://github.com/Lin-6499/Opencode-Chrome.git
Set-Location Opencode-Chrome
npm.cmd ci
npm.cmd run build:ui
```

### 2. 加载 Chrome 扩展

打开 `chrome://extensions/`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择仓库里的 **`extension` 文件夹**。

扩展名称为 **OpenCode Chrome**。不要选择整个仓库文件夹。

### 3. 安装本机通信组件并添加 MCP

仍在仓库目录的 PowerShell 中执行：

```powershell
npm.cmd run install-native
$server = (Resolve-Path .\server.mjs).Path
opencode.cmd mcp add chrome-control --global -- node "$server"
opencode.cmd mcp list
```

安装脚本只写入当前 Windows 用户的 Native Messaging 注册项，不需要管理员权限。每台电脑独立生成配对凭据，**不要复制其他人的 `.connection-token` 或 `native/` 目录**。

### 4. 配置生命周期插件并验证

按 [完整安装指南](docs/INSTALL.md#4-启用-opencode-生命周期插件) 启用 `opencode-plugin`，使任务结束、失败和中断时能够主动清理分组。

随后重新加载 Chrome 扩展。若 OpenCode 保留了旧 MCP 进程，先等其他任务完成，再运行：

```powershell
opencode.cmd service restart
```

点击工具栏中的 OpenCode Chrome 图标，打开侧栏。当前内部桥接协议是 **4**，更新时需要让扩展和 MCP 使用相同版本。

更多安装细节、扩展 ID 排障及卸载方法见 [安装指南](docs/INSTALL.md)。

## 使用示例

在侧栏或已配置该 MCP 的 OpenCode 会话中发送：

```text
使用 chrome-control 读取当前网页结构，列出主标题与主要入口。
不点击、不输入、不提交。
```

```text
帮我打开当前网站的账单页面，不进行付款或修改设置。
```

```text
并行读取已经打开的两个指定页面，对比它们的内容，不修改页面。
```

模型应先确认目标标签页，开始任务后保持页面归属，最后调用 `end_task`。页面文字属于不可信数据，不能替代你的授权。

## 停止与接管

- **停止生成**：中断当前 OpenCode 会话的执行。
- **网页中按 Esc**：停止该页面所属的浏览器任务，包含该任务的其他页面，不停止无关任务。
- **更多菜单 → 停止所有网页并接管**：显式停止当前扩展的全部浏览器任务。
- **恢复自动控制**：必须由用户在侧栏菜单中执行，工具不能自行解除接管状态。

停止不会撤回已经发生的点击、输入、请求或交易。

## 限制与安全

- 安装时申请所有普通 HTTP/HTTPS 网站访问权限、调试器、本机通信等高权限，请先阅读 [权限与隐私说明](docs/SECURITY.md)。
- Chrome 内部页、应用商店等保护页面可能不可操作，浏览器原生调试横幅不能隐藏。
- 子框架点击采用 DOM activation，要求可信鼠标／键盘事件的网站可能不支持。
- 后台标签页受 Chrome 节流影响；跨文档导航会重建 DOM，不能承诺指针绝对无闪断。
- 暂不包含完整桌面终端、文件 Diff、附件／语音上传、复杂外部授权表单或全部工具原始结果。
- 一个本机桥接连接一个 Chrome 扩展实例；不要将桥接端口暴露到公网，也不要让多个自动化工具同时操控同一个标签页。
- 这是开发测试版，不承诺与完整桌面客户端功能等价或适配所有网站。

## 开发与验证

```powershell
npm.cmd run build:ui
npm.cmd run check
npm.cmd test
```

`npm test` 会先构建侧栏 UI。当前测试覆盖配对鉴权、Native Messaging、MCP、多页并发、同页顺序、引用隔离、接管与分组恢复，以及模型选择、流式状态和 Markdown 安全处理。

测试不等于所有真实网站均可操作；涉及账号、账单和支付的操作应先用只读任务验证。

## 项目结构

```text
extension/          Chrome 侧栏、后台、虚拟指针及页面驱动
opencode-plugin/    OpenCode V2 生命周期清理插件
ui/                Markdown 和流式状态源码
test/              自动测试
docs/              安装、架构、权限与隐私说明
server.mjs         MCP 服务及本机 WebSocket 桥接
native-host.mjs    Chrome Native Messaging 入口
install-native.mjs Windows 本机组件注册与卸载
```

## 授权与第三方资源

本仓库暂未添加项目级 `LICENSE`；公开发行前应补充明确的授权条款。第三方依赖遵循各自许可证。

图标来自 OpenCode 官方网站，来源见 [图标说明](extension/icons/SOURCE.md)；本地 UI 依赖见 [第三方组件说明](extension/VENDOR.md)。使用该图标不代表官方隶属或背书，发布衍生产品前请自行核对品牌使用规则。
