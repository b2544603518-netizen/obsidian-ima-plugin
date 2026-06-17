/**
 * 插件设置类型定义
 */
export interface PluginSettings {
  clientId: string;
  apiKey: string;
  targetFolder: string;
  lastSyncTime: string;
  selectedKbs: string[];
  selectedNotes: Record<string, boolean>;

  cacheTtlMinutes: number;
  qpsLimit: number;
  enableIncrementalSync: boolean;
  syncIntervalMinutes: number;
  autoSync: boolean;
  maxRetries: number;
  requestTimeoutMs: number;
}

/**
 * 缓存条目
 */
export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

/**
 * 缓存存储结构
 */
export interface CacheStore {
  knowledgeBases?: CacheEntry<KnowledgeBase[]>;
  knowledgeLists?: Record<string, CacheEntry<KnowledgeItem[]>>;
  notebooks?: CacheEntry<NotebookNote[]>;
  noteContents?: Record<string, CacheEntry<string>>;
}

/**
 * IMA 知识库信息
 */
export interface KnowledgeBase {
  kb_id: string;
  kb_name: string;
  kb_desc?: string;
  role_type?: string;
}

/**
 * IMA 知识库条目
 */
export interface KnowledgeItem {
  media_id: string;
  media_type: number;
  title: string;
  update_time?: number;
  create_time?: number;
  /** 是否可以获取内容(来自 API,文件夹=false,笔记=true) */
  can_fetch_content?: boolean;
  /** 文件夹 ID(如果是文件夹) */
  folder_id?: string;
  parent_folder_id?: string;
  file_size?: string;
}

/**
 * IMA 笔记本笔记
 */
export interface NotebookNote {
  doc_id: string;
  title: string;
  update_time?: number;
  create_time?: number;
}

/**
 * 文件保存结果
 */
export interface SaveResult {
  success: boolean;
  path: string;
  error?: string;
}

/**
 * 同步进度信息
 */
export interface SyncProgress {
  total: number;
  current: number;
  skipped: number;
  failed: number;
  synced: number;
  currentTitle: string;
  phase: 'listing' | 'downloading' | 'saving' | 'done' | 'idle';
  cancelled: boolean;
}

/**
 * 同步结果汇总
 */
export interface SyncResult {
  synced: number;
  skipped: number;
  failed: number;
  total: number;
  durationMs: number;
  cancelled: boolean;
  errors: string[];
}

/**
 * API 请求结果
 */
export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  rateLimited?: boolean;
}

/**
 * 同步模式
 */
export type SyncMode = 'incremental' | 'full';

/**
 * 同步进度回调
 */
export type ProgressCallback = (progress: SyncProgress) => void;
