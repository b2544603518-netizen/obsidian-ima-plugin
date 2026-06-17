import { App, TFile, TFolder, normalizePath } from 'obsidian';

/**
 * 文件工具:文件夹创建、安全文件名、frontmatter 读写
 */

export function sanitizeFileName(name: string, maxLen: number = 100): string {
  const safe = (name || '未命名').replace(/[/\\:*?"<>|]/g, '_').trim();
  return safe.substring(0, maxLen) || '未命名';
}

export async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  const parts = normalized.split('/').filter(p => p.length > 0);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current);
    } else if (existing instanceof TFile) {
      throw new Error(`路径 ${current} 已被文件占用,无法创建文件夹`);
    }
  }
}

export async function saveMarkdownFile(
  app: App,
  filePath: string,
  content: string
): Promise<void> {
  const normalized = normalizePath(filePath);
  const folderPath = normalized.split('/').slice(0, -1).join('/');
  if (folderPath) {
    await ensureFolderExists(app, folderPath);
  }
  const existing = app.vault.getAbstractFileByPath(normalized);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, content);
  } else {
    await app.vault.create(normalized, content);
  }
}

/**
 * 从 markdown 内容中解析 frontmatter
 */
export interface ParsedFrontmatter {
  frontmatter: Record<string, any>;
  body: string;
  hasFrontmatter: boolean;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const result: ParsedFrontmatter = {
    frontmatter: {},
    body: content,
    hasFrontmatter: false,
  };

  if (!content.startsWith('---\n')) return result;

  const endIdx = content.indexOf('\n---\n', 4);
  if (endIdx === -1) return result;

  const fmText = content.substring(4, endIdx);
  result.body = content.substring(endIdx + 5);
  result.hasFrontmatter = true;

  for (const line of fmText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value: any = line.substring(colonIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value === 'true') {
      value = true;
    } else if (value === 'false') {
      value = false;
    } else if (/^-?\d+$/.test(value)) {
      value = parseInt(value, 10);
    }
    result.frontmatter[key] = value;
  }

  return result;
}

/**
 * 构造 frontmatter 字符串
 */
export function buildFrontmatter(fields: Record<string, any>): string {
  let out = '---\n';
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      const escaped = value.replace(/"/g, '\\"');
      out += `${key}: "${escaped}"\n`;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out += `${key}: ${value}\n`;
    } else {
      out += `${key}: "${String(value)}"\n`;
    }
  }
  out += '---\n\n';
  return out;
}

/**
 * 列出某个文件夹下的所有 markdown 文件
 */
export function listMarkdownFilesInFolder(app: App, folderPath: string): TFile[] {
  const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
  if (!(folder instanceof TFolder)) return [];
  const files: TFile[] = [];
  for (const f of folder.children) {
    if (f instanceof TFile && f.extension === 'md') {
      files.push(f);
    }
  }
  return files;
}

/**
 * 递归列出文件夹下所有 markdown 文件
 */
export function listMarkdownFilesRecursive(app: App, folderPath: string): TFile[] {
  const folder = app.vault.getAbstractFileByPath(normalizePath(folderPath));
  if (!(folder instanceof TFolder)) return [];
  const files: TFile[] = [];
  const walk = (f: TFolder) => {
    for (const child of f.children) {
      if (child instanceof TFile && child.extension === 'md') {
        files.push(child);
      } else if (child instanceof TFolder) {
        walk(child);
      }
    }
  };
  walk(folder);
  return files;
}
