interface ApiResponse<T = any> {
  code: number;
  msg?: string;
  data?: T;
}

interface KnowledgeBase {
  kb_id: string;
  kb_name: string;
  kb_desc?: string;
  role_type: string;
  content_count?: number;
  create_time?: string;
  update_time?: string;
}

interface KnowledgeItem {
  media_id: string;
  title: string;
  media_type: number;
  parent_folder_id?: string;
  create_time?: string;
  update_time?: string;
}

export class IMAApi {
  private clientId: string;
  private apiKey: string;
  private baseUrl = 'https://ima.qq.com/openapi/wiki/v1';

  constructor(clientId: string, apiKey: string) {
    this.clientId = clientId;
    this.apiKey = apiKey;
  }

  private async request<T = any>(
    endpoint: string,
    method: string = 'POST',
    body?: any
  ): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const options: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'ima-openapi-clientid': this.clientId,
        'ima-openapi-apikey': this.apiKey,
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`);
    }

    const result: ApiResponse<T> = await response.json();
    if (result.code !== 0) {
      throw new Error(result.msg || 'Unknown API error');
    }

    return result.data;
  }

  async searchKnowledgeBase(query: string = '', cursor: string = ''): Promise<KnowledgeBase[]> {
    const data = await this.request<{
      info_list: KnowledgeBase[];
      is_end: boolean;
      next_cursor: string;
    }>('search_knowledge_base', {
      query,
      cursor,
      limit: 20,
    });

    const allKbs: KnowledgeBase[] = [...data.info_list];
    let nextCursor = data.next_cursor;

    while (!data.is_end && nextCursor) {
      const moreData = await this.request<{
        info_list: KnowledgeBase[];
        is_end: boolean;
        next_cursor: string;
      }>('search_knowledge_base', {
        query,
        cursor: nextCursor,
        limit: 20,
      });

      allKbs.push(...moreData.info_list);
      if (moreData.is_end) break;
      nextCursor = moreData.next_cursor;
    }

    return allKbs;
  }

  async getKnowledgeList(
    kbId: string,
    folderId: string = '',
    cursor: string = ''
  ): Promise<KnowledgeItem[]> {
    const body: any = {
      knowledge_base_id: kbId,
      cursor,
      limit: 50,
    };

    if (folderId) {
      body.folder_id = folderId;
    }

    const data = await this.request<{
      knowledge_list: KnowledgeItem[];
      is_end: boolean;
      next_cursor: string;
    }>('get_knowledge_list', body);

    const allItems: KnowledgeItem[] = [...data.knowledge_list];
    let nextCursor = data.next_cursor;

    while (!data.is_end && nextCursor) {
      const moreData = await this.request<{
        knowledge_list: KnowledgeItem[];
        is_end: boolean;
        next_cursor: string;
      }>('get_knowledge_list', {
        ...body,
        cursor: nextCursor,
      });

      allItems.push(...moreData.knowledge_list);
      if (moreData.is_end) break;
      nextCursor = moreData.next_cursor;
    }

    return allItems;
  }

  async exportMedia(mediaId: string): Promise<string | null> {
    try {
      const data = await this.request<{
        media_content_url_info: {
          url: string;
        };
      }>('export_media_for_ima_sandbox', {
        media_id: mediaId,
      });

      const downloadUrl = data.media_content_url_info?.url;
      if (!downloadUrl) return null;

      const contentResponse = await fetch(downloadUrl);
      if (!contentResponse.ok) return null;

      return await contentResponse.text();
    } catch (err) {
      console.error(`Failed to export media ${mediaId}:`, err);
      return null;
    }
  }
}
