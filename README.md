# IMA Obsidian Plugin

将 IMA 知识库同步到 Obsidian 的插件。

## 功能

- 同步 IMA 知识库中的笔记到 Obsidian
- 支持增量同步和全量同步
- 自动创建知识库文件夹结构
- 支持选择特定知识库进行同步
- 状态栏显示同步进度

## 安装

1. 从 [Releases](https://github.com/b2544603518-netizen/obsidian-ima-plugin/releases) 下载最新版本
2. 解压到 Obsidian vault 的 .obsidian/plugins/obsidian-ima-plugin/ 目录
3. 在 Obsidian 设置中启用插件
4. 配置 IMA API Key

## 使用方法

- **命令面板**: 
  - 同步 IMA 笔记 - 增量同步
  - 全量同步 IMA 知识库 - 全量同步
- **状态栏**: 点击 IMA 图标快速同步
- **侧边栏**: 点击同步图标

## 设置

- **Client ID**: IMA API Client ID
- **API Key**: IMA API Key（必填）
- **同步文件夹**: 笔记保存的根文件夹
- **仅同步笔记**: 只同步笔记类型（media_type=11）

## 开发

`ash
npm install
npm run build
npm run dev  # 开发模式，自动监听变化
`

## 许可证

MIT
