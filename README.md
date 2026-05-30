# Obsidian IMA Plugin

IMA 知识库同步插件 - 将 IMA 知识库笔记一键同步到 Obsidian

## 功能

- 同步知识库笔记到 Obsidian，支持按知识库分组保存
- 两步选择交互：先选知识库 → 再手动勾选要导入的笔记 → 同步选中
- 递归遍历知识库文件夹，自动发现所有嵌套笔记
- 同步个人笔记本笔记
- 通过分享链接导入单篇笔记
- 同步完成后显示保存路径，方便快速定位

## 安装

### 手动安装

1. 下载 `main.js`、`manifest.json`
2. 放入 Obsidian vault 的插件目录：`<vault>/.obsidian/plugins/obsidian-ima-plugin/`
3. 重启 Obsidian，在设置中启用插件
4. 在插件设置中配置 IMA OpenAPI 凭证（从 https://ima.qq.com/agent-interface 获取）

## 使用方法

### 同步知识库

1. 点击侧栏同步图标，或使用命令面板搜索「选择知识库同步」
2. 勾选要加载的知识库 → 点击「加载笔记」
3. 浏览笔记列表，手动勾选要导入的笔记（默认未选中）→ 点击「同步选中」
4. 同步完成后通知会显示保存位置

### 同步笔记本

使用命令面板搜索「同步笔记本笔记」，勾选要同步的笔记后导入。

### 同步分享链接

使用命令面板搜索「同步分享链接笔记」，粘贴 IMA 分享链接即可导入。

## 注意事项

- IMA OpenAPI 需要先在 https://ima.qq.com/agent-interface 申请凭证
- 知识库笔记需要相应权限才能读取
- 默认保存目录为 `IMA知识库/`，可在设置中修改

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 构建生产版本
npm run build
```

## License

MIT
