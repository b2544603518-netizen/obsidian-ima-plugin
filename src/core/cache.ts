import { CacheStore, CacheEntry, KnowledgeBase, KnowledgeItem, NotebookNote } from '../types';

/**
 * 本地缓存层
 *
 * 设计目标:
 * 1. 减少对 IMA API 的重复调用(知识库列表、知识库内容列表、笔记本列表)
 * 2. 带 TTL 过期,默认 30 分钟,可在设置中调整
 * 3. 支持手动清除
 * 4. 缓存数据持久化到插件 data 中(随 settings 一起保存),重启不丢失
 *
 * 注意:笔记正文不缓存(正文可能很长且会变化),只缓存列表类数据。
 * 笔记正文的"是否需要重新拉取"由 SyncManager 基于本地文件的 sync_time 判断。
 */
export class CacheManager {
  private store: CacheStore = {};
  private defaultTtl: number;

  constructor(defaultTtlMinutes: number = 30) {
    this.defaultTtl = defaultTtlMinutes * 60 * 1000;
  }

  setDefaultTtl(minutes: number) {
    this.defaultTtl = minutes * 60 * 1000;
  }

  loadFrom(data: CacheStore) {
    this.store = data || {};
  }

  export(): CacheStore {
    return this.store;
  }

  private isFresh(entry: CacheEntry<any> | undefined): boolean {
    if (!entry) return false;
    return Date.now() - entry.timestamp < entry.ttl;
  }

  getKnowledgeBases(forceRefresh: boolean = false): KnowledgeBase[] | null {
    if (forceRefresh) return null;
    const entry = this.store.knowledgeBases;
    if (this.isFresh(entry)) {
      return entry!.data;
    }
    return null;
  }

  setKnowledgeBases(data: KnowledgeBase[], ttl?: number) {
    this.store.knowledgeBases = {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTtl,
    };
  }

  getKnowledgeList(kbId: string, forceRefresh: boolean = false): KnowledgeItem[] | null {
    if (forceRefresh) return null;
    const entry = this.store.knowledgeLists?.[kbId];
    if (this.isFresh(entry)) {
      return entry!.data;
    }
    return null;
  }

  setKnowledgeList(kbId: string, data: KnowledgeItem[], ttl?: number) {
    if (!this.store.knowledgeLists) this.store.knowledgeLists = {};
    this.store.knowledgeLists[kbId] = {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTtl,
    };
  }

  getNotebooks(forceRefresh: boolean = false): NotebookNote[] | null {
    if (forceRefresh) return null;
    const entry = this.store.notebooks;
    if (this.isFresh(entry)) {
      return entry!.data;
    }
    return null;
  }

  setNotebooks(data: NotebookNote[], ttl?: number) {
    this.store.notebooks = {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTtl,
    };
  }

  clearAll() {
    this.store = {};
  }

  clearKnowledgeBases() {
    delete this.store.knowledgeBases;
  }

  clearKnowledgeLists() {
    this.store.knowledgeLists = {};
  }

  clearNotebooks() {
    delete this.store.notebooks;
  }

  getStats(): { totalEntries: number; oldestAge: number } {
    const timestamps: number[] = [];
    if (this.store.knowledgeBases) timestamps.push(this.store.knowledgeBases.timestamp);
    if (this.store.notebooks) timestamps.push(this.store.notebooks.timestamp);
    if (this.store.knowledgeLists) {
      for (const k of Object.keys(this.store.knowledgeLists)) {
        timestamps.push(this.store.knowledgeLists[k].timestamp);
      }
    }
    const now = Date.now();
    return {
      totalEntries: timestamps.length,
      oldestAge: timestamps.length > 0 ? now - Math.min(...timestamps) : 0,
    };
  }
}
