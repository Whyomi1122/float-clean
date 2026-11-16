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

/** 用户面具在"在场角色"里的伪 id 前缀（面具不是 cast 成员，但必须参与主体判定）。 */
const PERSONA_MEMBER_PREFIX = "persona:";

/** 这个"演员"是不是用户面具包装出来的伪成员。 */
export function isPersonaMember(member: EnsembleCastMember | undefined): boolean {
  return Boolean(member?.id && member.id.startsWith(PERSONA_MEMBER_PREFIX));
}

/** 把当前剧本绑定的用户面具包装成一个"候选演员"。 */
function resolvePersonaMember(script: EnsembleScript): EnsembleCastMember | null {
  if (!script.personaId) return null;
  const identity = loadUserIdentities().find(p => p.id === script.personaId);
  if (!identity?.name) return null;
  return {
    id: `${PERSONA_MEMBER_PREFIX}${identity.id}`,
    name: identity.name,
    avatar: identity.avatarUrl ?? null,
  };
}

/** 本轮可能入画的候选集合：cast + 用户面具（面具必须是一等公民，否则说话者查不到）。 */
function castCandidates(script: EnsembleScript): EnsembleCastMember[] {
  const members = [...(script.cast ?? [])];
  const persona = resolvePersonaMember(script);
  if (persona && !members.some(member => member.name === persona.name)) members.push(persona);
  return members;
}

/** 本轮在画面里出现的角色：说话者优先，其次是正文里被点名的角色（含用户面具）。 */
function castInScene(script: EnsembleScript, turn: EnsembleTurn): EnsembleCastMember[] {
  const text = turn.content ?? "";
  const speakerName = turn.senderType === "character" ? (turn.senderName ?? "") : "";
  const seen = new Set<string>();
  const members: EnsembleCastMember[] = [];
  for (const member of castCandidates(script)) {
    if (!member?.id || !member.name || seen.has(member.id)) continue;
    if (member.name === speakerName || text.includes(member.name)) {
      seen.add(member.id);
      members.push(member);
    }
  }
  return members;
}

/**
 * 画面主体 = 锁脸对象。
 * 旧版 bug：cast 里找不到说话者就 `inScene[0]`——用户面具不在 cast 时，
 * 说话者「岳霖玉」查不到，于是锁到了配角皮韩宇的脸上（幕 034 实证）。
 * 新版：说话者（含面具）→ 正文里出现次数最多的在场角色 → 第一个在场角色。
 */
function pickLockTarget(
  script: EnsembleScript,
  turn: EnsembleTurn,
  inScene: EnsembleCastMember[],
): EnsembleCastMember | undefined {
  const speakerName = turn.senderType === "character" ? (turn.senderName ?? "") : "";
  if (speakerName) {
    const speaker = inScene.find(member => member.name === speakerName);
    if (speaker?.id) return speaker;
  }
  if (!inScene.length) return undefined;
  const text = turn.content ?? "";
  let best = inScene[0];
  let bestCount = best.name ? text.split(best.name).length - 1 : 0;
  for (const member of inScene.slice(1)) {
    const count = member.name ? text.split(member.name).length - 1 : 0;
    if (count > bestCount) {
      best = member;
      bestCount = count;
    }
  }
  return best;
}

/**
 * 摘出"主体自己的动作段落"，而不是盲切前 220 字。
 * 旧版死切前 220 字 → 描述常落在旁白或别的角色身上，和锁脸对象对不上（姿势与脸错配）。
 */
function pickSceneSnippet(
  text: string,
  subject: EnsembleCastMember | undefined,
  subjectIsPersona: boolean,
  limit = 260,
): string {
  const cleaned = text
    .replace(/[［\[][^］\]]{1,10}[］\]]/g, " ")
    .replace(/(^|\n)\s*[^\s：:]{1,12}[：:]\s*/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const sentences = cleaned.match(/[^。！？!?\n]+[。！？!?]?/g)?.map(item => item.trim()).filter(Boolean) ?? [];
  if (sentences.length === 0) return cleaned.slice(0, limit);

  const keywords = subjectIsPersona
    ? ["你", subject?.name ?? ""]
    : [subject?.name ?? "", "他", "她"];
  const picked: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (!keywords.some(keyword => keyword.length > 0 && sentence.includes(keyword))) continue;
    picked.push(sentence);
    length += sentence.length;
    if (length >= limit) break;
  }
  if (picked.length === 0) return cleaned.slice(0, limit);
  return picked.join("").slice(0, limit);
}

/** 从这一轮的剧情文本里摘出可读的画面描述（不调用 LLM，纯规则，零成本）。 */
export function buildStoryboardPrompt(script: EnsembleScript, turn: EnsembleTurn): string {
  const raw = (turn.content ?? "").trim();
  if (!raw) return "";

  const scene = (script.background ?? "").split(/\n+/)[0]?.trim() ?? "";
  const inScene = castInScene(script, turn);
  const subject = pickLockTarget(script, turn, inScene);
  const subjectIsPersona = isPersonaMember(subject);
  const others = inScene.filter(member => member.id !== subject?.id);

  const parts: string[] = [];
  if (subject?.name) {
    parts.push(`画面主体：${subject.name}${subjectIsPersona ? "（用户本人）" : ""}`);
  }
  if (others.length > 0) parts.push(`同框角色：${others.map(member => member.name).join("、")}`);
  if (scene) parts.push(`场景：${scene}`);
  parts.push(`情节：${pickSceneSnippet(raw, subject, subjectIsPersona)}`);
  if (script.storyboardPrompt?.trim()) parts.push(script.storyboardPrompt.trim());
  // 多人同框时把清晰正脸集中给画面主体，避免配角"像不像"的问题暴露
  if (others.length > 0) {
    parts.push("构图：画面主体正脸清晰可辨；同框角色用背身、侧脸或远景虚焦，不展示清晰面部细节。");
  }
  parts.push("电影感构图，横版，cinematic lighting，detailed背景");
  return parts.join("\n");
}

export interface StoryboardOutcome {
  ok: boolean;
  url?: string;
  error?: string;
}

/** 一次分镜生图的"心里话"：主体是谁、锁了谁的图、实际发出去的提示词。 */
export interface StoryboardDebug {
  prompt: string;
  subject: string;
  subjectIsPersona: boolean;
  referenceOwner: string | null;
  stitched: boolean;
  stitchedNames: string[];
  extraFeatures: string[];
  personaMaskApplied: boolean;
  at: string;
}

const storyboardDebugStore = new Map<string, StoryboardDebug>();

function rememberStoryboardDebug(turnId: string, debug: StoryboardDebug) {
  if (!turnId) return;
  storyboardDebugStore.set(turnId, debug);
  if (storyboardDebugStore.size > 40) {
    const oldest = storyboardDebugStore.keys().next().value;
    if (oldest) storyboardDebugStore.delete(oldest);
  }
}

/** 读取某一幕上次生图的实际提示词（同一会话内有效；刷新后清空）。 */
export function getStoryboardDebug(turnId: string): StoryboardDebug | null {
  return storyboardDebugStore.get(turnId) ?? null;
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
    const settings = loadImageGenerationSettings();
    const inScene = castInScene(script, turn);
    const lockTarget = pickLockTarget(script, turn, inScene);
    const lockIsPersona = isPersonaMember(lockTarget);

    // 「我」出现在这一幕 → 叠加用户面具外观词，让面具形象在各分镜间保持一致。
    // 判定放宽：面具就是画面主体、或本轮出现「你」/面具名，都算；否则岳霖玉的外观词会整段丢失。
    let userMask: { positive?: string; negative?: string } | undefined;
    if (script.personaId) {
      const identity = loadUserIdentities().find(p => p.id === script.personaId);
      const text = turn.content ?? "";
      const personaInScene = lockIsPersona
        || turn.senderType === "user"
        || (identity?.name ? text.includes(identity.name) : false)
        || text.includes("你");
      if (identity && personaInScene) {
        userMask = {
          positive: identity.imagePromptPositive,
          negative: identity.imagePromptNegative,
        };
      }
    }

    // L1：把其他在场角色的外观档案词一起拼进去（单参考图接口只能锁一个人）
    const extraFeaturePrompts = inScene
      .filter(member => member.id !== lockTarget?.id)
      .map(member => {
        const reference = settings.characterReferences?.[member.id];
        return (reference?.featurePromptPositive ?? reference?.featurePrompt ?? "").trim();
      })
      .filter(Boolean);

    // 主体能不能锁脸：面具目前没有参考图通道，锁不到就宁可不锁，也绝不拿别人的图顶替
    const subjectReference = lockTarget && !lockIsPersona
      ? settings.characterReferences?.[lockTarget.id]
      : undefined;
    const hasSubjectReference = Boolean(subjectReference?.assetId && subjectReference.enabled !== false);

    // L2：可选的多角色拼图参考图（只在「主体已确定且主体有参考图」时启用，主体排第一格）
    let stitchedReference: string | null = null;
    let stitchedNames: string[] = [];
    if (script.storyboardMultiReference === true && lockTarget && hasSubjectReference) {
      const referenceIds: string[] = [];
      const orderedMembers = [lockTarget, ...inScene.filter(member => member.id !== lockTarget.id)];
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
      ? `${description}\n参考图从左到右依次是：${stitchedNames.join("、")}。其中第一位是画面主体，必须继承该参考图里的面部特征；其余人物只做配角。`
      : description;

    const result: ImageGenerationResult | null = await generateImageFromConfiguredApi({
      description: finalDescription,
      app: "ensemble",
      signal,
      userMask,
      characterId: lockIsPersona ? undefined : lockTarget?.id,
      useReferenceImage: hasSubjectReference,
      referenceImageDataUrlOverride: stitchedReference ?? undefined,
      extraFeaturePrompts,
    });

    // 记下本次实际送出去的东西，供「长按分镜图 → 查看提示词」核对
    rememberStoryboardDebug(turn.id, {
      prompt: finalDescription,
      subject: lockTarget?.name ?? "（未判定）",
      subjectIsPersona: lockIsPersona,
      referenceOwner: hasSubjectReference ? (lockTarget?.name ?? null) : null,
      stitched: Boolean(stitchedReference),
      stitchedNames,
      extraFeatures: extraFeaturePrompts,
      personaMaskApplied: Boolean(userMask?.positive),
      at: new Date().toISOString(),
    });

    if (!result?.dataUrl) return { ok: false, error: "生成失败" };
    return { ok: true, url: result.dataUrl };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "生成失败" };
  }
}
