// lib/case-engine/types.ts
// 陪你破案 · 案件 App 数据契约（8.1 定稿 · 2026-11-25）
//
// 谁用：引擎（8.2）、面板（8.3）、群像注入与结案归档（8.4）。
// 铁律（沿用 11-24 对齐版本 + 11-25 新口径）：
//   · 引擎零 AI 调用；面板叙事文本全部来自案件包（cases/*.ts），AI 不新增证据、不改正文。
//   · 案件包只锁四根桩：真相 / 关键材料清单（含节选正文）/ 三层争点 / 结局判法。
//   · 注入块 ≤400 token、绝不剧透：truth、证据 desc、争点原文、结局文本与 requires、痕迹详情、risk 数值一律不进。
//   · 存档按群像剧本：kv key = `caseSession:<ensembleScriptId>`；案件 App 只接在反80 剧本下（准入白名单）。
//   · 只有聊天室一个输入框：求的草稿只预填、由玩家自己按发送。

// ---------------------------------------------------------------------------
// 基础词表
// ---------------------------------------------------------------------------

/** 身份 id：float 角色 characterId（岳霖玉 / 皮韩宇 / 金成帝 …） */
export type CaseIdentityId = string;

/** 证据权限：已授权 / 待授权 / 非常规获得 / 此身份不可见 */
export type CaseAccessState = "granted" | "pending" | "obtained" | "locked";

/** 幕：侦查 / 起诉 / 庭审（v1 只做庭审一幕） */
export type CaseActId = "investigation" | "prosecution" | "trial";

/** 争点层：现场 / 程序 / 语义 */
export type CaseDisputeLayer = "scene" | "procedure" | "semantics";

/** 结局：已采纳 / 记下不动 / 打回 */
export type CaseEndingId = "filed" | "noted" | "rejected";

// ---------------------------------------------------------------------------
// 案件包（静态，一个案子一个文件：cases/<id>.ts；加案子不改引擎）
// ---------------------------------------------------------------------------

export type CasePackage = {
  /** 文件 id，如 "exit9_invalid_nods" */
  id: string;
  title: string;
  /** 案号，如 "2027고합0147" */
  caseNo: string;
  meta: {
    /** 案发时间（剧情时间字符串） */
    date: string;
    place: string;
    /** 谁把材料递来的（角色 id 或人名），只用于材料卡文案 */
    deliveredBy?: string;
    /** 递材料时那一句话（开案句的底稿，剧情 AI 可改写） */
    deliveredLine?: string;
  };
  /** 一句话真相 —— 永不进注入、不进面板 */
  truth: string;
  acts: CaseAct[];
  /** 关键材料清单（桩）。每份 60~200 字节选正文，面板直接显示 */
  evidence: CaseEvidence[];
  /** 三层争点各一句 */
  disputes: CaseDispute[];
  endings: CaseEndingDef[];
  /** 开局待办（看 / 记 / 核 / 求 …） */
  openingTodos: CaseTodo[];
  /** 两句话协议：open = 开案句；settle = 各结局的结算句 */
  protocol: { open: string; settle: Record<CaseEndingId, string> };
};

export type CaseAct = {
  id: CaseActId;
  /** 本幕可玩身份（打开谁的手机 → 谁的视图） */
  playableIdentities: CaseIdentityId[];
  /** 本幕时间预算（分钟），如庭间休息 12 */
  timeBudgetMin?: number;
};

export type CaseEvidence = {
  /** "E-01" … */
  id: string;
  name: string;
  /** 节选页眉/页码文本（如 "节选 · 2027고합0147 · 3/7 页起"）；只存文本，不做分页计算 */
  sectionMark?: string;
  /** 节选正文（桩，手写 60~200 字）；AI 不可改、不可新增 */
  desc: string;
  /** 指向哪一层争点；"red" = 假线索 */
  pointsTo: CaseDisputeLayer | "red";
  /** 每个身份的初始权限；没写的身份按 "locked" 处理 */
  initialAccess: Record<CaseIdentityId, CaseAccessState>;
  /** 核：玩家点「核」一次的结果（零 AI） */
  check?: CaseCheck;
  /** 求：朝谁要、AI 给的草稿底稿（玩家可改） */
  ask?: CaseAsk;
};

export type CaseCheck = {
  id: string;
  /** 按钮文案，如 "核讯问录像" */
  label: string;
  /** 消耗分钟数 */
  minutes: number;
  /** 结果文字（≤80 字），同时可生成一条观察底稿 */
  result: string;
};

export type CaseAsk = {
  /** 找谁（角色 id 或人名） */
  target: string;
  /** 草稿底稿（玩家在草稿框里改） */
  draft: string;
};

export type CaseDispute = {
  layer: CaseDisputeLayer;
  /** 一句话争点 */
  text: string;
};

export type CaseEndingDef = {
  id: CaseEndingId;
  title: string;
  /** 判定条件：需要交出的观察 id 或核过的证据 id */
  requires: string[];
  /** 结局正文（交材料后显示；归档取首句） */
  text: string;
};

export type CaseTodo = {
  id: string;
  text: string;
};

// ---------------------------------------------------------------------------
// 案件局（运行时存档：kv `caseSession:<ensembleScriptId>`）
// ---------------------------------------------------------------------------

export type CaseSession = {
  id: string;
  /** 宿主群像剧本（存档键；注入侧只认它） */
  ensembleScriptId: string;
  caseId: string;
  /** 当前以谁进入（打开谁的手机 → 谁的视图） */
  identity: CaseIdentityId;
  actId: CaseActId;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;

  /** 证据权限（运行时唯一真源；初值由 initialAccess 展开） */
  access: Record<string, CaseAccessState>;
  /** 核过的证据 id */
  checkedIds: string[];
  /** 庭间休息剩余分钟（无时间预算的幕为 undefined） */
  minutesLeft?: number;
  /** 她记下的观察（记） */
  observations: CaseObservation[];
  /** 通讯：剧情里与案件相关的摘录（只读，玩家不可在其中发言） */
  comms: CaseCommEntry[];
  /** 求的草稿（待说；sent=false 表示还没投递） */
  drafts: CaseDraft[];
  /** 越界痕迹（只有她自己看得到；被谁发现由剧情决定） */
  traces: CaseTrace[];
  /** 暴露风险 0–100（不进注入） */
  risk: number;
  /** 已完成的开局待办 id */
  todosDone: string[];
  /** 已交出的观察 id */
  submitted: string[];
  endingId?: CaseEndingId;
};

export type CaseObservation = {
  id: string;
  /** 关联证据（可空） */
  evidenceId?: string;
  /** ≤60 字，一条一个点 */
  text: string;
  at: string;
  /** 这次观察花掉的分钟（可空） */
  minutes?: number;
};

export type CaseCommEntry = {
  id: string;
  /** 谁说的 */
  from: CaseIdentityId;
  text: string;
  at: string;
  /** story = 剧情室摘录；delivery = 随材料递来的话 */
  source: "story" | "delivery";
};

export type CaseDraft = {
  id: string;
  /** 跟哪份证据的「求」有关 */
  evidenceId: string;
  /** 玩家编辑后的文字（投递时预填进聊天输入框） */
  text: string;
  at: string;
  /** 是否已投递过（投递 ≠ 发送） */
  sent: boolean;
};

export type CaseTrace = {
  id: string;
  /** 痕迹描述，如 "超范围翻看笔录 p.6–p.8" */
  text: string;
  at: string;
  /** 本次增加的风险值 */
  risk: number;
};

// ---------------------------------------------------------------------------
// 8.4 预留（群像侧对接，待 8.4 定稿再动）
// ---------------------------------------------------------------------------

/** 结案后写进群像归档的独立字段（EnsembleArchiveEntry.caseUnits，不进 AI 重写的正文） */
export type CaseUnit = {
  caseId: string;
  title: string;
  caseNo?: string;
  endingId: CaseEndingId;
  /** 每人做了什么（按操作者聚合） */
  actors: { identity: CaseIdentityId; actions: string[] }[];
  /** 留 1~2 行给归档正文用的短句 */
  notes?: string[];
};

/** 注入块入参（8.4 实现 buildCasePromptBlock 时用；本阶段不实现） */
export type CasePromptInput = {
  caseTitle: string;
  caseNo: string;
  actId: CaseActId;
  minutesLeft?: number;
  /** 已核证据名称（≤20 条） */
  checkedNames: string[];
  /** 待授权证据名称（只给名字，不给内容） */
  pendingNames: string[];
  /** 最近 3 条观察（≤60 字/条） */
  recentObservations: string[];
  /** 刚发生的一条（≤60 字） */
  justHappened?: string;
};