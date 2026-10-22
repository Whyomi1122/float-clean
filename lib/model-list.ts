// lib/model-list.ts
// 从任意 OpenAI 兼容 / Gemini 原生接口拉取可用模型列表。
//
// 抽出来的动机：群像的「功能 → 模型切换」需要列出某条 API 下的所有模型，
// 与「设置 → API 配置」页的「拉取模型列表」是同一套逻辑，避免两处重复实现漂移。

import type { ApiConfig } from "./settings-types";
import { determineBaseUrl } from "./api-helpers";

/**
 * 拉取某个 API 配置下的全部模型名。
 * 失败时抛出 Error（错误信息已做用户可读化处理）。
 */
export async function fetchModelNames(config: ApiConfig): Promise<string[]> {
  const baseUrl = determineBaseUrl(config);
  if (!baseUrl) throw new Error("缺少 Base URL");
  if (!config.apiKey) throw new Error("缺少 API Key");

  // Gemini 原生协议（/v1beta）：URL 用 ?key= 鉴权，响应是 { models: [{ name }] }
  // OpenAI 兼容（/v1）：Authorization: Bearer + 响应是 { data: [{ id }] }
  const isGoogleNative = config.provider === "Google";

  // 用户常把完整端点填进 Base URL（如 .../v1/chat/completions），
  // 拼 /models 前剥掉这类端点后缀；已以 /models 结尾则原样使用。
  const modelsBase = baseUrl
    .replace(/\/$/, "")
    .replace(/\/(chat\/completions|completions|embeddings|messages)$/i, "");
  const modelsUrl = /\/models$/i.test(modelsBase) ? modelsBase : `${modelsBase}/models`;

  const url = isGoogleNative
    ? `${modelsUrl}?key=${encodeURIComponent(config.apiKey)}`
    : modelsUrl;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!isGoogleNative) headers["Authorization"] = `Bearer ${config.apiKey}`;

  const response = await fetch(url, { method: "GET", headers });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData?.error?.message || `HTTP error! status: ${response.status}`
    );
  }

  const data = await response.json();

  if (isGoogleNative && Array.isArray(data?.models)) {
    // Gemini 原生：name 可能是 "models/gemini-2.5-pro" 或纯名字
    return data.models
      .map((m: { name?: string }) => (m?.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  }
  if (Array.isArray(data?.data)) {
    return data.data
      .map((m: { id?: string }) => m?.id || "")
      .filter(Boolean);
  }
  throw new Error("返回数据格式不符合预期");
}
