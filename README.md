# Obsidian IMA Plugin

IMA 知识库同步插件 - 将 IMA 知识库笔记同步到 Obsidian

## 功能

- 🔄 同步知识库笔记到 Obsidian
- 📁 支持选择文件夹保存
- 🎯 支持选择知识库同步
- ⚡ 使用 Obsidian Local REST API 读取笔记内容
- 🔐 支持 IMA OpenAPI 认证

## 安装

### 手动安装

1. 下载最新版本
2. 解压到 Obsidian 插件目录：
   - Windows: `D:\bbc\Documents\bbc\.obsidian\plugins\obsidian-ima-plugin\`
   - macOS: `~/Library/Application Support/obsidian/obsidian-ima-plugin/`
3. 重启 Obsidian
4. 在插件设置中配置：
   - **Client ID**: 从 https://ima.qq.com/agent-interface 获取
   - **API Key**: 从 https://ima.qq.com/agent-interface 获取

## 使用方法

### 同步笔记本

点击插件设置中的「同步笔记本」按钮，可以同步你自己的笔记本笔记。

### 同步知识库

1. 点击「选择知识库」
2. 勾选要同步的知识库
3. 点击「开始同步」

### 同步分享链接

如果有分享链接的笔记，点击「同步分享链接」输入链接即可。

## 注意事项

⚠️ **权限说明**：
- 笔记 API (`get_doc_content`) 需要**笔记作者**权限
- 知识库导出 API 需要知识库管理员权限
- 如果遇到"GetNoteContent not author"错误，说明当前账号不是笔记作者

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 构建生产版本
npm run build
```

## 技术栈

- TypeScript
- Obsidian API
- esbuild

## License

MIT
