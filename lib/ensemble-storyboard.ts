// lib/ensemble-storyboard.ts
// 群像 · 分镜配图：把一轮剧情压缩成画面描述，再调用全局生图接口生成横版场景图。
//
// 设计要点：
//   · 开关在剧本上（storyboardEnabled），只管「下一轮」——已生成的图不受影响；
//   · 每轮最多生成 1 张，避免 token / 成本失控；
//   · 提示词里带场景 + 在场角色，横版构图，多人同框；
//   · 失败静默，绝不打断剧情生成。

import { generateImageFromConfiguredApi, type ImageGenerationResult } from "./image-generation-service";
import type { EnsembleScript, EnsembleTurn } from "./ensemble-storage";

/** 从这一轮的剧情文本里摘出可读的画面描述（不调用 LLM，纯规则，零成本）。 */
export function buildStoryboardPrompt(script: EnsembleScript, turn: EnsembleTurn): string {
  const text = (turn.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  // 场景：优先剧本全局背景，其次本轮叙述
  const scene = (script.background ?? "").split(/\n+/)[0]?.trim() ?? "";
  const castNames = script.cast.map(member => member.name).filter(Boolean).join("、");
  const speaker = turn.senderType === "character" ? turn.senderName : "";

  const parts: string[] = [];
  if (castNames) parts.push(`多人场景，角色：${castNames}`);
  if (speaker) parts.push(`当前说话者 ${speaker}`);
  if (scene) parts.push(`场景：${scene}`);
  parts.push(`情节：${text.slice(0, 220)}`);
  if (script.storyboardPrompt?.trim()) parts.push(script.storyboardPrompt.trim());
  parts.push("电影感构图，横版，cinematic lighting，detailed背景");
  return parts.join("\n");
}

export interface StoryboardOutcome {
  ok: boolean;
  url?: string;
  error?: string;
}

/** 给一轮剧情生成一张分镜图；失败静默返回 ok:false。 */
export async function generateStoryboardImage(
  script: EnsembleScript,
  turn: EnsembleTurn,
  signal?: AbortSignal,
): Promise<StoryboardOutcome> {
  if (!script.storyboardEnabled) return { ok: false, error: "未开启分镜配图" };
  const description = buildStoryboardPrompt(script, turn);
  if (!description) return { ok: false, error: "本轮没有可用画面描述" };

  try {
    const result: ImageGenerationResult | null = await generateImageFromConfiguredApi({
      description,
      app: "ensemble",
      signal,
    });
    if (!result?.dataUrl) return { ok: false, error: "生成失败" };
    return { ok: true, url: result.dataUrl };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "生成失败" };
  }
}
