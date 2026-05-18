import { Plugin, Notice, requestUrl, Setting, Modal, PluginSettingTab } from 'obsidian';

const DEFAULT_SETTINGS = {
    clientId: '4500bc3e9924560abc18944655cfa0d3',
    apiKey: '',
    targetFolder: 'IMA知识库',
    lastSyncTime: '',
    selectedKbs: [],
    selectedNotes: {}
};

class ImaPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'sync-ima-select',
            name: '选择知识库同步',
            callback: () => this.showSyncModal()
        });

        this.addCommand({
            id: 'sync-ima-full',
            name: '全量同步 IMA 知识库',
            callback: () => this.syncAll(true)
        });

        this.addCommand({
            id: 'sync-ima-share',
            name: '同步分享链接笔记',
            callback: () => this.syncFromShareLink()
        });

        this.addCommand({
            id: 'sync-ima-notebook',
            name: '同步笔记本笔记',
            callback: () => this.syncNotebookNotes()
        });

        this.addRibbonIcon('sync', 'IMA 同步', () => {
            this.showSyncModal();
        });

        this.addSettingTab(new ImaSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        if (!this.settings.selectedKbs) this.settings.selectedKbs = [];
        if (!this.settings.selectedNotes) this.settings.selectedNotes = {};
        if (!this.settings.targetFolder) this.settings.targetFolder = 'IMA知识库';
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async showSyncModal() {
        if (!this.settings.apiKey) {
            new Notice('请先在设置中配置 IMA API Key');
            return;
        }
        new KnowledgeBaseModal(this.app, this).open();
    }

    async syncFromShareLink(shareUrl: string = null) {
        new ShareNoteModal(this.app, this, shareUrl).open();
    }

    async syncNotebookNotes() {
        new NotebookNotesModal(this.app, this).open();
    }

    async syncAll(fullSync = true, selectedKbIds = null) {
        new Notice('开始同步知识库...');

        try {
            const api = new ImaApi(this.settings.clientId, this.settings.apiKey);

            const knowledgeBases = await api.searchAllKnowledgeBases();

            if (!knowledgeBases || knowledgeBases.length === 0) {
                new Notice('未找到可用的知识库');
                return;
            }

            let targetKbs;
            if (selectedKbIds && selectedKbIds.length > 0) {
                targetKbs = knowledgeBases.filter(kb => selectedKbIds.includes(kb.kb_id));
            } else if (this.settings.selectedKbs.length > 0) {
                targetKbs = knowledgeBases.filter(kb => this.settings.selectedKbs.includes(kb.kb_id));
            } else {
                targetKbs = knowledgeBases;
            }

            if (targetKbs.length === 0) {
                new Notice('请先选择要同步的知识库！');
                return;
            }

            let syncedCount = 0;
            let skippedPermission = 0;
            let skippedFolder = 0;
            let skippedEmpty = 0;

            for (const kb of targetKbs) {
                const items = await api.getAllKnowledgeList(kb.kb_id);

                if (!items || items.length === 0) continue;

                for (const item of items) {
                    if (item.media_type === 99) {
                        skippedFolder++;
                        continue;
                    }

                    let content = null;
                    let failReason = '';

                    try {
                        if (item.media_type === 11) {
                            const docResult = await api.getDocContentWithError(item.media_id);
                            if (docResult.success && docResult.content) {
                                content = docResult.content;
                            } else {
                                failReason = `get_doc_content 失败: ${docResult.error}`;
                            }
                        }

                        if (!content) {
                            const exportResult = await api.exportMediaWithError(item.media_id);
                            if (exportResult.success && exportResult.content) {
                                content = exportResult.content;
                            } else {
                                failReason = failReason || `export_media 失败: ${exportResult.error}`;
                            }
                        }

                        if (content) {
                            const title = item.title || '未命名';
                            const safeTitle = title.replace(/[/\\:*?"<>|]/g, '_').substring(0, 100);
                            const filePath = `${this.settings.targetFolder}/${kb.kb_name}/${safeTitle}.md`;

                            const frontMatter = this.generateFrontMatter(kb, item);
                            await this.saveFile(filePath, frontMatter + content);
                            syncedCount++;
                        } else {
                            skippedPermission++;
                            console.warn(`[IMA] 跳过: ${item.title} - ${failReason}`);
                        }
                    } catch (e) {
                        skippedPermission++;
                        console.warn(`[IMA] 跳过: ${item.title} - ${e.message}`);
                    }
                }
            }

            this.settings.lastSyncTime = new Date().toISOString();
            await this.saveSettings();

            let msg = `同步 ${syncedCount} 个文件`;
            if (skippedPermission > 0) msg += `，跳过 ${skippedPermission} 个（权限不足）`;
            if (skippedFolder > 0) msg += `，跳过 ${skippedFolder} 个文件夹`;
            new Notice(msg);

        } catch (e) {
            console.error('[IMA] 同步失败:', e);
            new Notice('同步失败: ' + e.message);
        }
    }

    generateFrontMatter(kb, item) {
        return '---\n' +
            'source: IMA知识库\n' +
            `kb_name: "${kb?.kb_name || '未知'}"\n` +
            `title: "${item.title}"\n` +
            `media_id: "${item.media_id}"\n` +
            `media_type: ${item.media_type}\n` +
            `sync_time: "${new Date().toISOString()}"\n` +
            '---\n\n';
    }

    async saveFile(path, content) {
        const normalizedPath = path.replace(/[/\\]+/g, '/');
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
        if (existingFile) {
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(normalizedPath, content);
        }
    }
}

class ImaApi {
    clientId: string;
    apiKey: string;
    wikiBaseUrl = 'https://ima.qq.com/openapi/wiki/v1';
    noteBaseUrl = 'https://ima.qq.com/openapi/note/v1';

    constructor(clientId: string, apiKey: string) {
        this.clientId = clientId;
        this.apiKey = apiKey;
    }

    async request(baseUrl: string, endpoint: string, data: any = {}) {
        const url = `${baseUrl}/${endpoint}`;

        const resp = await requestUrl({
            url: url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'ima-openapi-clientid': this.clientId,
                'ima-openapi-apikey': this.apiKey
            },
            body: JSON.stringify(data)
        });

        if (resp.json.code !== 0) {
            throw new Error(`${endpoint}: ${resp.json.msg || '未知错误'}`);
        }

        return resp.json.data;
    }

    async searchAllKnowledgeBases() {
        const allKbs: any[] = [];
        let cursor = '';

        while (true) {
            const data = await this.request(this.wikiBaseUrl, 'search_knowledge_base', {
                query: '',
                cursor: cursor,
                limit: 20
            });

            const kbs = data?.info_list || [];
            if (kbs.length === 0) break;

            allKbs.push(...kbs);

            if (data.is_end) break;
            cursor = data.next_cursor || '';
            if (!cursor) break;
        }

        return allKbs;
    }

    async getAllKnowledgeList(kbId: string) {
        const allItems: any[] = [];
        let cursor = '';

        while (true) {
            const data = await this.request(this.wikiBaseUrl, 'get_knowledge_list', {
                knowledge_base_id: kbId,
                cursor: cursor,
                limit: 50
            });

            const items = data?.knowledge_list || [];
            if (items.length === 0) break;

            allItems.push(...items);

            if (data.is_end) break;
            cursor = data.next_cursor || '';
            if (!cursor) break;
        }

        return allItems;
    }

    async exportMedia(mediaId: string) {
        try {
            const data = await this.request(this.wikiBaseUrl, 'export_media_for_ima_sandbox', {
                media_id: mediaId
            });

            const downloadUrl = data?.media_content_url_info?.url;
            if (!downloadUrl) return null;

            const resp = await requestUrl({ url: downloadUrl, method: 'GET' });
            return resp.text;
        } catch (e) {
            return null;
        }
    }

    async getDocContent(docId: string) {
        try {
            const data = await this.request(this.noteBaseUrl, 'get_doc_content', {
                doc_id: docId,
                target_content_format: 1
            });

            if (data?.content) return data.content;
            return null;
        } catch (e) {
            return null;
        }
    }

    async getDocContentWithError(docId: string) {
        try {
            const data = await this.request(this.noteBaseUrl, 'get_doc_content', {
                doc_id: docId,
                target_content_format: 1
            });

            if (data?.content) {
                return { success: true, content: data.content };
            }
            return { success: false, error: '内容为空' };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async exportMediaWithError(mediaId: string) {
        try {
            const data = await this.request(this.wikiBaseUrl, 'export_media_for_ima_sandbox', {
                media_id: mediaId
            });

            const downloadUrl = data?.media_content_url_info?.url;
            if (!downloadUrl) {
                return { success: false, error: '无下载链接' };
            }

            const resp = await requestUrl({ url: downloadUrl, method: 'GET' });
            return { success: true, content: resp.text };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // 笔记本 API
    async listNotebooks() {
        const notebooks: any[] = [];
        let cursor = '0';

        while (true) {
            try {
                const data = await this.request(this.noteBaseUrl, 'list_note_by_folder_id', {
                    cursor: cursor,
                    limit: 20
                });

                const items = data?.notes || [];
                if (items.length === 0) break;

                notebooks.push(...items);

                if (data.is_end) break;
                cursor = data.next_cursor || '';
                if (!cursor || cursor === '0') break;
            } catch (e) {
                break;
            }
        }

        return notebooks;
    }
}

class ImaSettingTab extends PluginSettingTab {
    plugin: ImaPlugin;

    constructor(app: any, plugin: ImaPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'IMA 同步设置' });

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('已自动配置')
            .addText(text => text.setValue(this.plugin.settings.clientId));

        new Setting(containerEl)
            .setName('API Key')
            .setDesc('从 https://ima.qq.com/agent-interface 获取')
            .addText(text => {
                text.inputEl.type = 'password';
                text.setValue(this.plugin.settings.apiKey);
                text.onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('目标文件夹')
            .setDesc(`当前: ${this.plugin.settings.targetFolder}`)
            .addButton(btn => btn.setButtonText('选择文件夹').onClick(() => {
                new FolderSelectModal(this.app, this.plugin, this).open();
            }));

        new Setting(containerEl)
            .setName('同步笔记本')
            .setDesc('同步你自己的笔记本笔记')
            .addButton(btn => btn.setButtonText('同步笔记本').onClick(() => {
                this.plugin.syncNotebookNotes();
            }));

        new Setting(containerEl)
            .setName('同步分享链接')
            .setDesc('输入分享链接，单个同步')
            .addButton(btn => btn.setButtonText('输入链接').onClick(() => {
                this.plugin.syncFromShareLink();
            }));

        new Setting(containerEl)
            .setName('同步知识库')
            .setDesc('同步知识库里的笔记（可能权限不足）')
            .addButton(btn => btn.setButtonText('选择知识库').onClick(() => {
                new KnowledgeBaseModal(this.app, this.plugin).open();
            }));

        if (this.plugin.settings.selectedKbs.length > 0) {
            containerEl.createEl('p', {
                text: `已选择 ${this.plugin.settings.selectedKbs.length} 个知识库`,
                cls: 'setting-item-description'
            });
        }

        new Setting(containerEl)
            .setName('全量同步知识库')
            .setDesc('同步所有已选知识库')
            .addButton(btn => btn.setButtonText('全量同步').setCta().onClick(() => {
                this.plugin.syncAll(true);
            }));
    }
}

class FolderSelectModal extends Modal {
    plugin: ImaPlugin;
    settingTab: ImaSettingTab;

    constructor(app: any, plugin: ImaPlugin, settingTab: ImaSettingTab) {
        super(app);
        this.plugin = plugin;
        this.settingTab = settingTab;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '选择文件夹' });

        const folders = this.getAvailableFolders();
        const selectEl = contentEl.createEl('select');

        folders.forEach(folder => {
            const option = selectEl.createEl('option');
            option.value = folder;
            option.textContent = folder || '根目录';
            if (folder === this.plugin.settings.targetFolder) {
                option.selected = true;
            }
        });

        const btnContainer = contentEl.createDiv();

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => this.close();

        const saveBtn = btnContainer.createEl('button', { text: '确定', cls: 'mod-cta' });
        saveBtn.onclick = async () => {
            this.plugin.settings.targetFolder = selectEl.value;
            await this.plugin.saveSettings();
            this.close();
            new Notice('文件夹已更新');
            this.settingTab.display();
        };
    }

    getAvailableFolders() {
        const folders = new Set(['', 'IMA知识库']);
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

class ShareNoteModal extends Modal {
    plugin: ImaPlugin;
    initialUrl: string;

    constructor(app: any, plugin: ImaPlugin, initialUrl: string = null) {
        super(app);
        this.plugin = plugin;
        this.initialUrl = initialUrl;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '同步分享链接笔记' });

        contentEl.createEl('p', { text: '粘贴 IMA 分享链接或笔记ID：' });

        const inputEl = contentEl.createEl('input', {
            type: 'text',
            placeholder: 'https://ima.qq.com/note/share/_AweNbOP8AufLZwbbFNmOw'
        });
        inputEl.style.width = '100%';
        inputEl.style.marginBottom = '10px';

        if (this.initialUrl) {
            inputEl.value = this.initialUrl;
        }

        const btnContainer = contentEl.createDiv();

        const syncBtn = btnContainer.createEl('button', { text: '同步', cls: 'mod-cta' });
        syncBtn.onclick = async () => {
            const input = inputEl.value.trim();
            if (!input) {
                new Notice('请输入分享链接或笔记ID');
                return;
            }

            let noteId = input;
            const match = input.match(/note\/share\/([^?]+)/);
            if (match) {
                noteId = match[1];
            }

            new Notice('正在获取笔记...');
            this.close();

            try {
                const api = new ImaApi(this.plugin.settings.clientId, this.plugin.settings.apiKey);
                const content = await api.getDocContent(noteId);

                if (content) {
                    const filePath = `${this.plugin.settings.targetFolder}/分享笔记/${noteId}.md`;
                    const frontMatter = `---\nsource: IMA分享\nnote_id: "${noteId}"\nsync_time: "${new Date().toISOString()}"\n---\n\n`;
                    await this.plugin.saveFile(filePath, frontMatter + content);
                    new Notice('笔记同步成功！');
                } else {
                    new Notice('无法获取笔记内容，可能权限不足');
                }
            } catch (e) {
                new Notice('同步失败: ' + e.message);
            }
        };

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}

class NotebookNotesModal extends Modal {
    plugin: ImaPlugin;
    notebooks: any[];

    constructor(app: any, plugin: ImaPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: '加载笔记本...' });

        try {
            const api = new ImaApi(this.plugin.settings.clientId, this.plugin.settings.apiKey);
            this.notebooks = await api.listNotebooks();
            this.displayNotebooks();
        } catch (e) {
            contentEl.empty();
            contentEl.createEl('h2', { text: '加载失败' });
            contentEl.createEl('p', { text: '无法获取笔记本列表' });
        }
    }

    displayNotebooks() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: '笔记本笔记' });
        contentEl.createEl('p', { text: '这是你自己的笔记本笔记，可以正常同步' });

        if (!this.notebooks || this.notebooks.length === 0) {
            contentEl.createEl('p', { text: '未找到笔记本笔记' });
            return;
        }

        const selectedNotes = new Set<string>();

        for (const note of this.notebooks) {
            const noteDiv = contentEl.createDiv();
            noteDiv.style.marginBottom = '8px';

            const checkbox = noteDiv.createEl('input', { type: 'checkbox' });
            checkbox.style.marginRight = '8px';

            noteDiv.createEl('span', { text: note.title || '未命名' });

            checkbox.onchange = () => {
                if (checkbox.checked) {
                    selectedNotes.add(note.doc_id);
                } else {
                    selectedNotes.delete(note.doc_id);
                }
            };
        }

        const btnContainer = contentEl.createDiv();
        btnContainer.style.marginTop = '20px';

        const selectAllBtn = btnContainer.createEl('button', { text: '全选' });
        selectAllBtn.onclick = () => {
            this.notebooks.forEach(n => selectedNotes.add(n.doc_id));
            this.displayNotebooks();
        };

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => this.close();

        const syncBtn = btnContainer.createEl('button', { text: '同步选中', cls: 'mod-cta' });
        syncBtn.onclick = async () => {
            if (selectedNotes.size === 0) {
                new Notice('请选择要同步的笔记');
                return;
            }

            this.close();
            await this.syncSelectedNotes(Array.from(selectedNotes));
        };
    }

    async syncSelectedNotes(noteIds: string[]) {
        new Notice(`开始同步 ${noteIds.length} 个笔记...`);

        const api = new ImaApi(this.plugin.settings.clientId, this.plugin.settings.apiKey);
        let syncedCount = 0;

        for (const noteId of noteIds) {
            try {
                const content = await api.getDocContent(noteId);
                if (content) {
                    const filePath = `${this.plugin.settings.targetFolder}/我的笔记本/${noteId}.md`;
                    const frontMatter = `---\nsource: IMA笔记本\ndoc_id: "${noteId}"\nsync_time: "${new Date().toISOString()}"\n---\n\n`;
                    await this.plugin.saveFile(filePath, frontMatter + content);
                    syncedCount++;
                }
            } catch (e) {
                console.warn(`跳过: ${noteId}`, e);
            }
        }

        new Notice(`笔记本笔记同步完成！同步 ${syncedCount} 个`);
    }

    onClose() {
        this.contentEl.empty();
    }
}

class KnowledgeBaseModal extends Modal {
    plugin: ImaPlugin;
    knowledgeBases: any[];

    constructor(app: any, plugin: ImaPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        this.contentEl.createEl('h2', { text: '加载中...' });

        try {
            const api = new ImaApi(this.plugin.settings.clientId, this.plugin.settings.apiKey);
            this.knowledgeBases = await api.searchAllKnowledgeBases();
            this.displayKbs();
        } catch (e) {
            this.contentEl.empty();
            this.contentEl.createEl('h2', { text: '加载失败' });
            this.contentEl.createEl('p', { text: '请检查 API Key 是否正确' });
        }
    }

    displayKbs() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: '选择要同步的知识库' });
        contentEl.createEl('p', { text: '⚠️ 注意：知识库里的笔记可能需要权限才能读取' });

        if (!this.knowledgeBases || this.knowledgeBases.length === 0) {
            contentEl.createEl('p', { text: '未找到可用知识库' });
            return;
        }

        const selectedKbs = new Set(this.plugin.settings.selectedKbs);

        for (const kb of this.knowledgeBases) {
            const kbDiv = contentEl.createDiv();
            kbDiv.style.marginBottom = '8px';
            kbDiv.style.padding = '8px';
            kbDiv.style.borderBottom = '1px solid #eee';

            const checkbox = kbDiv.createEl('input', { type: 'checkbox' });
            checkbox.checked = selectedKbs.has(kb.kb_id);
            checkbox.style.marginRight = '8px';

            const label = kbDiv.createEl('span', { text: ` ${kb.kb_name} ` });
            label.style.fontWeight = 'bold';

            const roleLabel = kbDiv.createEl('span', {
                text: ` [${kb.role_type}]`,
                cls: 'setting-item-description'
            });

            if (kb.kb_desc) {
                kbDiv.createEl('p', { text: kb.kb_desc, cls: 'setting-item-description' });
            }

            checkbox.onchange = () => {
                if (checkbox.checked) {
                    selectedKbs.add(kb.kb_id);
                } else {
                    selectedKbs.delete(kb.kb_id);
                }
            };
        }

        const btnContainer = contentEl.createDiv();
        btnContainer.style.marginTop = '20px';

        const selectAllBtn = btnContainer.createEl('button', { text: '全选' });
        selectAllBtn.onclick = () => {
            this.knowledgeBases.forEach(kb => selectedKbs.add(kb.kb_id));
            this.displayKbs();
        };

        const cancelBtn = btnContainer.createEl('button', { text: '取消' });
        cancelBtn.onclick = () => this.close();

        const syncBtn = btnContainer.createEl('button', { text: '开始同步', cls: 'mod-cta' });
        syncBtn.onclick = async () => {
            const selected = Array.from(selectedKbs);
            if (selected.length === 0) {
                new Notice('请至少选择一个知识库');
                return;
            }

            this.plugin.settings.selectedKbs = selected;
            this.plugin.settings.selectedNotes = {};
            await this.plugin.saveSettings();
            this.close();
            this.plugin.syncAll(true, selected);
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

export default ImaPlugin;
