import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { ImaPlugin } from '../main';
import { FolderSelectModal, KnowledgeBaseModal, NotebookNotesModal, ShareNoteModal } from './modals';

export class ImaSettingTab extends PluginSettingTab {
  plugin: ImaPlugin;

  constructor(app: App, plugin: ImaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'IMA 同步设置' });

    // ===== 基础配置 =====
    containerEl.createEl('h3', { text: '基础配置' });

    new Setting(containerEl)
      .setName('Client ID')
      .setDesc('已自动配置')
      .addText(text => text.setValue(this.plugin.settings.clientId).setDisabled(true));

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('从 https://ima.qq.com/agent-interface 获取(过期后需重新获取)')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setValue(this.plugin.settings.apiKey);
        text.onChange(async value => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        });
      })
      .addButton(btn => {
        btn.setButtonText('测试连接').onClick(() => {
          this.plugin.testApiConnection();
        });
      });

    new Setting(containerEl)
      .setName('目标文件夹')
      .setDesc(`当前: ${this.plugin.settings.targetFolder || '(根目录)'}`)
      .addButton(btn => {
        btn.setButtonText('选择文件夹').onClick(() => {
          new FolderSelectModal(this.app, this.plugin, this).open();
        });
      });

    // ===== 同步操作 =====
    containerEl.createEl('h3', { text: '同步操作' });

    new Setting(containerEl)
      .setName('增量同步知识库')
      .setDesc('只同步本地没有的新笔记(推荐日常使用,大幅减少 API 调用)')
      .addButton(btn => {
        btn.setButtonText('增量同步').setCta().onClick(() => {
          this.plugin.startKnowledgeBaseSync(null, 'incremental');
        });
      });

    new Setting(containerEl)
      .setName('全量同步知识库')
      .setDesc('重新拉取所有已选知识库的全部笔记(刷新本地缓存)')
      .addButton(btn => {
        btn.setButtonText('全量同步').onClick(() => {
          this.plugin.startKnowledgeBaseSync(null, 'full');
        });
      });

    new Setting(containerEl)
      .setName('选择知识库')
      .setDesc('选择要同步的知识库(支持多选)')
      .addButton(btn => {
        btn.setButtonText('选择知识库').onClick(() => {
          this.plugin.openKnowledgeBaseModal();
        });
      });

    if (this.plugin.settings.selectedKbs.length > 0) {
      containerEl.createEl('p', {
        text: `已选择 ${this.plugin.settings.selectedKbs.length} 个知识库`,
        cls: 'setting-item-description',
      });
    }

    new Setting(containerEl)
      .setName('同步笔记本')
      .setDesc('同步你自己的笔记本笔记')
      .addButton(btn => {
        btn.setButtonText('同步笔记本').onClick(() => {
          this.plugin.openNotebookNotesModal();
        });
      });

    new Setting(containerEl)
      .setName('同步分享链接')
      .setDesc('输入分享链接,单个同步')
      .addButton(btn => {
        btn.setButtonText('输入链接').onClick(() => {
          new ShareNoteModal(this.app, this.plugin).open();
        });
      });

    // ===== 高级配置 =====
    containerEl.createEl('h3', { text: '高级配置(减少 API 调用)' });

    new Setting(containerEl)
      .setName('缓存有效期(分钟)')
      .setDesc('知识库列表/笔记本列表的缓存时长,过期后自动重新拉取')
      .addText(text => {
        text.inputEl.type = 'number';
        text.setValue(String(this.plugin.settings.cacheTtlMinutes));
        text.onChange(async value => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n >= 1) {
            this.plugin.settings.cacheTtlMinutes = n;
            this.plugin.cache.setDefaultTtl(n);
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName('API 速率限制 (QPS)')
      .setDesc('每秒最多发起的 API 请求数,建议保持 2,避免触发限流')
      .addText(text => {
        text.inputEl.type = 'number';
        text.setValue(String(this.plugin.settings.qpsLimit));
        text.onChange(async value => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n >= 1 && n <= 10) {
            this.plugin.settings.qpsLimit = n;
            this.plugin.api.configure({ qpsLimit: n });
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName('最大重试次数')
      .setDesc('请求失败/被限流时的重试次数(指数退避)')
      .addText(text => {
        text.inputEl.type = 'number';
        text.setValue(String(this.plugin.settings.maxRetries));
        text.onChange(async value => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n >= 0 && n <= 10) {
            this.plugin.settings.maxRetries = n;
            this.plugin.api.configure({ maxRetries: n });
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName('请求超时(毫秒)')
      .setDesc('单个 API 请求的超时时间,超时后自动重试')
      .addText(text => {
        text.inputEl.type = 'number';
        text.setValue(String(this.plugin.settings.requestTimeoutMs));
        text.onChange(async value => {
          const n = parseInt(value, 10);
          if (!isNaN(n) && n >= 5000) {
            this.plugin.settings.requestTimeoutMs = n;
            this.plugin.api.configure({ requestTimeoutMs: n });
            await this.plugin.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName('自动增量同步')
      .setDesc('启动 Obsidian 时自动执行一次增量同步(仅同步新笔记)')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.autoSync);
        toggle.onChange(async value => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        });
      });

    if (this.plugin.settings.autoSync) {
      new Setting(containerEl)
        .setName('自动同步间隔(分钟)')
        .setDesc('0 表示只在启动时同步一次;>0 表示每隔指定分钟自动增量同步')
        .addText(text => {
          text.inputEl.type = 'number';
          text.setValue(String(this.plugin.settings.syncIntervalMinutes));
          text.onChange(async value => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.syncIntervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.rescheduleAutoSync();
            }
          });
        });
    }

    // ===== 缓存管理 =====
    containerEl.createEl('h3', { text: '缓存管理' });

    const stats = this.plugin.cache.getStats();
    new Setting(containerEl)
      .setName('缓存状态')
      .setDesc(
        stats.totalEntries > 0
          ? `当前缓存 ${stats.totalEntries} 项,最早一项 ${Math.round(stats.oldestAge / 60000)} 分钟前生成`
          : '当前无缓存'
      )
      .addButton(btn => {
        btn.setButtonText('清除全部缓存').onClick(async () => {
          this.plugin.cache.clearAll();
          await this.plugin.saveSettings();
          new Notice('缓存已清除');
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('清除知识库列表缓存')
      .setDesc('下次打开"选择知识库"时将重新拉取')
      .addButton(btn => {
        btn.setButtonText('清除').onClick(async () => {
          this.plugin.cache.clearKnowledgeBases();
          await this.plugin.saveSettings();
          new Notice('知识库列表缓存已清除');
        });
      });

    new Setting(containerEl)
      .setName('清除笔记本列表缓存')
      .setDesc('下次打开"同步笔记本"时将重新拉取')
      .addButton(btn => {
        btn.setButtonText('清除').onClick(async () => {
          this.plugin.cache.clearNotebooks();
          await this.plugin.saveSettings();
          new Notice('笔记本列表缓存已清除');
        });
      });

    // ===== 状态信息 =====
    containerEl.createEl('h3', { text: '状态信息' });

    if (this.plugin.settings.lastSyncTime) {
      containerEl.createEl('p', {
        text: `上次同步时间: ${new Date(this.plugin.settings.lastSyncTime).toLocaleString('zh-CN')}`,
        cls: 'setting-item-description',
      });
    } else {
      containerEl.createEl('p', {
        text: '尚未进行过同步',
        cls: 'setting-item-description',
      });
    }

    if (this.plugin.syncManager.isRunning()) {
      containerEl.createEl('p', {
        text: '同步任务进行中...',
        cls: 'setting-item-description',
      });
    }
  }
}
