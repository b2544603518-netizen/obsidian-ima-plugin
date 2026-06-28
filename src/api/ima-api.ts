import { requestUrl } from 'obsidian';
import {
  ApiResult,
  KnowledgeBase,
  KnowledgeItem,
  NotebookNote,
} from '../types';
import { CacheManager } from '../core/cache';

const VERBOSE = true;
function log(...args: any[]) {
  if (VERBOSE) console.log('[IMA-API]', ...args);
}

/**
 * IMA OpenAPI 客户端
 *
 * 核心优化点:
 * 1. QPS 节流:串行化请求队列,控制每秒请求数(默认 2 QPS),避免触发限流
 * 2. 指数退避重试:对 429/网络错误自动重试(默认 3 次),退避时间 1s → 2s → 4s
 * 3. 缓存集成:列表类数据(知识库、知识库内容、笔记本)优先走缓存
 * 4. 请求去重:同一 key 的在途请求复用,避免并发重复拉取
 * 5. 超时控制:每个请求带超时,避免无限挂起
 *
 * 关键 API 知识(v2.1.5 官方文档确认):
 * - 笔记本笔记:用 note/v1/get_doc_content (doc_id) 获取内容 ✓
 * - 知识库笔记:先调 wiki/v1/get_media_info (media_id) 获取元数据
 *   - 若 media_type=11 且有 notebook_ext_info.notebook_id → 用 notebook_id 调 get_doc_content
 *   - 若 url_info.url 非空 → 下载该 URL
 *   - ⚠️ fetch_media_content 端点不存在!之前用的端点是错的!
 * - get_knowledge_list 只返回当前层级,文件夹内内容需要用 folder_id 递归拉取
 * - 文件夹的 media_id (如 folder_xxx) 本身就是 folder_id,用于递归调用
 */
export class ImaApi {
  clientId: string;
  apiKey: string;
  private cache: CacheManager;
  private qpsLimit: number;
  private maxRetries: number;
  private requestTimeoutMs: number;

  private wikiBaseUrl = 'https://ima.qq.com/openapi/wiki/v1';
  private noteBaseUrl = 'https://ima.qq.com/openapi/note/v1';

  private lastRequestTime = 0;
  private minIntervalMs: number;
  private inflight: Map<string, Promise<any>> = new Map();

  constructor(
    clientId: string,
    apiKey: string,
    cache: CacheManager,
    opts: { qpsLimit?: number; maxRetries?: number; requestTimeoutMs?: number } = {}
  ) {
    this.clientId = clientId;
    this.apiKey = apiKey;
    this.cache = cache;
    this.qpsLimit = opts.qpsLimit ?? 2;
    this.maxRetries = opts.maxRetries ?? 3;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30000;
    this.minIntervalMs = Math.ceil(1000 / this.qpsLimit);
  }

  configure(opts: { qpsLimit?: number; maxRetries?: number; requestTimeoutMs?: number }) {
    if (opts.qpsLimit !== undefined) {
      this.qpsLimit = opts.qpsLimit;
      this.minIntervalMs = Math.ceil(1000 / this.qpsLimit);
    }
    if (opts.maxRetries !== undefined) this.maxRetries = opts.maxRetries;
    if (opts.requestTimeoutMs !== undefined) this.requestTimeoutMs = opts.requestTimeoutMs;
  }

  /**
   * 节流:确保两次请求间隔不小于 minIntervalMs
   */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await this.sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private buildKey(baseUrl: string, endpoint: string, data: any): string {
    return `${baseUrl}/${endpoint}:${JSON.stringify(data)}`;
  }

  /**
   * 判断是否为限流/可重试错误
   */
  private isRetryable(status: number, msg: string): boolean {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    const lower = (msg || '').toLowerCase();
    if (lower.includes('rate') || lower.includes('limit') || lower.includes('throttl')) return true;
    if (lower.includes('timeout') || lower.includes('network')) return true;
    return false;
  }

  /**
   * 带节流 + 重试的核心请求方法
   */
  private async request(baseUrl: string, endpoint: string, data: any = {}): Promise<any> {
    const key = this.buildKey(baseUrl, endpoint, data);
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const promise = this.doRequestWithRetry(baseUrl, endpoint, data)
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private async doRequestWithRetry(baseUrl: string, endpoint: string, data: any): Promise<any> {
    let lastError: Error = new Error('未知错误');
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        await this.sleep(backoff);
      }

      await this.throttle();

      try {
        const resp = await requestUrl({
          url: `${baseUrl}/${endpoint}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'ima-openapi-clientid': this.clientId,
            'ima-openapi-apikey': this.apiKey,
          },
          body: JSON.stringify(data),
          throw: false,
        });

        const status = resp.status ?? 200;
        const json = resp.json;

        if (status === 429) {
          lastError = new Error(`[${endpoint}] 请求过于频繁,已被限流 (429)`);
          continue;
        }

        if (status >= 500) {
          lastError = new Error(`[${endpoint}] 服务器错误 (${status})`);
          continue;
        }

        if (!json) {
          lastError = new Error(`[${endpoint}] 响应解析失败`);
          continue;
        }

        if (json.code !== 0) {
          throw new Error(`[${endpoint}] ${json.msg || '业务错误 (code=' + json.code + ')'}`);
        }

        return json.data;
      } catch (e: any) {
        if (e.message && this.isRetryable(0, e.message)) {
          lastError = e;
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }

  // ===== 知识库列表(带缓存) =====
  async searchAllKnowledgeBases(forceRefresh: boolean = false): Promise<KnowledgeBase[]> {
    const cached = this.cache.getKnowledgeBases(forceRefresh);
    if (cached) return cached;

    const allKbs: KnowledgeBase[] = [];
    let cursor = '';

    while (true) {
      const data = await this.request(this.wikiBaseUrl, 'search_knowledge_base', {
        query: '',
        cursor,
        limit: 20,
      });
      const kbs = data?.info_list || [];
      if (kbs.length === 0) break;
      allKbs.push(...kbs);
      if (data.is_end) break;
      cursor = data.next_cursor || '';
      if (!cursor) break;
    }

    this.cache.setKnowledgeBases(allKbs);
    return allKbs;
  }

  // ===== 知识库内容列表(带缓存,按 kbId 分别缓存,递归拉取文件夹) =====
  // 关键发现: get_knowledge_list 只返回当前层级
  // 文件夹(media_type=99)内的内容需要用 folder_id 参数再次调用
  // 返回结构: data.knowledge_list[].{media_id, media_type, title, folder_info.folder_id, can_fetch_content, ...}
  async getAllKnowledgeList(kbId: string, forceRefresh: boolean = false): Promise<KnowledgeItem[]> {
    const cached = this.cache.getKnowledgeList(kbId, forceRefresh);
    if (cached && cached.every(item => Object.prototype.hasOwnProperty.call(item, 'folderPath'))) {
      return cached;
    }

    // 从根目录开始递归拉取,并保留 IMA 内部文件夹路径
    const allItems = await this.fetchKnowledgeListRecursive(kbId, '', new Set<string>(), '');
    this.cache.setKnowledgeList(kbId, allItems);
    return allItems;
  }

  /**
   * 递归拉取知识库内容列表
   * @param kbId 知识库 ID
   * @param folderId 文件夹 ID(空字符串=根目录)
   * @param visited 已访问的文件夹 ID(防止循环)
   */
  private async fetchKnowledgeListRecursive(
    kbId: string,
    folderId: string,
    visited: Set<string>,
    currentPath: string
  ): Promise<KnowledgeItem[]> {
    if (visited.has(folderId)) {
      console.warn('[IMA] 检测到文件夹循环,跳过:', folderId);
      return [];
    }
    visited.add(folderId);

    const items: KnowledgeItem[] = [];
    let cursor = '';

    while (true) {
      const requestData: any = {
        knowledge_base_id: kbId,
        cursor,
        limit: 50,
      };
      if (folderId) {
        requestData.folder_id = folderId;
      }

      const data = await this.request(this.wikiBaseUrl, 'get_knowledge_list', requestData);

      // 兼容两种可能的字段名:knowledge_list(REST API) 或 note_book_list
      const rawItems: any[] = data?.knowledge_list || data?.note_book_list || [];
      if (rawItems.length === 0) break;

      for (const raw of rawItems) {
        const item: KnowledgeItem = {
          media_id: raw.media_id || raw.docid || '',
          media_type: raw.media_type !== undefined ? raw.media_type : 0,
          title: raw.title || '未命名',
          folderPath: currentPath,
        };

        // 保存额外信息供同步逻辑使用
        // 关键: 文件夹的 media_id (如 folder_xxx) 本身就是 folder_id,用于递归
        (item as any).can_fetch_content = raw.can_fetch_content;
        (item as any).folder_id = raw.folder_info?.folder_id || raw.folder_id || '';
        (item as any).parent_folder_id = raw.parent_folder_id || '';
        (item as any).file_size = raw.file_size || '0';
        (item as any).create_time = raw.create_time ? parseInt(raw.create_time, 10) : undefined;
        (item as any).update_time = raw.create_time ? parseInt(raw.create_time, 10) : undefined;
        // 如果是文件夹,保存 notebook_ext_info 等 get_media_info 需要的元数据
        if (raw.notebook_ext_info) (item as any).notebook_ext_info = raw.notebook_ext_info;
        if (raw.url_info) (item as any).url_info = raw.url_info;

        if (!item.media_id) continue;
        items.push(item);

        // 如果是文件夹(media_type=99),用 media_id 作为 folder_id 递归拉取子内容
        // 官方文档: folder_id 始终以 folder_ 前缀开头,文件夹的 media_id 就是 folder_id
        if (item.media_type === 99 && item.media_id && item.media_id.startsWith('folder_')) {
          log(`递归拉取文件夹: ${item.title} (folder_id=${item.media_id})`);
          try {
            const childPath = currentPath ? `${currentPath}/${item.title}` : item.title;
            const subItems = await this.fetchKnowledgeListRecursive(
              kbId,
              item.media_id,  // ← 用 media_id 作为 folder_id
              visited,
              childPath
            );
            items.push(...subItems);
            log(`  文件夹 "${item.title}" 内有 ${subItems.length} 个条目`);
          } catch (e: any) {
            console.warn(`[IMA] 拉取文件夹 "${item.title}" 失败:`, e.message);
          }
        }
      }

      if (data.is_end) break;
      cursor = data.next_cursor || '';
      if (!cursor) break;
    }

    return items;
  }

  // ===== 笔记正文(不缓存,由 SyncManager 决定是否需要拉取) =====
  async getDocContent(docId: string): Promise<ApiResult<string>> {
    try {
      const data = await this.request(this.noteBaseUrl, 'get_doc_content', {
        doc_id: docId,
        target_content_format: 1,
      });
      if (data?.content) {
        return { success: true, data: data.content };
      }
      return { success: false, error: '内容为空' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async exportMedia(mediaId: string): Promise<ApiResult<string>> {
    try {
      const data = await this.request(this.wikiBaseUrl, 'export_media_for_ima_sandbox', {
        media_id: mediaId,
      });
      const downloadUrl = data?.media_content_url_info?.url;
      if (!downloadUrl) {
        return { success: false, error: '无下载链接' };
      }
      const resp = await requestUrl({ url: downloadUrl, method: 'GET', throw: false });
      return { success: true, data: resp.text };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 获取媒体详情 (v2.1.5 重写)
   *
   * 官方文档确认: openapi/wiki/v1 下没有 fetch_media_content 端点!
   * 正确端点是 get_media_info,返回媒体元数据,根据元数据决定如何获取正文:
   *   - media_type=11 (NOTE) 且 notebook_ext_info.notebook_id 存在
   *       → 用 notebook_id 作为 doc_id 调用 note/v1/get_doc_content
   *   - url_info.url 非空 → 下载该 URL
   *   - 否则 → 无法获取内容(提示用户用 IMA 客户端查看)
   */
  async getMediaInfo(mediaId: string): Promise<ApiResult<any>> {
    try {
      const data = await this.request(this.wikiBaseUrl, 'get_media_info', {
        media_id: mediaId,
      });
      if (data) {
        return { success: true, data };
      }
      return { success: false, error: 'get_media_info 返回空' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 通过 URL 下载内容
   */
  private async downloadUrlContent(url: string, headers?: any): Promise<ApiResult<string>> {
    try {
      const resp = await requestUrl({
        url,
        method: 'GET',
        headers: headers || {},
        throw: false,
      });
      if (resp.text && resp.text.trim().length > 0) {
        return { success: true, data: resp.text };
      }
      return { success: false, error: 'URL 下载内容为空' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 获取知识库笔记/文件内容 — 统一入口 (v2.1.5 重写)
   *
   * ⚠️ 重大修复: fetch_media_content 端点不存在! 改用官方文档确认的 get_media_info
   *
   * IMA MediaType 枚举:
   *   11 = NOTE (知识库中添加的笔记)
   *   99 = FOLDER (文件夹,应跳过)
   *   其他 = PDF/WORD/PPT/EXCEL/MARKDOWN/IMG/TXT 等文件类型
   *
   * 官方文档确认的正确流程:
   *   1. 调 get_media_info(media_id) 获取媒体元数据
   *   2. 根据 media_type 分支:
   *      a. media_type=11 且 notebook_ext_info.notebook_id 存在
   *         → 用 notebook_id 作为 doc_id 调 get_doc_content
   *      b. url_info.url 非空 → 下载该 URL 内容
   *      c. 两者都没有 → 无法获取(提示用 IMA 客户端查看)
   *   3. 兜底: 直接尝试 get_doc_content(media_id) — 某些笔记 media_id 可直接当 doc_id
   */
  async getKnowledgeItemContent(
    mediaId: string,
    mediaType: number
  ): Promise<ApiResult<string>> {
    log(`获取内容: ${mediaId} (type=${mediaType})`);

    // 步骤1: 调 get_media_info 获取元数据
    const infoResult = await this.getMediaInfo(mediaId);
    if (!infoResult.success || !infoResult.data) {
      log(`  get_media_info 失败: ${infoResult.error}, 尝试直接 get_doc_content`);
      // 兜底: 直接尝试 get_doc_content
      const docResult = await this.getDocContent(mediaId);
      if (docResult.success && docResult.data && docResult.data.trim().length > 0) {
        log(`  ✅ 兜底 get_doc_content 成功 (${docResult.data.length} 字符)`);
        return docResult;
      }
      return { success: false, error: `get_media_info 失败: ${infoResult.error}` };
    }

    const info = infoResult.data;
    log(`  get_media_info 成功: media_type=${info.media_type}, has_notebook_ext=${!!info.notebook_ext_info}, has_url_info=${!!info.url_info}`);

    // 步骤2a: 笔记类型 — 用 notebook_id 调 get_doc_content
    const effectiveMediaType = info.media_type !== undefined ? info.media_type : mediaType;
    if (effectiveMediaType === 11 && info.notebook_ext_info?.notebook_id) {
      const notebookId = info.notebook_ext_info.notebook_id;
      log(`  笔记类型,用 notebook_id=${notebookId} 调 get_doc_content`);
      const docResult = await this.getDocContent(notebookId);
      if (docResult.success && docResult.data && docResult.data.trim().length > 0) {
        log(`  ✅ get_doc_content(notebook_id) 成功 (${docResult.data.length} 字符)`);
        return docResult;
      }
      log(`  get_doc_content(notebook_id) 失败: ${docResult.error}, 尝试用 media_id`);

      // 再试一次用 media_id 本身
      const docResult2 = await this.getDocContent(mediaId);
      if (docResult2.success && docResult2.data && docResult2.data.trim().length > 0) {
        log(`  ✅ get_doc_content(media_id) 成功 (${docResult2.data.length} 字符)`);
        return docResult2;
      }
    }

    // 步骤2b: URL 类型 — 下载 URL 内容
    if (info.url_info?.url) {
      log(`  URL 类型,下载: ${info.url_info.url.substring(0, 80)}...`);
      const urlResult = await this.downloadUrlContent(
        info.url_info.url,
        info.url_info.headers
      );
      if (urlResult.success && urlResult.data && urlResult.data.trim().length > 0) {
        log(`  ✅ URL 下载成功 (${urlResult.data.length} 字符)`);
        return urlResult;
      }
      log(`  URL 下载失败: ${urlResult.error}`);
    }

    // 步骤2c: 兜底 — 直接用 media_id 调 get_doc_content
    log(`  尝试兜底: 直接 get_doc_content(media_id)`);
    const fallbackResult = await this.getDocContent(mediaId);
    if (fallbackResult.success && fallbackResult.data && fallbackResult.data.trim().length > 0) {
      log(`  ✅ 兜底 get_doc_content 成功 (${fallbackResult.data.length} 字符)`);
      return fallbackResult;
    }

    // 所有方式都失败
    log(`  ❌ 所有获取方式均失败`);
    return {
      success: false,
      error: `无法获取内容: get_media_info 无 notebook_id 也无 url_info,且 get_doc_content 失败: ${fallbackResult.error}`,
    };
  }

  // ===== 笔记本列表(带缓存) =====
  // IMA OpenAPI list_note_by_folder_id 返回结构:
  //   data.note_book_list[].basic_info.basic_info.{docid,title,summary,folder_id,...}
  // 首次 cursor 必须传空字符串 "",folder_id 为空表示全部笔记本
  async listNotebooks(forceRefresh: boolean = false): Promise<NotebookNote[]> {
    const cached = this.cache.getNotebooks(forceRefresh);
    if (cached) return cached;

    const notebooks: NotebookNote[] = [];
    let cursor = '';

    while (true) {
      try {
        const data = await this.request(this.noteBaseUrl, 'list_note_by_folder_id', {
          folder_id: '',
          cursor,
          limit: 20,
        });

        // 真实返回结构: data.note_book_list[].basic_info.basic_info
        const rawList: any[] = data?.note_book_list || [];
        if (rawList.length === 0) break;

        for (const entry of rawList) {
          // 兼容两种可能的结构:嵌套或扁平
          const info = entry?.basic_info?.basic_info || entry?.basic_info || entry;
          const docid = info?.docid || info?.doc_id || '';
          if (!docid) continue;
          notebooks.push({
            doc_id: docid,
            title: info?.title || '未命名',
            update_time: info?.modify_time,
            create_time: info?.create_time,
          });
        }

        if (data.is_end) break;
        const nextCursor = data.next_cursor || '';
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      } catch (e) {
        console.warn('[IMA] listNotebooks 分页失败:', e);
        break;
      }
    }

    this.cache.setNotebooks(notebooks);
    return notebooks;
  }
}
