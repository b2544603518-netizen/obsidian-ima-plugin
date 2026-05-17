import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TFolder, TFile } from 'obsidian';
import { IMAApi } from './api';

interface ImaPluginSettings {
  clientId: string;
  apiKey: string;
  targetFolder: string;
  syncNotesOnly: boolean;
  lastSyncTime: string;
  targetKbs: string[];
}

const DEFAULT_SETTINGS: ImaPluginSettings = {
  clientId: '6da06449731c5c678199f962ec266265',
  apiKey: '',
  targetFolder: 'IMA知识库',
  syncNotesOnly: true,
  lastSyncTime: '',
  targetKbs: []
};

export default class ImaPlugin extends Plugin {
  settings: ImaPluginSettings;
  api: IMAApi;
  statusBarEl: HTMLElement;

  async onload() {
    await this.loadSettings();
    this.api = new IMAApi(this.settings.clientId, this.settings.apiKey);

    this.addCommand({
      id: 'sync-ima',
      name: '同步 IMA 笔记',
      callback: () => this.syncAll()
    });

    this.addCommand({
      id: 'sync-ima-full',
      name: '全量同步 IMA 知识库',
      callback: () => this.syncAll(true)
    });

    this.addRibbonIcon('sync', 'IMA 同步', () => {
      this.syncAll();
    });

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText('IMA');
    this.statusBarEl.classList.add('mod-clickable');
    this.statusBarEl.onClick(() => {
      this.syncAll();
    });

    this.addSettingTab(new ImaSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.api = new IMAApi(this.settings.clientId, this.settings.apiKey);
  }

  async syncAll(fullSync = false) {
    if (!this.settings.apiKey) {
      new Notice('请先在设置中配置 IMA API Key');
      return;
    }

    new Notice(fullSync ? '开始全量同步...' : '开始增量同步...');
    this.statusBarEl.setText('IMA: 同步中...');

    try {
      const knowledgeBases = await this.api.searchKnowledgeBase();

      if (!knowledgeBases || knowledgeBases.length === 0) {
        new Notice('未找到知识库');
        this.statusBarEl.setText('IMA: 无知识库');
        return;
      }

      const targetKbs = this.settings.targetKbs.length > 0
        ? knowledgeBases.filter(kb => this.settings.targetKbs.includes(kb.kb_id))
        : knowledgeBases.filter(kb => kb.role_type !== '普通成员');

      let syncedCount = 0;
      let totalItems = 0;

      for (const kb of targetKbs) {
        new Notice('正在同步: ' + kb.kb_name);
        this.statusBarEl.setText('IMA: 同步 ' + kb.kb_name + '...');

        const items = await this.api.getKnowledgeList(kb.kb_id);
        if (!items) continue;

        const filteredItems = this.settings.syncNotesOnly
          ? items.filter(item => item.media_type === 11)
          : items.filter(item => item.media_type !== 99 && item.media_type !== 0);

        totalItems += filteredItems.length;

        for (const item of filteredItems) {
          if (!fullSync && this.settings.lastSyncTime) {
            const itemTime = new Date(item.update_time || 0);
            const lastSync = new Date(this.settings.lastSyncTime);
            if (itemTime <= lastSync) continue;
          }

          try {
            const content = await this.api.exportMedia(item.media_id);
            if (content) {
              const sanitizedTitle = item.title.replace(/[\/\\:*?"<>|]/g, '_');
              const filePath = this.settings.targetFolder + '/' + kb.kb_name + '/' + sanitizedTitle + '.md';
              const frontMatter = this.generateFrontMatter(kb, item);
              const fullContent = frontMatter + content;

              await this.saveFile(filePath, fullContent);
              syncedCount++;
            }
          } catch (err) {
            console.error('Failed to sync ' + item.title + ':', err);
          }

          this.statusBarEl.setText('IMA: ' + syncedCount + '/' + totalItems);
        }
      }

      this.settings.lastSyncTime = new Date().toISOString();
      await this.saveSettings();

      new Notice('同步完成！共同步 ' + syncedCount + ' 个文件');
      this.statusBarEl.setText('IMA: ' + syncedCount + ' 个文件');
    } catch (err) {
      console.error('Sync failed:', err);
      new Notice('同步失败: ' + (err as Error).message);
      this.statusBarEl.setText('IMA: 同步失败');
    }
  }

  generateFrontMatter(kb: any, item: any): string {
    const lines = [
      '---',
      'source: IMA知识库',
      'kb_name: \"' + kb.kb_name + '\"',
      'kb_id: \"' + kb.kb_id + '\"',
      'title: \"' + item.title + '\"',
      'media_type: ' + item.media_type,
      'media_id: \"' + item.media_id + '\"',
      'sync_time: \"' + new Date().toISOString() + '\"',
      '---',
      ''
    ];
    return lines.join('\n');
  }

  async saveFile(path: string, content: string) {
    const normalizedPath = path.replace(/[/\\\\]+/g, '/');

    const folders = normalizedPath.split('/').slice(0, -1);
    let currentPath = '';

    for (const folder of folders) {
      currentPath += folder + '/';
      const folderPath = currentPath.slice(0, -1);
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }
    }

    const existingFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, content);
    } else {
      await this.app.vault.create(normalizedPath, content);
    }
  }
}

class ImaSettingTab extends PluginSettingTab {
  plugin: ImaPlugin;

  constructor(app: App, plugin: ImaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'IMA 知识库同步设置' });

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('IMA API Client ID')
      .addText(text => text
        .setValue(this.plugin.settings.clientId)
        .onChange(async (value) => {
          this.plugin.settings.clientId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('IMA API Key')
      .addText(text => text
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        })
        .inputEl.type = 'password');

    new Setting(containerEl)
      .setName('同步文件夹')
      .setDesc('笔记保存的根文件夹')
      .addText(text => text
        .setValue(this.plugin.settings.targetFolder)
        .onChange(async (value) => {
          this.plugin.settings.targetFolder = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('仅同步笔记')
      .setDesc('只同步笔记类型（media_type=11）')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.syncNotesOnly)
        .onChange(async (value) => {
          this.plugin.settings.syncNotesOnly = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('全量同步')
      .setDesc('忽略增量标记，同步所有内容')
      .addButton(button => button
        .setButtonText('执行全量同步')
        .setCta()
        .onClick(() => {
          this.plugin.syncAll(true);
        }));

    new Setting(containerEl)
      .setName('知识库列表')
      .setDesc('留空则同步所有可访问的知识库')
      .addButton(button => button
        .setButtonText('获取知识库列表')
        .onClick(async () => {
          try {
            const kbs = await this.plugin.api.searchKnowledgeBase();
            if (kbs && kbs.length > 0) {
              const kbList = kbs.map(kb =>
                kb.kb_name + ' (' + kb.role_type + ') - ID: ' + kb.kb_id
              ).join('\n');
              const modal = new Modal(this.app);
              modal.contentEl.createEl('p', { text: '找到 ' + kbs.length + ' 个知识库：' });
              const pre = modal.contentEl.createEl('pre');
              pre.setText(kbList);
              modal.open();
              new Notice('找到 ' + kbs.length + ' 个知识库');
            } else {
              new Notice('未找到知识库');
            }
          } catch (err) {
            new Notice('获取失败: ' + (err as Error).message);
          }
        }));

    if (this.plugin.settings.lastSyncTime) {
      new Setting(containerEl)
        .setName('上次同步时间')
        .setDesc(new Date(this.plugin.settings.lastSyncTime).toLocaleString());
    }
  }
}
