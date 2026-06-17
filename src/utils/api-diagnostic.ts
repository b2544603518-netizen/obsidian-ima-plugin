import { requestUrl } from 'obsidian';
import { ImaApi } from '../api/ima-api';

/**
 * API 连接诊断结果
 */
export interface DiagResult {
  ok: boolean;
  steps: DiagStep[];
  summary: string;
  suggestion: string;
}

export interface DiagStep {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
  durationMs?: number;
}

/**
 * API 健康检查与诊断工具
 *
 * 用途:
 * 1. 用户看到"加载失败"时,点击"诊断连接"按钮查看具体哪一步出了问题
 * 2. 区分 "API Key 无效"、"网络不通"、"限流"、"服务端异常" 等不同原因
 * 3. 给出可操作的修复建议
 *
 * 检测步骤:
 *   Step 1 - 网络:能否访问 ima.qq.com
 *   Step 2 - 认证:Client ID / API Key 是否被接受(不调业务接口)
 *   Step 3 - 业务接口:最小请求(search_knowledge_base 带 limit=1)
 */
export async function diagnoseApiConnection(
  clientId: string,
  apiKey: string,
  api?: ImaApi
): Promise<DiagResult> {
  const steps: DiagStep[] = [];

  // ===== Step 1: 网络连通性 =====
  const t0 = Date.now();
  try {
    const resp = await requestUrl({
      url: 'https://ima.qq.com/agent-interface',
      method: 'GET',
      throw: false,
    });
    const elapsed = Date.now() - t0;
    if (resp.status >= 200 && resp.status < 400) {
      steps.push({
        name: '网络连通性',
        status: 'ok',
        detail: `IMA 服务可达 (HTTP ${resp.status}, ${elapsed}ms)`,
        durationMs: elapsed,
      });
    } else {
      steps.push({
        name: '网络连通性',
        status: 'warn',
        detail: `IMA 返回 HTTP ${resp.status}`,
        durationMs: elapsed,
      });
    }
  } catch (e: any) {
    steps.push({
      name: '网络连通性',
      status: 'fail',
      detail: `无法访问 ima.qq.com: ${e.message || '未知网络错误'}`,
    });
  }

  // ===== Step 2: 认证测试(用 list_note_by_folder_id 带 limit=1,最小开销) =====
  const t1 = Date.now();
  try {
    const resp = await requestUrl({
      url: 'https://ima.qq.com/openapi/note/v1/list_note_by_folder_id',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ima-openapi-clientid': clientId,
        'ima-openapi-apikey': apiKey,
      },
      body: JSON.stringify({ cursor: '', limit: 1 }),
      throw: false,
    });
    const elapsed = Date.now() - t1;

    if (resp.status === 429) {
      steps.push({
        name: 'API 认证 & 限流',
        status: 'warn',
        detail: `认证通过但已被限流 (HTTP 429)。可能短时间内请求过多,请稍后重试。`,
        durationMs: elapsed,
      });
    } else if (resp.status === 401 || resp.status === 403) {
      steps.push({
        name: 'API 认证 & 限流',
        status: 'fail',
        detail: `认证失败 (HTTP ${resp.status})。API Key 可能已过期或无效,请到 https://ima.qq.com/agent-interface 重新获取。`,
        durationMs: elapsed,
      });
    } else if (resp.status >= 200 && resp.status < 400) {
      const json = resp.json;
      if (json?.code === 0 || json?.code === undefined) {
        steps.push({
          name: 'API 认证',
          status: 'ok',
          detail: `认证成功 (HTTP ${resp.status}, code=${json?.code ?? 'N/A'}, ${elapsed}ms)`,
          durationMs: elapsed,
        });
      } else {
        // 业务错误码(如 code=10001 等),但 HTTP 层面是通的
        steps.push({
          name: 'API 认证',
          status: 'ok',
          detail: `网络和认证正常,但返回业务错误 code=${json.code}: ${json.msg || '(无消息)'}`,
          durationMs: elapsed,
        });
      }
    } else {
      steps.push({
        name: 'API 认证 & 限流',
        status: 'fail',
        detail: `API 返回 HTTP ${resp.status}${resp.json?.msg ? ': ' + resp.json.msg : ''}`,
        durationMs: elapsed,
      });
    }
  } catch (e: any) {
    steps.push({
      name: 'API 认证',
      status: 'fail',
      detail: `请求失败: ${e.message || '未知错误'}`,
    });
  }

  // ===== Step 3: 知识库接口测试(可选,如果 api 对象传入) =====
  if (api) {
    const t2 = Date.now();
    try {
      const kbs = await api.searchAllKnowledgeBases(true); // forceRefresh=true
      const elapsed = Date.now() - t2;
      steps.push({
        name: '知识库接口',
        status: 'ok',
        detail: `成功获取知识库列表 (${kbs.length} 个, ${elapsed}ms)`,
        durationMs: elapsed,
      });
    } catch (e: any) {
      steps.push({
        name: '知识库接口',
        status: 'fail',
        detail: e.message || '未知错误',
      });
    }
  }

  // ===== 汇总 =====
  const failCount = steps.filter(s => s.status === 'fail').length;
  const warnCount = steps.filter(s => s.status === 'warn').length;
  const ok = failCount === 0;

  let summary: string;
  let suggestion: string;

  if (ok && warnCount === 0) {
    summary = '所有检测项正常';
    suggestion = '如果仍有问题,可能是 Obsidian 缓存导致,请尝试: 重启 Obsidian → 清除插件缓存 → 重新打开同步窗口。';
  } else if (ok && warnCount > 0) {
    summary = `基本正常 (${warnCount} 项警告)`;
    suggestion = '警告项通常是临时性的(如短暂限流),请等待 30 秒后重试。';
  } else {
    const firstFail = steps.find(s => s.status === 'fail');
    if (firstFail?.detail.includes('无法访问') || firstFail?.detail.includes('网络')) {
      summary = '网络连接异常';
      suggestion = '请检查:\n1. 能否在浏览器中打开 https://ima.qq.com\n2. 是否使用了代理/VPN\n3. 防火墙是否阻止了 Obsidian 的网络访问';
    } else if (firstFail?.detail.includes('401') || firstFail?.detail.includes('403') || firstFail?.detail.includes('过期')) {
      summary = 'API Key 无效或已过期';
      suggestion = '请前往 https://ima.qq.com/agent-interface 重新生成 API Key,并在插件设置中更新。';
    } else if (firstFail?.detail.includes('429')) {
      summary = 'API 请求频率过高(限流)';
      suggestion = '请等待 30-60 秒后重试。v2.0 已内置节流机制,频繁触发此问题说明可能有其他程序也在调用同一 API Key。';
    } else {
      summary = `${failCount} 项检测失败`;
      suggestion = `最可能的失败原因:\n${firstFail?.detail}\n\n如果问题持续,请按 F12 打开开发者工具 → Console 面板 → 复制红色错误信息反馈给开发者。`;
    }
  }

  return { ok, steps, summary, suggestion };
}
