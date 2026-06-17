import { App, Notice } from 'obsidian';
import { ImaApi } from '../api/ima-api';
import { CacheManager } from './cache';
import {
  KnowledgeBase,
  KnowledgeItem,
  NotebookNote,
  PluginSettings,
  ProgressCallback,
  SyncMode,
  SyncProgress,
  SyncResult,
} from '../types';
import {
  buildFrontmatter,
  listMarkdownFilesRecursive,
  sanitizeFileName,
  saveMarkdownFile,
} from '../utils/file-utils';

const VERBOSE = true;
function log(...args: any[]) {
  if (VERBOSE) console.log('[IMA-Sync]', ...args);
}

/**
 * 同步管理器 v2.1
 *
 * 修复点:
 * 1. 每个关键步骤都有 Notice 提示(用户不会觉得"没反应")
 * 2. 知识库内容为空/权限不足时明确提示
 * 3. 增量同步全部跳过时显示"无需同步"
 * 4. 异常时显示具体错误信息
 */
export class SyncManager {
  private app: App;
  private api: ImaApi;
  private cache: CacheManager;
  private settings: PluginSettings;

  private running = false;
  private cancelRequested = false;
  private progressCb: ProgressCallback | null = null;

  constructor(app: App, api: ImaApi, cache: CacheManager, settings: PluginSettings) {
    this.app = app;
    this.api = api;
    this.cache = cache;
    this.settings = settings;
  }

  updateSettings(settings: PluginSettings) {
    this.settings = settings;
  }

  setProgressCallback(cb: ProgressCallback) {
    this.progressCb = cb;
  }

  isRunning(): boolean {
    return this.running;
  }

  cancel() {
    if (this.running) {
      this.cancelRequested = true;
      log('用户请求取消同步');
      this.emit({ ...this.emptyProgress(), phase: 'idle', cancelled: true });
    }
  }

  private emptyProgress(): SyncProgress {
    return {
      total: 0,
      current: 0,
      skipped: 0,
      failed: 0,
      synced: 0,
      currentTitle: '',
      phase: 'idle',
      cancelled: false,
    };
  }

  private emit(progress: SyncProgress) {
    if (this.progressCb) this.progressCb(progress);
  }

  private checkCancel(): boolean {
    return this.cancelRequested;
  }

  /**
   * 扫描目标文件夹下所有已同步的笔记
   */
  private buildLocalIndex(folder: string): Map<string, { path: string; syncTime: string }> {
    const index = new Map<string, { path: string; syncTime: string }>();
    try {
      const files = listMarkdownFilesRecursive(this.app, folder);
      log(`本地索引: 扫描到 ${files.length} 个 markdown 文件`);
      for (const file of files) {
        const cached = this.app.metadataCache.getFileCache(file);
        const fm = cached?.frontmatter;
        if (fm && (fm.media_id || fm.doc_id)) {
          const id = String(fm.media_id || fm.doc_id);
          const syncTime = String(fm.sync_time || '');
          index.set(id, { path: file.path, syncTime });
        }
      }
      log(`本地索引: ${index.size} 个已同步笔记`);
    } catch (e: any) {
      log(`本地索引构建失败: ${e.message}`);
    }
    return index;
  }

  /**
   * 同步知识库
   */
  async syncKnowledgeBases(
    selectedKbIds: string[] | null,
    mode: SyncMode
  ): Promise<SyncResult> {
    log(`syncKnowledgeBases 开始: mode=${mode}, selectedKbIds=${selectedKbIds?.length ?? 'null'}`);

    if (this.running) {
      new Notice('⚠️ 已有同步任务正在进行,请等待完成或取消后再试', 5000);
      return this.cancelledResult();
    }

    const startTime = Date.now();
    this.running = true;
    this.cancelRequested = false;

    const result: SyncResult = {
      synced: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      durationMs: 0,
      cancelled: false,
      errors: [],
    };

    try {
      const forceRefresh = mode === 'full';
      this.emit({ ...this.emptyProgress(), phase: 'listing', currentTitle: '加载知识库列表...' });

      log('步骤1: 加载知识库列表');
      const allKbs = await this.api.searchAllKnowledgeBases(forceRefresh);
      log(`获取到 ${allKbs.length} 个知识库`);

      let targetKbs: KnowledgeBase[];

      if (selectedKbIds && selectedKbIds.length > 0) {
        const idSet = new Set(selectedKbIds);
        targetKbs = allKbs.filter(kb => idSet.has(kb.kb_id));
      } else if (this.settings.selectedKbs.length > 0) {
        const idSet = new Set(this.settings.selectedKbs);
        targetKbs = allKbs.filter(kb => idSet.has(kb.kb_id));
      } else {
        targetKbs = allKbs;
      }

      log(`目标知识库: ${targetKbs.length} 个`);

      if (targetKbs.length === 0) {
        new Notice('❌ 未找到已选知识库。请先在"选择知识库"中勾选要同步的知识库。', 8000);
        return result;
      }

      // 关键: 开始同步时立即通知用户
      new Notice(`开始${mode === 'incremental' ? '增量' : '全量'}同步 ${targetKbs.length} 个知识库...`, 4000);

      const localIndex = this.buildLocalIndex(this.settings.targetFolder);

      let totalItems = 0;
      const kbItems: Array<{ kb: KnowledgeBase; items: KnowledgeItem[]; error?: string }> = [];

      // 步骤2: 逐个加载知识库内容
      log('步骤2: 加载各知识库内容列表');
      for (let i = 0; i < targetKbs.length; i++) {
        const kb = targetKbs[i];
        if (this.checkCancel()) break;

        const progressMsg = `[${i + 1}/${targetKbs.length}] 加载 "${kb.kb_name}" 内容...`;
        log(progressMsg);
        this.emit({
          ...this.emptyProgress(),
          phase: 'listing',
          currentTitle: progressMsg,
        });

        try {
          const items = await this.api.getAllKnowledgeList(kb.kb_id, forceRefresh);
          // 过滤:跳过文件夹(type=99)和明确不可获取内容的条目
          const realItems = items.filter(it => {
            if (it.media_type === 99) return false; // 文件夹
            if (it.can_fetch_content === false) return false; // API 明确说不可获取
            return true;
          });
          const skippedNoFetch = items.length - realItems.length - items.filter(it => it.media_type === 99).length;
          log(`  "${kb.kb_name}" -> 总${items.length}条, 可同步${realItems.length}条 (role=${kb.role_type || '未知'})`);
          if (skippedNoFetch > 0) log(`    (其中 ${skippedNoFetch} 条因 can_fetch_content=false 跳过)`);

          if (realItems.length === 0) {
            log(`  ⚠️ "${kb.kb_name}" 没有可同步的笔记 (可能权限不足或知识库为空)`);
          }

          kbItems.push({ kb, items: realItems });
          totalItems += realItems.length;
        } catch (e: any) {
          log(`  ❌ "${kb.kb_name}" 加载失败: ${e.message}`);
          kbItems.push({ kb, items: [], error: e.message });
          result.errors.push(`知识库"${kb.kb_name}"加载失败: ${e.message}`);
        }
      }

      result.total = totalItems;
      log(`步骤2完成: 共 ${totalItems} 个笔记待处理`);

      // 如果没有可同步的内容,明确告诉用户
      if (totalItems === 0) {
        const errorKbs = kbItems.filter(k => k.error).map(k => k.kb.kb_name);
        const emptyKbs = kbItems.filter(k => !k.error && k.items.length === 0).map(k => k.kb.kb_name);

        let msg = '同步完成: 没有找到可同步的笔记。\n';
        if (errorKbs.length > 0) msg += `\n加载失败的知识库: ${errorKbs.join(', ')}`;
        if (emptyKbs.length > 0) msg += `\n内容为空的知识库: ${emptyKbs.join(', ')}`;

        log(msg);
        new Notice(msg, 10000);

        this.emit({
          ...this.emptyProgress(),
          total: 0,
          phase: 'done',
          currentTitle: '无可同步内容',
        });
        return result;
      }

      // 步骤3: 逐个下载并保存
      log('步骤3: 下载并保存笔记内容');
      let processed = 0;

      for (const { kb, items, error } of kbItems) {
        if (this.checkCancel()) {
          result.cancelled = true;
          break;
        }
        if (error) continue;

        for (const item of items) {
          if (this.checkCancel()) {
            result.cancelled = true;
            break;
          }

          processed++;
          const title = item.title || '未命名';
          this.emit({
            total: totalItems,
            current: processed,
            skipped: result.skipped,
            failed: result.failed,
            synced: result.synced,
            currentTitle: `${kb.kb_name} / ${title}`,
            phase: 'downloading',
            cancelled: false,
          });

          const safeTitle = sanitizeFileName(title);
          const filePath = `${this.settings.targetFolder}/${kb.kb_name}/${safeTitle}.md`;

          // 增量判断
          if (mode === 'incremental') {
            const local = localIndex.get(item.media_id);
            if (local) {
              result.skipped++;
              log(`  跳过(已存在): ${title}`);
              this.emit({
                total: totalItems,
                current: processed,
                skipped: result.skipped,
                failed: result.failed,
                synced: result.synced,
                currentTitle: `${kb.kb_name} / ${title}`,
                phase: 'saving',
                cancelled: false,
              });
              continue;
            }
          }

          try {
            const contentResult = await this.api.getKnowledgeItemContent(
              item.media_id,
              item.media_type
            );
            if (contentResult.success && contentResult.data) {
              const frontMatter = buildFrontmatter({
                source: 'IMA知识库',
                kb_name: kb.kb_name || '未知',
                title: title,
                media_id: item.media_id,
                media_type: item.media_type,
                sync_time: new Date().toISOString(),
              });
              await saveMarkdownFile(this.app, filePath, frontMatter + contentResult.data);
              result.synced++;
              log(`  ✅ 已同步: ${title}`);
            } else {
              result.failed++;
              result.errors.push(`${title}: ${contentResult.error}`);
              log(`  ❌ 失败: ${title} - ${contentResult.error}`);
            }
          } catch (e: any) {
            result.failed++;
            result.errors.push(`${title}: ${e.message}`);
            log(`  ❌ 异常: ${title} - ${e.message}`);
          }

          this.emit({
            total: totalItems,
            current: processed,
            skipped: result.skipped,
            failed: result.failed,
            synced: result.synced,
            currentTitle: `${kb.kb_name} / ${title}`,
            phase: 'saving',
            cancelled: false,
          });
        }
      }

      this.settings.lastSyncTime = new Date().toISOString();

      // 最终汇总
      let summary = `同步完成: ✅${result.synced} 同步`;
      if (result.skipped > 0) summary += `, ⏭️${result.skipped} 跳过`;
      if (result.failed > 0) summary += `, ❌${result.failed} 失败`;
      if (result.cancelled) summary = `已取消: ✅${result.synced} 已同步`;

      log(`最终结果: ${summary} (耗时 ${(Date.now() - startTime) / 1000}s)`);

      // 增量同步全部跳过时的特殊提示
      if (mode === 'incremental' && result.synced === 0 && result.skipped > 0 && result.failed === 0) {
        new Notice(`✅ 增量同步完成: 本地已有全部 ${result.skipped} 篇笔记,无需重新拉取。如需强制刷新请用"全量同步"。`, 8000);
      } else {
        new Notice(summary, 6000);
      }

      this.emit({
        total: totalItems,
        current: processed,
        skipped: result.skipped,
        failed: result.failed,
        synced: result.synced,
        currentTitle: '',
        phase: 'done',
        cancelled: result.cancelled,
      });
    } catch (e: any) {
      log(`同步异常: ${e.message}`);
      console.error('[IMA-Sync] 同步异常:', e);
      result.errors.push(`同步异常: ${e.message}`);

      // 根据错误类型给不同的提示
      const msg = e.message || '';
      if (msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('unauthorized')) {
        new Notice('❌ API Key 可能已过期或无效,请到 https://ima.qq.com/agent-interface 重新获取', 10000);
      } else if (msg.includes('429') || msg.toLowerCase().includes('rate') || msg.toLowerCase().includes('limit')) {
        new Notice('❌ API 被限流,请等 1-2 分钟后重试', 10000);
      } else {
        new Notice(`❌ 同步失败: ${msg}`, 10000);
      }
    } finally {
      result.durationMs = Date.now() - startTime;
      this.running = false;
      this.cancelRequested = false;
      log(`同步结束, running=false, 耗时=${result.durationMs}ms`);
    }

    return result;
  }

  /**
   * 同步笔记本笔记
   */
  async syncNotebookNotes(
    noteIds: string[] | null,
    mode: SyncMode
  ): Promise<SyncResult> {
    log(`syncNotebookNotes 开始: mode=${mode}`);

    if (this.running) {
      new Notice('⚠️ 已有同步任务正在进行', 5000);
      return this.cancelledResult();
    }

    const startTime = Date.now();
    this.running = true;
    this.cancelRequested = false;

    const result: SyncResult = {
      synced: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      durationMs: 0,
      cancelled: false,
      errors: [],
    };

    try {
      this.emit({ ...this.emptyProgress(), phase: 'listing', currentTitle: '加载笔记本列表...' });

      const forceRefresh = mode === 'full';
      const allNotes: NotebookNote[] = await this.api.listNotebooks(forceRefresh);
      log(`获取到 ${allNotes.length} 个笔记本笔记`);

      let targetNotes: NotebookNote[];
      if (noteIds && noteIds.length > 0) {
        const idSet = new Set(noteIds);
        targetNotes = allNotes.filter(n => idSet.has(n.doc_id));
      } else {
        targetNotes = allNotes;
      }

      result.total = targetNotes.length;
      new Notice(`开始同步 ${targetNotes.length} 个笔记本笔记...`, 4000);

      const localIndex = this.buildLocalIndex(`${this.settings.targetFolder}/我的笔记本`);

      let processed = 0;
      for (const note of targetNotes) {
        if (this.checkCancel()) {
          result.cancelled = true;
          break;
        }
        processed++;
        const title = note.title || '未命名';
        this.emit({
          total: targetNotes.length,
          current: processed,
          skipped: result.skipped,
          failed: result.failed,
          synced: result.synced,
          currentTitle: title,
          phase: 'downloading',
          cancelled: false,
        });

        if (mode === 'incremental' && localIndex.has(note.doc_id)) {
          result.skipped++;
          log(`  跳过(已存在): ${title}`);
          continue;
        }

        try {
          const contentResult = await this.api.getDocContent(note.doc_id);
          if (contentResult.success && contentResult.data) {
            const filePath = `${this.settings.targetFolder}/我的笔记本/${sanitizeFileName(note.doc_id)}.md`;
            const frontMatter = buildFrontmatter({
              source: 'IMA笔记本',
              doc_id: note.doc_id,
              title: title,
              sync_time: new Date().toISOString(),
            });
            await saveMarkdownFile(this.app, filePath, frontMatter + contentResult.data);
            result.synced++;
            log(`  ✅ 已同步: ${title}`);
          } else {
            result.failed++;
            result.errors.push(`${title}: ${contentResult.error}`);
            log(`  ❌ 失败: ${title}`);
          }
        } catch (e: any) {
          result.failed++;
          result.errors.push(`${title}: ${e.message}`);
        }
      }

      let summary = `笔记本同步完成: ✅${result.synced}`;
      if (result.skipped > 0) summary += `, ⏭️${result.skipped} 跳过`;
      if (result.failed > 0) summary += `, ❌${result.failed} 失败`;
      new Notice(summary, 6000);

      this.emit({
        total: targetNotes.length,
        current: processed,
        skipped: result.skipped,
        failed: result.failed,
        synced: result.synced,
        currentTitle: '',
        phase: 'done',
        cancelled: result.cancelled,
      });
    } catch (e: any) {
      log(`笔记本同步异常: ${e.message}`);
      result.errors.push(`笔记本同步异常: ${e.message}`);
      new Notice(`❌ 笔记本同步失败: ${e.message}`, 8000);
    } finally {
      result.durationMs = Date.now() - startTime;
      this.running = false;
      this.cancelRequested = false;
    }

    return result;
  }

  /**
   * 同步单条分享链接笔记
   */
  async syncShareNote(noteId: string): Promise<SyncResult> {
    log(`syncShareNote 开始: noteId=${noteId}`);

    const startTime = Date.now();
    const result: SyncResult = {
      synced: 0,
      skipped: 0,
      failed: 0,
      total: 1,
      durationMs: 0,
      cancelled: false,
      errors: [],
    };

    try {
      new Notice(`正在获取笔记 ${noteId}...`, 4000);
      this.emit({
        ...this.emptyProgress(),
        total: 1,
        phase: 'downloading',
        currentTitle: noteId,
      });

      const contentResult = await this.api.getDocContent(noteId);
      if (contentResult.success && contentResult.data) {
        const filePath = `${this.settings.targetFolder}/分享笔记/${sanitizeFileName(noteId)}.md`;
        const frontMatter = buildFrontmatter({
          source: 'IMA分享',
          note_id: noteId,
          sync_time: new Date().toISOString(),
        });
        await saveMarkdownFile(this.app, filePath, frontMatter + contentResult.data);
        result.synced++;
        new Notice('✅ 分享笔记同步成功!', 5000);
        log('分享笔记同步成功');
      } else {
        result.failed++;
        result.errors.push(contentResult.error || '未知错误');
        new Notice(`❌ 获取笔记失败: ${contentResult.error}`, 8000);
        log(`分享笔记失败: ${contentResult.error}`);
      }
      this.emit({ ...this.emptyProgress(), total: 1, synced: result.synced, phase: 'done' });
    } catch (e: any) {
      result.failed++;
      result.errors.push(e.message);
      new Notice(`❌ 同步异常: ${e.message}`, 8000);
      log(`分享笔记异常: ${e.message}`);
    } finally {
      result.durationMs = Date.now() - startTime;
    }
    return result;
  }

  private cancelledResult(): SyncResult {
    return {
      synced: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      durationMs: 0,
      cancelled: true,
      errors: ['已有同步任务正在进行'],
    };
  }
}
