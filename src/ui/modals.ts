import { App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import { ImaPlugin } from '../main';
import { ProgressBar } from './progress-bar';
import { SyncMode, SyncProgress } from '../types';
import { diagnoseApiConnection, DiagResult } from '../utils/api-diagnostic';

/**
 * 诊断结果渲染到 DOM
 */
function renderDiagResult(container: HTMLElement, result: DiagResult) {
  container.empty();

  // 总状态
  const header = container.createDiv();
  header.style.cssText =
    'font-size:14px;font-weight:500;margin-bottom:12px;padding:8px;border-radius:6px;' +
    (result.ok ? 'background:#eaf3de;color:#27500a;' : 'background:#fceebe;color:#7a5900;');
  header.setText(result.ok ? '✅ ' + result.summary : '❌ ' + result.summary);

  // 各步骤
  for (const step of result.steps) {
    const row = container.createDiv();
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;padding:6px;border-left:3px solid;' +
      (step.status === 'ok' ? 'border-color:#1d9e75;' :
       step.status === 'warn' ? 'border-color:#ba7517;' :
       step.status === 'fail' ? 'border-color:#a32d2d;' :
       'border-color:#888780;');

    const icon = row.createSpan();
    icon.style.fontWeight = 'bold';
    icon.setText(step.status === 'ok' ? '✓' : step.status === 'warn' ? '⚠' : step.status === 'fail' ? '✗' : '—');

    const info = row.createDiv();

    const name = info.createDiv({ text: step.name });
    name.style.fontWeight = '500';

    const detail = info.createDiv({ text: step.detail });
    detail.style.cssText = 'font-size:12px;color:#5f5e5a;margin-top:2px;';
  }

  // 建议
  const suggestBox = container.createDiv({
    cls: 'setting-item-description',
  });
  suggestBox.style.cssText = 'margin-top:12px;padding:8px;background:#f1efe8;border-radius:6px;font-size:12px;line-height:1.6;white-space:pre-wrap;';
  suggestBox.createDiv({ text: '修复建议:' }).style.fontWeight = 'bold';
  suggestBox.createDiv({ text: result.suggestion });
}

/**
 * 知识库选择 Modal
 */
export class KnowledgeBaseModal extends Modal {
  plugin: ImaPlugin;
  knowledgeBases: any[] = [];
  loadingFromCache: boolean = false;

  constructor(app: App, plugin: ImaPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '加载知识库...' });

    try {
      this.knowledgeBases = await this.plugin.api.searchAllKnowledgeBases(false);
      this.loadingFromCache = this.plugin.cache.getKnowledgeBases(false) !== null;
      this.displayKbs();
      return;
    } catch (e: any) {
      console.error('[IMA] 加载知识库失败:', e);
      contentEl.empty();
    }

    // ===== 错误恢复 UI =====
    contentEl.createEl('h2', { text: '⚠️ 加载失败' });

    // 显示具体错误(不再笼统说"请检查 API Key")
    const errDetail = contentEl.createDiv();
    errDetail.style.cssText =
      'padding:8px;background:#fceebe;border-radius:6px;font-size:12px;margin-bottom:12px;white-space:pre-wrap;';
    errDetail.createEl('div', { text: '错误信息:' }).style.fontWeight = 'bold';

    // 从 catch 中取到的 e 可能已经被上一级吞掉了,这里用通用提示
    errDetail.createEl('div', {
      text: '无法连接 IMA 服务。可能原因:\n' +
        '· 网络不通或代理问题\n' +
        '· API Key 已过期\n' +
        '· IMA 服务暂时不可用\n' +
        '· 请求频率过高被限流',
    });

    new Setting(contentEl)
      .setName('诊断连接')
      .setDesc('自动检测网络、认证、API 接口状态,给出具体原因和修复建议')
      .addButton(btn => btn.setButtonText('开始诊断').setCta().onClick(async () => {
        btn.setDisabled(true).setButtonText('诊断中...');
        const diagResult = await diagnoseApiConnection(
          this.plugin.settings.clientId,
          this.plugin.settings.apiKey,
          this.plugin.api,
        );
        renderDiagResult(contentEl, diagResult);
      }));

    const btnRow = contentEl.createDiv();
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;';

    btnRow.createEl('button', { text: '重试加载' }).onclick = async () => {
      contentEl.empty();
      contentEl.createEl('h2', { text: '重新加载中...' });
      try {
        this.knowledgeBases = await this.plugin.api.searchAllKnowledgeBases(true); // forceRefresh
        this.loadingFromCache = false;
        this.displayKbs();
      } catch (retryErr: any) {
        console.error('[IMA] 重试也失败了:', retryErr);
        contentEl.empty();
        contentEl.createEl('h2', { text: '⚠️ 仍然失败' });
        const detail = contentEl.createDiv();
        detail.style.cssText = 'padding:8px;background:#fceebe;border-radius:6px;font-size:12px;margin-bottom:12px;';
        detail.setText(`具体错误: ${retryErr.message || '(无详细信息)'}`);
        new Setting(contentEl)
          .setName('诊断')
          .addButton(btn => btn.setButtonText('运行诊断').setCta().onClick(async () => {
            const d = await diagnoseApiConnection(this.plugin.settings.clientId, this.plugin.settings.apiKey, this.plugin.api);
            renderDiagResult(contentEl, d);
          }));
      }
    };

    btnRow.createEl('button', { text: '取消' }).onclick = () => this.close();
  }

  displayKbs() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '选择要同步的知识库' });

    const hint = contentEl.createEl('p', {
      text: this.loadingFromCache
        ? '已从缓存加载,如需刷新请点击下方按钮。⚠️ 知识库笔记可能需要权限读取。'
        : '已从远端加载。⚠️ 知识库笔记可能需要权限读取。',
      cls: 'setting-item-description',
    });
    hint.style.marginBottom = '8px';

    new Setting(contentEl)
      .setName('刷新列表')
      .setDesc('强制重新从 IMA 拉取知识库列表(清除缓存)')
      .addButton(btn => {
        btn.setButtonText('刷新').onClick(() => {
          this.plugin.cache.clearKnowledgeBases();
          this.close();
          this.plugin.openKnowledgeBaseModal();
        });
      });

    if (!this.knowledgeBases || this.knowledgeBases.length === 0) {
      contentEl.createEl('p', { text: '未找到可用知识库' });
      return;
    }

    const selectedKbs = new Set(this.plugin.settings.selectedKbs);

    const listDiv = contentEl.createDiv();
    listDiv.style.maxHeight = '400px';
    listDiv.style.overflowY = 'auto';
    listDiv.style.marginBottom = '12px';

    for (const kb of this.knowledgeBases) {
      const kbDiv = listDiv.createDiv();
      kbDiv.style.cssText =
        'margin-bottom:8px;padding:8px;border-bottom:1px solid #eee;';

      const checkbox = kbDiv.createEl('input', { type: 'checkbox' });
      checkbox.checked = selectedKbs.has(kb.kb_id);
      checkbox.style.marginRight = '8px';

      kbDiv.createEl('span', {
        text: ` ${kb.kb_name} `,
      }).style.fontWeight = 'bold';

      kbDiv.createEl('span', {
        text: ` [${kb.role_type || ''}]`,
        cls: 'setting-item-description',
      });

      if (kb.kb_desc) {
        kbDiv.createEl('p', { text: kb.kb_desc, cls: 'setting-item-description' });
      }

      checkbox.onchange = () => {
        if (checkbox.checked) selectedKbs.add(kb.kb_id);
        else selectedKbs.delete(kb.kb_id);
      };
    }

    const btnContainer = contentEl.createDiv();
    btnContainer.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;';

    btnContainer.createEl('button', { text: '全选' }).onclick = () => {
      this.knowledgeBases.forEach(kb => selectedKbs.add(kb.kb_id));
      this.displayKbs();
    };

    btnContainer.createEl('button', { text: '清空选择' }).onclick = () => {
      selectedKbs.clear();
      this.displayKbs();
    };

    btnContainer.createEl('button', { text: '取消' }).onclick = () => this.close();

    const incrementalBtn = btnContainer.createEl('button', {
      text: '增量同步',
      cls: 'mod-cta',
    });
    incrementalBtn.onclick = async () => {
      const selected = Array.from(selectedKbs);
      if (selected.length === 0) {
        new Notice('请至少选择一个知识库');
        return;
      }
      this.plugin.settings.selectedKbs = selected;
      await this.plugin.saveSettings();
      this.close();
      this.plugin.startKnowledgeBaseSync(selected, 'incremental');
    };

    const fullBtn = btnContainer.createEl('button', { text: '全量同步' });
    fullBtn.style.cssText = 'background:#fceeda;';
    fullBtn.onclick = async () => {
      const selected = Array.from(selectedKbs);
      if (selected.length === 0) {
        new Notice('请至少选择一个知识库');
        return;
      }
      this.plugin.settings.selectedKbs = selected;
      await this.plugin.saveSettings();
      this.close();
      this.plugin.startKnowledgeBaseSync(selected, 'full');
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 笔记本笔记 Modal (同样加上诊断)
 */
export class NotebookNotesModal extends Modal {
  plugin: ImaPlugin;
  notebooks: any[] = [];
  loadingFromCache: boolean = false;

  constructor(app: App, plugin: ImaPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '加载笔记本...' });

    try {
      this.notebooks = await this.plugin.api.listNotebooks(false);
      this.loadingFromCache = this.plugin.cache.getNotebooks(false) !== null;
      this.displayNotebooks();
      return;
    } catch (e: any) {
      console.error('[IMA] 加载笔记本失败:', e);
      contentEl.empty();
    }

    contentEl.createEl('h2', { text: '⚠️ 加载失败' });

    const errBox = contentEl.createDiv();
    errBox.style.cssText = 'padding:8px;background:#fceebe;border-radius:6px;font-size:12px;margin-bottom:12px;';
    errBox.setText(`错误: ${'e' in (window as any) ? '' : '无法连接 IMA 服务'}`);

    new Setting(contentEl)
      .setName('诊断连接')
      .addButton(btn => btn.setButtonText('开始诊断').setCta().onClick(async () => {
        btn.setDisabled(true).setButtonText('诊断中...');
        const d = await diagnoseApiConnection(
          this.plugin.settings.clientId,
          this.plugin.settings.apiKey,
          this.plugin.api,
        );
        renderDiagResult(contentEl, d);
      }));

    const btnRow = contentEl.createDiv();
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '12px';

    btnRow.createEl('button', { text: '重试' }).onclick = () => {
      contentEl.empty();
      this.onOpen(); // re-enter
    };
    btnRow.createEl('button', { text: '取消' }).onclick = () => this.close();
  }

  displayNotebooks() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: '笔记本笔记' });
    contentEl.createEl('p', {
      text: this.loadingFromCache
        ? '已从缓存加载。这是你自己的笔记本笔记。'
        : '已从远端加载。这是你自己的笔记本笔记。',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .setName('刷新列表')
      .setDesc('强制重新拉取(清除缓存)')
      .addButton(btn => {
        btn.setButtonText('刷新').onClick(() => {
          this.plugin.cache.clearNotebooks();
          this.close();
          this.plugin.openNotebookNotesModal();
        });
      });

    if (!this.notebooks || this.notebooks.length === 0) {
      contentEl.createEl('p', { text: '未找到笔记本笔记' });
      return;
    }

    const selectedNotes = new Set<string>();

    const listDiv = contentEl.createDiv();
    listDiv.style.maxHeight = '400px';
    listDiv.style.overflowY = 'auto';
    listDiv.style.marginBottom = '12px';

    for (const note of this.notebooks) {
      const noteDiv = listDiv.createDiv();
      noteDiv.style.cssText = 'margin-bottom:8px;padding:4px;';

      const checkbox = noteDiv.createEl('input', { type: 'checkbox' });
      checkbox.style.marginRight = '8px';

      noteDiv.createEl('span', { text: note.title || '未命名' });

      checkbox.onchange = () => {
        if (checkbox.checked) selectedNotes.add(note.doc_id);
        else selectedNotes.delete(note.doc_id);
      };
    }

    const btnContainer = contentEl.createDiv();
    btnContainer.style.cssText = 'display:flex;gap:8px;margin-top:12px;';

    btnContainer.createEl('button', { text: '全选' }).onclick = () => {
      this.notebooks.forEach(n => selectedNotes.add(n.doc_id));
      this.displayNotebooks();
    };

    btnContainer.createEl('button', { text: '取消' }).onclick = () => this.close();

    const syncBtn = btnContainer.createEl('button', { text: '同步选中', cls: 'mod-cta' });
    syncBtn.onclick = async () => {
      if (selectedNotes.size === 0) {
        new Notice('请选择要同步的笔记');
        return;
      }
      this.close();
      this.plugin.startNotebookSync(Array.from(selectedNotes), 'incremental');
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 分享链接 Modal
 */
export class ShareNoteModal extends Modal {
  plugin: ImaPlugin;
  initialUrl: string;

  constructor(app: App, plugin: ImaPlugin, initialUrl: string = '') {
    super(app);
    this.plugin = plugin;
    this.initialUrl = initialUrl;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '同步分享链接笔记' });
    contentEl.createEl('p', { text: '粘贴 IMA 分享链接或笔记ID:' });

    const inputEl = contentEl.createEl('input', {
      type: 'text',
      placeholder: 'https://ima.qq.com/note/share/_AweNbOP8AufLZwbbFNmOw',
    });
    inputEl.style.cssText = 'width:100%;margin-bottom:10px;padding:6px;';
    if (this.initialUrl) inputEl.value = this.initialUrl;

    const btnContainer = contentEl.createDiv();
    btnContainer.style.cssText = 'display:flex;gap:8px;';

    const syncBtn = btnContainer.createEl('button', { text: '同步', cls: 'mod-cta' });
    syncBtn.onclick = async () => {
      const input = inputEl.value.trim();
      if (!input) {
        new Notice('请输入分享链接或笔记ID');
        return;
      }

      let noteId = input;
      const match = input.match(/note\/share\/([^?]+)/);
      if (match) noteId = match[1];

      // 验证非空
      if (!noteId) {
        new Note('无法从输入中解析出笔记 ID');
        return;
      }

      this.close();
      this.plugin.startShareNoteSync(noteId);
    };

    btnContainer.createEl('button', { text: '取消' }).onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * 文件夹选择 Modal
 */
export class FolderSelectModal extends Modal {
  plugin: ImaPlugin;
  settingTab: any;

  constructor(app: App, plugin: ImaPlugin, settingTab: any) {
    super(app);
    this.plugin = plugin;
    this.settingTab = settingTab;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: '选择文件夹' });

    const folders = this.getAvailableFolders();
    const selectEl = contentEl.createEl('select');
    selectEl.style.cssText = 'width:100%;margin:12px 0;padding:6px;';

    folders.forEach(folder => {
      const option = selectEl.createEl('option');
      option.value = folder;
      option.textContent = folder || '根目录';
      if (folder === this.plugin.settings.targetFolder) option.selected = true;
    });

    const btnContainer = contentEl.createDiv();
    btnContainer.style.cssText = 'display:flex;gap:8px;';

    btnContainer.createEl('button', { text: '取消' }).onclick = () => this.close();

    const saveBtn = btnContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
    saveBtn.onclick = async () => {
      this.plugin.settings.targetFolder = selectEl.value;
      await this.plugin.saveSettings();
      this.close();
      new Notice('文件夹已更新');
      if (this.settingTab && this.settingTab.display) this.settingTab.display();
    };
  }

  getAvailableFolders(): string[] {
    const folders = new Set<string>(['', 'IMA知识库']);
    this.app.vault.getFiles().forEach(file => {
      const parts = file.path.split('/').slice(0, -1);
      let current = '';
      parts.forEach(part => {
        current += (current ? '/' : '') + part;
        folders.add(current);
      });
    });
    return Array.from(folders).sort();
  }

  onClose() {
    this.contentEl.empty();
  }
}
