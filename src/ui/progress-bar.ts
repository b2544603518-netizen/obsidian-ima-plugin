import { SyncProgress } from '../types';

/**
 * 同步进度条组件
 *
 * 轻量内嵌实现:用纯 DOM 元素渲染进度条,不依赖额外 CSS 文件。
 * 用于在 Modal 或 Notice 中展示当前同步进度。
 */
export class ProgressBar {
  private container: HTMLElement;
  private barEl: HTMLElement;
  private fillEl: HTMLElement;
  private titleEl: HTMLElement;
  private statsEl: HTMLElement;
  private cancelBtn: HTMLElement | null = null;
  private onCancel: (() => void) | null = null;

  constructor(parent: HTMLElement, onCancel?: () => void) {
    this.container = parent.createDiv({ cls: 'ima-progress-container' });
    this.container.style.cssText =
      'margin:12px 0;padding:12px;border:1px solid #d3d1c7;border-radius:8px;background:#f1efe8;';

    this.titleEl = this.container.createDiv({ cls: 'ima-progress-title' });
    this.titleEl.style.cssText = 'font-size:13px;font-weight:500;margin-bottom:8px;color:#2c2c2a;';

    this.barEl = this.container.createDiv({ cls: 'ima-progress-bar' });
    this.barEl.style.cssText =
      'width:100%;height:8px;background:#d3d1c7;border-radius:4px;overflow:hidden;margin-bottom:8px;';
    this.fillEl = this.barEl.createDiv({ cls: 'ima-progress-fill' });
    this.fillEl.style.cssText =
      'width:0%;height:100%;background:#1d9e75;border-radius:4px;transition:width 0.3s ease;';

    this.statsEl = this.container.createDiv({ cls: 'ima-progress-stats' });
    this.statsEl.style.cssText = 'font-size:12px;color:#5f5e5a;display:flex;gap:12px;flex-wrap:wrap;';

    if (onCancel) {
      this.onCancel = onCancel;
      this.cancelBtn = this.container.createEl('button', { text: '取消同步' });
      this.cancelBtn.style.cssText =
        'margin-top:8px;padding:4px 12px;font-size:12px;border:1px solid #b4b2a9;border-radius:4px;background:#fff;cursor:pointer;color:#791f1f;';
      this.cancelBtn.onclick = () => {
        if (this.onCancel) this.onCancel();
      };
    }
  }

  update(progress: SyncProgress) {
    const percent = progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;
    this.fillEl.style.width = `${percent}%`;

    const phaseText: Record<string, string> = {
      listing: '加载列表',
      downloading: '下载内容',
      saving: '保存文件',
      done: '完成',
      idle: '准备中',
    };
    const phase = phaseText[progress.phase] || progress.phase;
    this.titleEl.setText(
      progress.cancelled
        ? '正在取消...'
        : `[${phase}] ${progress.current}/${progress.total} · ${progress.currentTitle}`
    );

    const parts: string[] = [];
    parts.push(`已同步 ${progress.synced}`);
    if (progress.skipped > 0) parts.push(`跳过 ${progress.skipped}`);
    if (progress.failed > 0) parts.push(`失败 ${progress.failed}`);
    this.statsEl.setText(parts.join('  ·  '));

    if (progress.phase === 'done' || progress.cancelled) {
      if (this.cancelBtn) {
        this.cancelBtn.setAttribute('disabled', 'true');
        this.cancelBtn.style.opacity = '0.5';
      }
    }
  }

  remove() {
    this.container.remove();
  }
}
