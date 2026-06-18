import { Plugin, Notice } from 'obsidian';
import { ImaApi } from './api/ima-api';
import { CacheManager } from './core/cache';
import { SyncManager } from './core/sync-manager';
import { ImaSettingTab } from './ui/settings';
import {
  KnowledgeBaseModal,
  NotebookNotesModal,
  ShareNoteModal,
} from './ui/modals';
import { SyncProgressModal } from './ui/sync-progress-modal';
import { diagnoseApiConnection } from './utils/api-diagnostic';
import { PluginSettings, SyncMode, SyncProgress, SyncResult } from './types';

const DEFAULT_SETTINGS: PluginSettings = {
  clientId: '',
  apiKey: '',
  targetFolder: 'IMA知识库',
  lastSyncTime: '',
  selectedKbs: [],
  selectedNotes: {},
  cacheTtlMinutes: 30,
  qpsLimit: 2,
  enableIncrementalSync: true,
  syncIntervalMinutes: 0,
  autoSync: false,
  maxRetries: 3,
  requestTimeoutMs: 30000,
};

const DEBUG = true;
function log(...args: any[]) {
  if (DEBUG) console.log('[IMA]', ...args);
}

export default class ImaPlugin extends Plugin {
  settings!: PluginSettings;
  api!: ImaApi;
  cache!: CacheManager;
  syncManager!: SyncManager;

  private autoSyncTimer: number | null = null;
  private progressModal: SyncProgressModal | null = null;

  async onload() {
    log('插件加载开始');
    await this.loadSettings();

    this.cache = new CacheManager(this.settings.cacheTtlMinutes);
    this.cache.loadFrom((this.settings as any).cache || {});

    this.api = new ImaApi(this.settings.clientId, this.settings.apiKey, this.cache, {
      qpsLimit: this.settings.qpsLimit,
      maxRetries: this.settings.maxRetries,
      requestTimeoutMs: this.settings.requestTimeoutMs,
    });

    this.syncManager = new SyncManager(this.app, this.api, this.cache, this.settings);
    this.syncManager.setProgressCallback((p: SyncProgress) => {
      // 修复:用自定义 opened 标志替代不存在的 Modal.isOpen
      if (this.progressModal && this.progressModal.opened) {
        this.progressModal.update(p);
      }
    });

    // ===== 命令注册 =====
    this.addCommand({
      id: 'sync-ima-incremental',
      name: '增量同步知识库(推荐)',
      callback: () => {
        log('命令触发: 增量同步知识库');
        this.startKnowledgeBaseSync(null, 'incremental');
      },
    });

    this.addCommand({
      id: 'sync-ima-full',
      name: '全量同步知识库',
      callback: () => {
        log('命令触发: 全量同步知识库');
        this.startKnowledgeBaseSync(null, 'full');
      },
    });

    this.addCommand({
      id: 'sync-ima-select',
      name: '选择知识库同步',
      callback: () => {
        log('命令触发: 选择知识库同步');
        this.openKnowledgeBaseModal();
      },
    });

    this.addCommand({
      id: 'sync-ima-share',
      name: '同步分享链接笔记',
      callback: () => {
        log('命令触发: 同步分享链接');
        new ShareNoteModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: 'sync-ima-notebook',
      name: '同步笔记本笔记',
      callback: () => {
        log('命令触发: 同步笔记本笔记');
        this.openNotebookNotesModal();
      },
    });

    this.addCommand({
      id: 'ima-clear-cache',
      name: '清除 API 缓存',
      callback: async () => {
        log('命令触发: 清除缓存');
        this.cache.clearAll();
        await this.saveSettings();
        new Notice('IMA 缓存已清除');
      },
    });

    this.addCommand({
      id: 'ima-cancel-sync',
      name: '取消正在进行的同步',
      callback: () => {
        if (this.syncManager.isRunning()) {
          log('取消同步请求');
          this.syncManager.cancel();
          new Notice('已请求取消同步');
        } else {
          new Notice('当前没有正在进行的同步任务');
        }
      },
    });

    this.addCommand({
      id: 'ima-test-api',
      name: '测试 API 连接(诊断)',
      callback: () => this.testApiConnection(),
    });

    this.addCommand({
      id: 'ima-diagnose',
      name: 'API 完整诊断(详细报告)',
      callback: () => this.runFullDiagnosis(),
    });

    this.addCommand({
      id: 'ima-show-debug-info',
      name: '显示调试信息',
      callback: () => this.showDebugInfo(),
    });

    // Ribbon 按钮
    this.addRibbonIcon('refresh-cw', 'IMA 增量同步', () => {
      log('Ribbon 按钮点击: 增量同步');
      this.startKnowledgeBaseSync(null, 'incremental');
    });

    this.addSettingTab(new ImaSettingTab(this.app, this));

    if (this.settings.autoSync) {
      this.scheduleAutoSync(true);
    }

    log('插件加载完成, 版本=2.0.0, apiKey=', this.settings.apiKey ? '已配置' : '未配置');
  }

  onunload() {
    log('插件卸载');
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (!this.settings.selectedKbs) this.settings.selectedKbs = [];
    if (!this.settings.selectedNotes) this.settings.selectedNotes = {};
    if (!this.settings.targetFolder) this.settings.targetFolder = 'IMA知识库';
    if (typeof this.settings.cacheTtlMinutes !== 'number') this.settings.cacheTtlMinutes = 30;
    if (typeof this.settings.qpsLimit !== 'number') this.settings.qpsLimit = 2;
    if (typeof this.settings.maxRetries !== 'number') this.settings.maxRetries = 3;
    if (typeof this.settings.requestTimeoutMs !== 'number') this.settings.requestTimeoutMs = 30000;
    if (typeof this.settings.syncIntervalMinutes !== 'number') this.settings.syncIntervalMinutes = 0;
    if (typeof this.settings.autoSync !== 'boolean') this.settings.autoSync = false;
  }

  async saveSettings() {
    (this.settings as any).cache = this.cache.export();
    await this.saveData(this.settings);
  }

  rescheduleAutoSync() {
    this.scheduleAutoSync(false);
  }

  private scheduleAutoSync(immediate: boolean) {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (!this.settings.autoSync) return;

    if (immediate) {
      window.setTimeout(() => {
        if (!this.syncManager.isRunning()) {
          this.startKnowledgeBaseSync(null, 'incremental', true);
        }
      }, 5000);
    }

    if (this.settings.syncIntervalMinutes > 0) {
      this.autoSyncTimer = window.setInterval(() => {
        if (!this.syncManager.isRunning()) {
          this.startKnowledgeBaseSync(null, 'incremental', true);
        }
      }, this.settings.syncIntervalMinutes * 60 * 1000);
    }
  }

  // ===== UI 入口 =====

  openKnowledgeBaseModal(): void {
    log('打开知识库选择 Modal, apiKey=', !!this.settings.apiKey, ', clientId=', !!this.settings.clientId);
    if (!this.settings.clientId || !this.settings.apiKey) {
      new Notice('请先在设置中配置 Client ID 和 API Key');
      return;
    }
    try {
      const modal = new KnowledgeBaseModal(this.app, this);
      modal.open();
    } catch (e: any) {
      console.error('[IMA] 打开知识库 Modal 异常:', e);
      new Notice('无法打开窗口: ' + e.message);
    }
  }

  openNotebookNotesModal(): void {
    log('打开笔记本同步 Modal, apiKey=', !!this.settings.apiKey, ', clientId=', !!this.settings.clientId);
    if (!this.settings.clientId || !this.settings.apiKey) {
      new Notice('请先在设置中配置 Client ID 和 API Key');
      return;
    }
    try {
      new NotebookNotesModal(this.app, this).open();
    } catch (e: any) {
      console.error('[IMA] 打开笔记本 Modal 异常:', e);
      new Notice('无法打开窗口: ' + e.message);
    }
  }

  // ===== 同步入口(带完整日志和错误保护) =====

  startKnowledgeBaseSync(selectedKbIds: string[] | null, mode: SyncMode, silent: boolean = false): void {
    log(`startKnowledgeBaseSync 被调用: mode=${mode}, selectedKbIds=${selectedKbIds ? selectedKbIds.length : 'null'}, silent=${silent}`);
    log(`apiKey=${!!this.settings.apiKey}, isRunning=${this.syncManager.isRunning()}`);

    if (!this.settings.clientId || !this.settings.apiKey) {
      new Notice('请先在设置中配置 Client ID 和 API Key');
      return;
    }

    if (this.syncManager.isRunning()) {
      new Notice('已有同步任务正在进行,请等待或取消');
      return;
    }

    try {
      if (!silent) {
        this.progressModal = new SyncProgressModal(this.app, this);
        this.progressModal.open();
        log('进度 Modal 已打开');
      }

      this.syncManager
        .syncKnowledgeBases(selectedKbIds, mode)
        .then((result: SyncResult) => {
          log('同步结果:', result);
          if (this.progressModal && this.progressModal.opened) {
            this.progressModal.showResult(result);
          }
          this.saveSettings().catch(err => log('保存设置失败:', err));
        })
        .catch((e: Error) => {
          console.error('[IMA] 同步异常(未捕获):', e);
          new Notice(`同步失败: ${e.message || '未知错误'}`, 8000);
        });
    } catch (e: any) {
      // 同步启动本身就抛异常(理论上不应该走到这里)
      console.error('[IMA] startKnowledgeBaseSync 启动异常:', e);
      new Notice(`同步启动失败: ${e.message || '未知错误'}`, 8000);
    }
  }

  startNotebookSync(noteIds: string[] | null, mode: SyncMode): void {
    log(`startNotebookSync 被调用: mode=${mode}, noteIds=${noteIds?.length ?? 'null'}`);

    if (!this.settings.clientId || !this.settings.apiKey) {
      new Notice('请先在设置中配置 Client ID 和 API Key');
      return;
    }
    if (this.syncManager.isRunning()) {
      new Notice('已有同步任务正在进行,请等待或取消');
      return;
    }

    try {
      this.progressModal = new SyncProgressModal(this.app, this);
      this.progressModal.open();

      this.syncManager
        .syncNotebookNotes(noteIds, mode)
        .then((result: SyncResult) => {
          log('笔记本同步结果:', result);
          if (this.progressModal && this.progressModal.opened) {
            this.progressModal.showResult(result);
          }
          this.saveSettings().catch(err => log('保存设置失败:', err));
        })
        .catch((e: Error) => {
          console.error('[IMA] 笔记本同步异常:', e);
          new Notice(`同步失败: ${e.message || '未知错误'}`);
        });
    } catch (e: any) {
      console.error('[IMA] startNotebookSync 启动异常:', e);
      new Notice(`同步启动失败: ${e.message || '未知错误'}`);
    }
  }

  startShareNoteSync(noteId: string): void {
    log(`startShareNoteSync 被调用: noteId=${noteId}`);

    if (!this.settings.clientId || !this.settings.apiKey) {
      new Notice('请先在设置中配置 Client ID 和 API Key');
      return;
    }

    try {
      this.progressModal = new SyncProgressModal(this.app, this);
      this.progressModal.open();

      this.syncManager
        .syncShareNote(noteId)
        .then((result: SyncResult) => {
          log('分享笔记同步结果:', result);
          if (this.progressModal && this.progressModal.opened) {
            this.progressModal.showResult(result);
          }
        })
        .catch((e: Error) => {
          console.error('[IMA] 分享笔记同步异常:', e);
          new Notice(`同步失败: ${e.message || '未知错误'}`);
        });
    } catch (e: any) {
      console.error('[IMA] startShareNoteSync 启动异常:', e);
      new Notice(`同步启动失败: ${e.message || '未知错误'}`);
    }
  }

  // ===== 诊断工具 =====

  async testApiConnection(): Promise<void> {
    if (!this.settings.clientId || !this.settings.apiKey) {
      new Notice('请先在设置中配置 Client ID 和 API Key');
      return;
    }

    new Notice('正在测试 API 连接...');
    log('测试 API 连接...');

    try {
      this.cache.clearKnowledgeBases();
      const kbs = await this.api.searchAllKnowledgeBases(true);
      new Notice(`API 连接正常!共找到 ${kbs.length} 个知识库`);
      log('API 测试成功, 知识库数量:', kbs.length);
    } catch (e: any) {
      const msg = e.message || '';
      log('API 测试失败:', msg);

      if (msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('unauthorized')) {
        new Notice('API Key 无效或已过期,请重新获取', 10000);
      } else if (msg.includes('429') || msg.toLowerCase().includes('rate') || msg.toLowerCase().includes('limit')) {
        new Notice('API 被限流,请等 1-2 分钟后重试', 10000);
      } else if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('fetch')) {
        new Notice('网络连接问题: ' + msg, 10000);
      } else {
        new Notice('API 连接失败: ' + msg, 10000);
      }
    }
  }

  /**
   * 完整诊断:弹出 Modal 显示详细检测步骤
   */
  async runFullDiagnosis(): Promise<void> {
    if (!this.settings.clientId || !this.settings.apiKey) {
      new Notice('请先在设置中配置 Client ID 和 API Key');
      return;
    }

    // 用一个临时 Modal 展示诊断结果
    const diagModal = new (require('obsidian') as any).Modal(this.app);
    diagModal.onOpen = () => {
      const { contentEl } = diagModal.contentEl;
      contentEl.createEl('h2', { text: 'API 连接诊断中...' });

      diagnoseApiConnection(
        this.settings.clientId,
        this.settings.apiKey,
        this.api,
      ).then(result => {
        contentEl.empty();
        contentEl.createEl('h2', { text: '诊断结果' });

        const header = contentEl.createDiv();
        header.style.cssText =
          'font-size:14px;font-weight:500;margin-bottom:12px;padding:8px;border-radius:6px;' +
          (result.ok ? 'background:#eaf3de;color:#27500a;' : 'background:#fceebe;color:#7a5900;');
        header.setText(result.ok ? '✅ ' + result.summary : '❌ ' + result.summary);

        for (const step of result.steps) {
          const row = contentEl.createDiv();
          row.style.cssText = 'padding:6px;border-left:3px solid;margin-bottom:8px;' +
            (step.status === 'ok' ? 'border-color:#1d9e75;' :
             step.status === 'warn' ? 'border-color:#ba7517;' :
             step.status === 'fail' ? 'border-color:#a32d2d;' :
             'border-color:#888780;');

          row.createSpan({ text: step.status === 'ok' ? '✓' : step.status === 'warn' ? '⚠' : step.status === 'fail' ? '✗' : '—' }).style.fontWeight = 'bold';

          const info = row.createDiv();
          info.createDiv({ text: step.name }).style.fontWeight = '500';
          info.createDiv({ text: step.detail }).style.cssText = 'font-size:12px;color:#5f5e5a;';
        }

        const suggestBox = contentEl.createDiv();
        suggestBox.style.cssText = 'margin-top:12px;padding:8px;background:#f1efe8;border-radius:6px;font-size:12px;line-height:1.6;white-space:pre-wrap;';
        suggestBox.createDiv({ text: '修复建议:' }).style.fontWeight = 'bold';
        suggestBox.createDiv({ text: result.suggestion });

        contentEl.createEl('button', { text: '关闭', cls: 'mod-cta' }).onclick = () => diagModal.close();
      }).catch(e => {
        contentEl.empty();
        contentEl.createEl('h2', { text: '诊断异常' });
        contentEl.createEl('p', { text: String(e.message || e) });
      });
    };
    diagModal.open();
  }

  showDebugInfo(): void {
    const lines: string[] = [];
    lines.push(`═══ IMA 插件调试信息 ═══`);
    lines.push(`版本: 2.0.0`);
    lines.push(`Client ID: ${this.settings.clientId ? '已配置(' + this.settings.clientId.substring(0, 8) + '...)' : '❌ 未配置'}`);
    lines.push(`API Key: ${this.settings.apiKey ? '已配置(' + this.settings.apiKey.substring(0, 8) + '...)' : '❌ 未配置'}`);
    lines.push(`目标文件夹: ${this.settings.targetFolder}`);
    lines.push(`已选知识库: ${this.settings.selectedKbs.length} 个`);
    lines.push(`上次同步: ${this.settings.lastSyncTime ? new Date(this.settings.lastSyncTime).toLocaleString('zh-CN') : '从未'}`);
    lines.push(`同步状态: ${this.syncManager.isRunning() ? '⏳ 进行中' : '✓ 空闲'}`);
    lines.push(`QPS 限制: ${this.settings.qpsLimit}`);
    lines.push(`缓存 TTL: ${this.settings.cacheTtlMinutes} 分钟`);
    lines.push(`最大重试: ${this.settings.maxRetries}`);
    lines.push(`请求超时: ${this.settings.requestTimeoutMs / 1000}s`);
    const stats = this.cache.getStats();
    lines.push(`缓存项数: ${stats.totalEntries}`);
    lines.push(`════════════════════`);

    const noticeText = lines.join('\n');
    new Notice(noticeText, 20000);
    console.log(noticeText);
  }
}
