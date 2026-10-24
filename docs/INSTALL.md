# 安装、升级与排障

本指南适用于 Windows 源码安装。请先安装并打开 OpenCode V2，连接自己的模型提供商，并准备 Node.js、npm 和 Chrome。

## 1. 选择工作区并克隆

会话工作目录目前是仓库的上一级。建议将仓库作为一个专用工作区的子目录：

```text
<你选择的工作区>/
└─ Opencode-Chrome/
   ├─ extension/
   ├─ native-host.mjs
   └─ server.mjs
```

克隆后，在仓库目录运行：

```powershell
npm.cmd ci
npm.cmd run build:ui
```

后续不要随意移动仓库：本机注册、MCP 和生命周期插件都需要能找到这里的文件。移动后应更新这些引用。

## 2. 加载扩展并注册本机通信

1. 在 Chrome 打开 `chrome://extensions/`。
2. 开启开发者模式，加载仓库下的 `extension/`。
3. 确认出现 **OpenCode Chrome**。
4. 返回仓库目录运行：

```powershell
npm.cmd run install-native
```

安装器会按当前扩展目录匹配 Chrome 配置中的扩展 ID，然后生成本机启动器和 Native Messaging manifest，并将其注册到当前用户的 Windows 注册表。

本机生成的 `native/` 不应提交到 Git，也不能直接复制给另一台电脑。

如果自动识别失败，可从扩展管理页复制 ID，再执行：

```powershell
node .\install-native.mjs --extension-id <扩展ID>
```

不要把别人的扩展 ID 写进配置。当前脚本面向开发者加载模式，未来商店发行版需要采用实际商店 ID。

## 3. 注册 MCP

在仓库目录运行：

```powershell
$server = (Resolve-Path .\server.mjs).Path
opencode.cmd mcp add chrome-control --global -- node "$server"
opencode.cmd mcp list
```

`--global` 让本机用户的其他 OpenCode 项目也能调用工具，但侧栏会话仍受当前工作区约定限制。

首次启动 MCP 后会自动生成 `.connection-token`。这属于本机凭据，无需手动发给扩展，也不要发送到聊天或上传仓库。

## 4. 启用 OpenCode 生命周期插件

该插件让 OpenCode 执行完成、失败、中断或会话删除时，主动请求清理对应浏览器任务。没有它仍可手动 `end_task`，但清理可靠性会降低。

推荐使用 OpenCode 的全局自动加载目录。**以下示例用于首次安装**，会拒绝覆盖已有入口：

```powershell
$plugin = (Resolve-Path .\opencode-plugin\index.mjs).Path
$pluginUrl = ([System.Uri]::new($plugin)).AbsoluteUri
$entryDir = Join-Path $env:USERPROFILE '.config\opencode\plugins\chrome-control-lifecycle'
$entry = Join-Path $entryDir 'index.ts'

if (Test-Path -LiteralPath $entry) {
    throw '生命周期入口已存在，请检查其中的引用，不要重复安装或直接覆盖。'
}

New-Item -ItemType Directory -Path $entryDir -Force | Out-Null
$content = "import plugin from `"$pluginUrl`"`n`nexport default plugin`n"
[System.IO.File]::WriteAllText($entry, $content, [System.Text.UTF8Encoding]::new($false))
```

如果设置了自定义 `XDG_CONFIG_HOME`，请将入口放到相应配置目录，而不是默认用户目录。

也可以通过 V2 `opencode.jsonc` 的 `plugins` 列表加载本仓库的 `opencode-plugin` 目录。两种方式选一种，不要重复加载同一插件；保留所有已有认证、模型与其他插件配置。

安装或更新后，先等正在运行的任务结束，再重启共享服务：

```powershell
opencode.cmd service restart
```

可在 OpenCode 的插件界面确认 `local.chrome-control.lifecycle` 为 active。插件与客户端依赖当前固定为 2.1.3，其他 OpenCode 版本需要验证兼容性。

## 5. 验证

1. 在 Chrome 扩展管理页重新加载 OpenCode Chrome。
2. 打开一个不含敏感信息的普通网页，点击扩展图标。
3. 检查侧栏的模型列表及本机连接状态。
4. 发送只读任务，例如：

```text
使用 chrome-control 读取当前网页主标题，不点击、不输入、不提交。
```

正常情况下，页面会临时分组并显示指针，任务完成后解除临时分组。如果原来属于用户分组，会尝试恢复原分组。

先不要用付款、账号修改、删除资源或生产后台操作做安装验证。

## 常见问题

### PowerShell 禁止运行脚本

Windows 的 npm shim 可能优先匹配 `.ps1`。本指南使用 `npm.cmd`、`opencode.cmd`，通常无需放宽整机执行策略。

### 找不到本机组件 / Native host forbidden

- 确认扩展目录已经加载，再运行 `install-native`。
- 检查是否使用了另一 Chrome 用户配置或扩展 ID。
- 重新运行安装器，或通过 `--extension-id` 指定实际 ID。
- 安装器检测到另一安装目录拥有同名注册项时会拒绝覆盖；应先确认旧安装，再按旧安装的卸载流程处理。

### 显示未发现 OpenCode 服务

打开本机 OpenCode，检查 `opencode.cmd service status`。当前使用官方共享服务发现机制，不直接接入任意远程地址或 standalone 服务，也不应把服务认证文件复制到扩展中。

### `EADDRINUSE`、协议版本过旧或 MCP 连接失败

端口默认是 `127.0.0.1:17891`，多个 MCP 实例可以认证后复用桥接。当前协议为 4，旧进程不会因修改源码而自动升级。

等其他任务结束后重启 OpenCode 共享服务，并重新加载扩展。不要为排障结束所有 Node 或 Chrome 进程，也不要把端口改为公网监听。

### 为什么侧栏没有其他项目的历史？

当前会话范围是仓库上一级目录，不是 OpenCode 账户的全部项目。模型目录也是项目相关的。跨项目选择器尚未实现，不能通过修改请求参数绕过目录检查。

### 为什么无法控制某些页面？

`chrome://`、商店等浏览器保护页面不受支持。iframe 的沙箱／权限、页面动画、Canvas 或要求可信输入事件的网站也可能限制操作。工具应报告失败或不可访问，不能盲目重复点击。

### Chrome 显示“已开始调试此浏览器”

这是调试器 API 的原生提示，不能隐藏。请避免 DevTools、Playwright 或其他扩展同时调试同一个目标页。

## 升级

先结束浏览器任务并备份自己的未提交改动，再更新源码与依赖、重新构建 UI。随后重启 MCP 并重新加载扩展。正常更新不需要复制或重新生成 Token。

## 卸载

1. 结束浏览器任务，从 Chrome 移除 OpenCode Chrome。
2. 在原仓库目录运行 `npm.cmd run uninstall-native`。
3. 只移除 OpenCode 配置中名为 `chrome-control` 的 MCP 条目，保留其他设置。
4. 检查后删除本工具的生命周期加载入口；如果通过 `plugins` 配置加载，只移除对应条目。
5. 确认不再使用后，再自行删除仓库和本机生成凭据。

卸载本工具不应删除 OpenCode、Node.js、其他插件、模型凭据或用户会话记录。
