import { App, Modal, Notice } from 'obsidian';
import { ImaPlugin } from '../main';
import { ProgressBar } from './progress-bar';
import { SyncProgress, SyncResult } from '../types';

/**
 * 同步进度 Modal v2.1
 *
 * 修复点:
 * 1. 用自定义 `opened` 标志替代不存在的 `Modal.isOpen`
 * 2. 进度更新实时反映到 UI
 * 3. 同步完成后保留结果展示(不自动关闭)
 */
export class SyncProgressModal extends Modal {
  plugin: ImaPlugin;
  private progressBar: ProgressBar | null = null;
  private resultEl: HTMLElement | null = null;
  private onComplete: ((result: SyncResult) => void) | null = null;

  // 关键修复:Obsidian Modal 没有 isOpen 属性,用自定义标志
  opened: boolean = false;

  constructor(app: App, plugin: ImaPlugin, onComplete?: (result: SyncResult) => void) {
    super(app);
    this.plugin = plugin;
    this.onComplete = onComplete;
  }

  onOpen() {
    this.opened = true;
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '🔄 同步进度' });

    this.progressBar = new ProgressBar(contentEl, () => {
      this.plugin.syncManager.cancel();
    });

    this.resultEl = contentEl.createDiv();
    this.resultEl.style.cssText = 'margin-top:12px;font-size:13px;';

    const closeBtn = contentEl.createEl('button', { text: '关闭', cls: 'mod-cta' });
    closeBtn.style.cssText = 'margin-top:12px;';
    closeBtn.onclick = () => this.close();
  }

  update(progress: SyncProgress) {
    if (!this.opened) return;
    if (this.progressBar) this.progressBar.update(progress);
  }

  showResult(result: SyncResult) {
    if (!this.resultEl) return;
    this.resultEl.empty();

    const lines: string[] = [];
    lines.push(`⏱️ 耗时: ${(result.durationMs / 1000).toFixed(1)} 秒`);
    lines.push(`📊 总数: ${result.total}`);
    lines.push(`✅ 成功同步: ${result.synced}`);
    if (result.skipped > 0) lines.push(`⏭️ 跳过(已存在): ${result.skipped}`);
    if (result.failed > 0) lines.push(`❌ 失败: ${result.failed}`);
    if (result.cancelled) lines.push('⚠️ 已取消');

    for (const line of lines) {
      this.resultEl.createEl('div', { text: line });
    }

    if (result.errors.length > 0) {
      const errDiv = this.resultEl.createDiv();
      errDiv.style.cssText =
        'margin-top:8px;padding:8px;background:#fceebe;border-radius:6px;font-size:12px;max-height:150px;overflow-y:auto;';
      errDiv.createEl('div', { text: '错误详情:' }).style.fontWeight = 'bold';
      result.errors.slice(0, 50).forEach(err => {
        errDiv.createEl('div', { text: '· ' + err });
      });
      if (result.errors.length > 50) {
        errDiv.createEl('div', { text: `...还有 ${result.errors.length - 50} 条错误` });
      }
    }

    if (this.onComplete) this.onComplete(result);
  }

  onClose() {
    this.opened = false;
    this.contentEl.empty();
  }
}
