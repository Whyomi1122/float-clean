// lib/ensemble-storyboard.ts
// 群像 · 分镜配图：把一轮剧情压缩成画面描述，再调用全局生图接口生成横版场景图。
//
// 设计要点：
//   · 开关在剧本上（storyboardEnabled），只管「下一轮」——已生成的图不受影响；
//   · 每轮最多生成 1 张，避免 token / 成本失控；
//   · 提示词里只写**在场角色**（说话者 + 正文点名），不再把整个 cast 名单都列上；
//   · 锁脸：优先把当前说话者的参考图送进生图（`characterId` + `useReferenceImage`）；
//     其余在场角色的外观档案词一并拼进提示词（单参考图接口只能锁一个人）；
//   · 多人同框规避：次要角色写背身/侧脸/远景虚焦，把清晰正脸留给主要角色；
//   · 可选「多角色参考图（拼图）」：在场两人都有参考图时横向拼成一张，提示词标注左右顺序；
//   · 失败静默，绝不打断剧情生成。

import { generateImageFromConfiguredApi, type ImageGenerationResult } from "./image-generation-service";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { loadImageGenerationSettings, loadUserIdentities } from "./settings-storage";
import type { EnsembleCastMember, EnsembleScript, EnsembleTurn } from "./ensemble-storage";

/** 拼图参考图里每一格的分辨率（正方形）。 */
const REFERENCE_SLOT_SIZE = 512;

/** 本轮在画面里出现的角色：说话者优先，其次是正文里被点名的角色。 */
function castInScene(script: EnsembleScript, turn: EnsembleTurn): EnsembleCastMember[] {
  const text = turn.content ?? "";
  const speakerName = turn.senderType === "character" ? (turn.senderName ?? "") : "";
  const seen = new Set<string>();
  const members: EnsembleCastMember[] = [];
  for (const member of script.cast ?? []) {
    if (!member?.id || !member.name || seen.has(member.id)) continue;
    if (member.name === speakerName || text.includes(member.name)) {
      seen.add(member.id);
      members.push(member);
    }
  }
  return members;
}

/** 这一轮锁脸优先对象：说话者 → 正文里第一个被点名的角色 → 第一个在场角色。 */
function pickLockTarget(
  script: EnsembleScript,
  turn: EnsembleTurn,
  inScene: EnsembleCastMember[],
): EnsembleCastMember | undefined {
  const speakerName = turn.senderType === "character" ? (turn.senderName ?? "") : "";
  if (speakerName) {
    const speaker = (script.cast ?? []).find(member => member.name === speakerName);
    if (speaker?.id) return speaker;
  }
  return inScene[0];
}

/** 从这一轮的剧情文本里摘出可读的画面描述（不调用 LLM，纯规则，零成本）。 */
export function buildStoryboardPrompt(script: EnsembleScript, turn: EnsembleTurn): string {
  const text = (turn.content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  // 场景：优先剧本全局背景，其次本轮叙述
  const scene = (script.background ?? "").split(/\n+/)[0]?.trim() ?? "";
  const inScene = castInScene(script, turn);
  const castNames = inScene.map(member => member.name).filter(Boolean).join("、");
  const speaker = turn.senderType === "character" ? turn.senderName : "";

  const parts: string[] = [];
  if (castNames) parts.push(`多人场景，画面中的角色：${castNames}`);
  if (speaker) parts.push(`当前说话者 ${speaker}`);
  if (scene) parts.push(`场景：${scene}`);
  parts.push(`情节：${text.slice(0, 220)}`);
  if (script.storyboardPrompt?.trim()) parts.push(script.storyboardPrompt.trim());
  // 多人同框时把清晰正脸集中给主要角色，避免配角"像不像"的问题暴露
  if (inScene.length >= 2) {
    parts.push("构图：主要角色正脸清晰可辨；其余角色用背身、侧脸或远景虚焦，不展示清晰面部细节。");
  }
  parts.push("电影感构图，横版，cinematic lighting，detailed背景");
  return parts.join("\n");
}

export interface StoryboardOutcome {
  ok: boolean;
  url?: string;
  error?: string;
}

function loadImageElement(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    if (typeof window === "undefined") {
      resolve(null);
      return;
    }
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/**
 * 把多个角色的锁脸参考图横向拼成一张（每格裁成 1:1，尊重 `faceCrop`）。
 * 不足两张可用参考图时返回 null，调用方回退到单参考图。
 */
async function buildStitchedReference(
  characterIds: string[],
): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const settings = loadImageGenerationSettings();
  const slots: { url: string; crop?: { x: number; y: number; size: number } }[] = [];
  for (const characterId of characterIds) {
    const reference = settings.characterReferences?.[characterId];
    if (!reference?.assetId || reference.enabled === false) continue;
    const dataUrl = await getChatImageFromIndexedDB(reference.assetId);
    if (!dataUrl) continue;
    slots.push({ url: dataUrl, crop: reference.faceCrop });
    if (slots.length >= 2) break;
  }
  if (slots.length < 2) return null;

  const canvas = document.createElement("canvas");
  canvas.width = REFERENCE_SLOT_SIZE * slots.length;
  canvas.height = REFERENCE_SLOT_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return null;

  for (let index = 0; index < slots.length; index += 1) {
    const image = await loadImageElement(slots[index].url);
    if (!image) continue;
    const naturalWidth = image.naturalWidth || REFERENCE_SLOT_SIZE;
    const naturalHeight = image.naturalHeight || REFERENCE_SLOT_SIZE;
    const crop = slots[index].crop;
    const square = crop?.size
      ? Math.max(1, Math.min(naturalWidth, naturalHeight) * crop.size)
      : Math.min(naturalWidth, naturalHeight);
    const sourceX = crop?.size
      ? Math.max(0, Math.min(naturalWidth - square, naturalWidth * crop.x))
      : (naturalWidth - square) / 2;
    const sourceY = crop?.size
      ? Math.max(0, Math.min(naturalHeight - square, naturalHeight * crop.y))
      : (naturalHeight - square) / 2;
    context.drawImage(
      image,
      sourceX,
      sourceY,
      square,
      square,
      index * REFERENCE_SLOT_SIZE,
      0,
      REFERENCE_SLOT_SIZE,
      REFERENCE_SLOT_SIZE,
    );
  }
  return canvas.toDataURL("image/png");
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
    // 「我」出现在这一幕 → 叠加用户面具外观词，让面具形象在各分镜间保持一致
    let userMask: { positive?: string; negative?: string } | undefined;
    if (script.personaId) {
      const identity = loadUserIdentities().find(p => p.id === script.personaId);
      const personaInScene = turn.senderType === "user"
        || (identity?.name ? (turn.content ?? "").includes(identity.name) : false);
      if (identity && personaInScene) {
        userMask = {
          positive: identity.imagePromptPositive,
          negative: identity.imagePromptNegative,
        };
      }
    }

    const settings = loadImageGenerationSettings();
    const inScene = castInScene(script, turn);
    const lockTarget = pickLockTarget(script, turn, inScene);

    // L1：把其他在场角色的外观档案词一起拼进去（单参考图接口只能锁一个人）
    const extraFeaturePrompts = inScene
      .filter(member => member.id !== lockTarget?.id)
      .map(member => {
        const reference = settings.characterReferences?.[member.id];
        return (reference?.featurePromptPositive ?? reference?.featurePrompt ?? "").trim();
      })
      .filter(Boolean);

    // L2：可选的多角色拼图参考图（默认关闭；两人都有参考图才生效）
    let stitchedReference: string | null = null;
    let stitchedNames: string[] = [];
    if (script.storyboardMultiReference === true) {
      const referenceIds: string[] = [];
      const orderedMembers = lockTarget
        ? [lockTarget, ...inScene.filter(member => member.id !== lockTarget.id)]
        : inScene;
      for (const member of orderedMembers) {
        const reference = settings.characterReferences?.[member.id];
        if (!reference?.assetId || reference.enabled === false) continue;
        referenceIds.push(member.id);
        if (referenceIds.length >= 2) break;
      }
      if (referenceIds.length >= 2) {
        stitchedReference = await buildStitchedReference(referenceIds);
        if (stitchedReference) {
          stitchedNames = referenceIds
            .map(id => orderedMembers.find(member => member.id === id)?.name ?? "")
            .filter(Boolean);
        }
      }
    }

    const finalDescription = stitchedReference && stitchedNames.length >= 2
      ? `${description}\n参考图从左到右依次是：${stitchedNames.join("、")}。请让对应人物各自继承该参考图里的面部特征。`
      : description;

    const result: ImageGenerationResult | null = await generateImageFromConfiguredApi({
      description: finalDescription,
      app: "ensemble",
      signal,
      userMask,
      characterId: lockTarget?.id,
      useReferenceImage: Boolean(lockTarget?.id),
      referenceImageDataUrlOverride: stitchedReference ?? undefined,
      extraFeaturePrompts,
    });
    if (!result?.dataUrl) return { ok: false, error: "生成失败" };
    return { ok: true, url: result.dataUrl };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "生成失败" };
  }
}
