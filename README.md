# Obsidian IMA Sync Plugin

将 IMA 知识库 / 笔记本 / 分享链接的笔记同步到 Obsidian，支持手动选择导入。

<!-- 可在此处添加效果图 -->
<!-- ![preview](docs/preview.png) -->

## 功能一览

| 功能 | 说明 |
|------|------|
| 知识库同步 | 选择知识库 → 浏览笔记列表 → 手动勾选要导入的 → 同步 |
| 笔记本同步 | 同步个人笔记本中的笔记，手动勾选导入 |
| 分享链接导入 | 粘贴 IMA 分享链接，一键导入单篇笔记 |
| 递归遍历 | 自动深入知识库子文件夹，发现所有嵌套笔记 |
| 路径提示 | 同步完成后通知显示保存位置，快速定位文件 |

## 安装

### 1. 下载插件文件

从 [Releases](https://github.com/b2544603518-netizen/obsidian-ima-plugin/releases) 页面下载以下两个文件：

- `main.js`
- `manifest.json`

> 如果还没有 Release，可直接从仓库主页下载这两个文件。

### 2. 放入 Obsidian 插件目录

在你的 Obsidian 仓库（vault）中找到插件目录，创建 `obsidian-ima-plugin` 文件夹：

```
你的Vault/
  └─ .obsidian/
       └─ plugins/
            └─ obsidian-ima-plugin/   ← 把 main.js 和 manifest.json 放这里
                 ├─ main.js
                 └─ manifest.json
```

### 3. 启用插件

1. 重启 Obsidian（或重新加载）
2. 打开 **设置 → 第三方插件**，找到「IMA Sync」并启用
3. 如果提示安全限制，点击「关闭安全模式」后再启用

## 配置凭证

插件需要 IMA OpenAPI 凭证才能工作：

1. 打开 **设置 → IMA Sync**
2. 在 **API Key** 中填入你的密钥

> **如何获取凭证？** 访问 [IMA Agent 接口页](https://ima.qq.com/agent-interface) 申请 OpenAPI 权限，获取 Client ID 和 API Key。

<!-- 可在此处添加设置页截图 -->
<!-- ![settings](docs/settings.png) -->

## 使用方法

### 知识库同步（推荐）

这是最常用的功能，可以浏览知识库中的笔记并选择性导入：

1. 点击左侧边栏的 **同步图标** 🔄，或按 `Ctrl+P` 搜索命令「选择知识库同步」
2. **第一步 - 选择知识库**：勾选要加载的知识库，点击「加载笔记」

   <!-- ![step1](docs/step1-select-kb.png) -->

3. **第二步 - 选择笔记**：浏览该知识库下的所有笔记，勾选要导入的（默认未选中），点击「同步选中」

   <!-- ![step2](docs/step2-select-notes.png) -->

4. 同步完成后，右下角通知会显示 **保存位置**（如 `IMA知识库/知识库名/`），方便你快速找到导入的文件

### 笔记本同步

1. 按 `Ctrl+P` 搜索命令「同步笔记本笔记」
2. 勾选要导入的笔记 → 点击「同步选中」

### 分享链接导入

1. 按 `Ctrl+P` 搜索命令「同步分享链接笔记」
2. 粘贴 IMA 分享链接（如 `https://ima.qq.com/note/share/xxxxx`）
3. 点击「同步」

### 修改保存目录

默认保存到 `IMA知识库/` 目录，可在 **设置 → IMA Sync → 目标文件夹** 中修改。

## 注意事项

- 需要先在 [IMA Agent 接口页](https://ima.qq.com/agent-interface) 申请 OpenAPI 凭证
- 知识库笔记需要相应读取权限，无权限的笔记会被跳过
- 同步不会删除已有文件，重复同步会覆盖同名文件

## 开发

```bash
npm install
npm run dev    # 开发模式
npm run build  # 构建
```

## License

MIT
