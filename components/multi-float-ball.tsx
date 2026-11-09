"use client";

// 多功能悬浮球 —— 统一入口(音乐 / API 快切 / 未来更多)

import { useCallback, useEffect, useRef, useState } from "react";
import { loadApiConfigs, saveApiConfigs, loadBindingConfig, saveBindingConfig, loadUserIdentities } from "@/lib/settings-storage";
import type { ApiConfig } from "@/lib/settings-types";
import { fetchModelNames } from "@/lib/model-list";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { UserIdentity } from "@/components/settings/user-identity";
import {
    useMusicControlsOptional,
    useMusicPlayerOptional,
} from "@/lib/music-context";
import type { MusicTrack } from "@/lib/music-storage";
import {
    getEnsembleDeliveryPanelSummaries,
    setDeliveryBackgroundEnabled,
    buildEnsembleDeliveryPromptBackground,
    type EnsembleDeliveryPanelSummary,
} from "@/lib/ensemble-delivery";
import "./../styles/multi-float.css";
import "./../styles/listen-together.css";
import ListenTogetherOverlay from "@/components/music/listen-together-overlay";
import { appendListenMarker } from "@/lib/listen-together-markers";

type Props = {
    hidden: boolean;
    /** 当前所在的 App（离开聊天室要自动结束一起听） */
    currentApp?: string;
};

const POS_KEY = "ai_phone_float_ball_pos";
const LISTEN_USER_KEY = "ai_phone_float_listen_user";
const LISTEN_CHAR_KEY = "ai_phone_float_listen_char";

export default function MultiFloatBall({ hidden, currentApp }: Props) {
    const controls = useMusicControlsOptional();
    const player = useMusicPlayerOptional();
    const playlist = player?.queue ?? [];
    const seekTo = player?.seek ?? null;
    const playerDuration = player?.duration ?? 0;
    const playTrack = useCallback((t: MusicTrack) => { player?.playTrack(t); }, [player]);

    // ── 球体位置与状态 ──
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [panelOpen, setPanelOpen] = useState(false);
    const [tab, setTab] = useState<"music" | "api" | "delivery">("music");
    const [toast, setToast] = useState<string | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((msg: string) => {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 2200);
    }, []);

    // 初始化位置(右侧偏上,避开底栏)
    useEffect(() => {
        if (typeof window === "undefined") return;
        try {
            const saved = localStorage.getItem(POS_KEY);
            if (saved) { setPos(JSON.parse(saved)); return; }
        } catch { /* ignore */ }
        setPos({ x: window.innerWidth - 62, y: Math.round(window.innerHeight * 0.28) });
    }, []);

    // ── 拖拽逻辑(松手时按总位移判定点击,避免触屏抖动误判) ──
    const ballRef = useRef<HTMLDivElement>(null);
    const dragState = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0, lastX: 0, lastT: 0, vx: 0 });

    const onPointerDown = (e: React.PointerEvent) => {
        if (!pos) return;
        ballRef.current?.setPointerCapture?.(e.pointerId);
        dragState.current = { active: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, lastX: e.clientX, lastT: performance.now(), vx: 0 };
    };
    const onPointerMove = (e: React.PointerEvent) => {
        const d = dragState.current;
        if (!d.active || !pos) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        // 位移超过阈值才算拖动,轻微抖动不触发
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        const now = performance.now();
        if (now - d.lastT > 16) { d.vx = (e.clientX - d.lastX) / (now - d.lastT); d.lastX = e.clientX; d.lastT = now; }
        const w = 48, h = 48;
        const nx = Math.min(Math.max(dx + d.origX, 4), window.innerWidth - w - 4);
        const ny = Math.min(Math.max(dy + d.origY, 4), window.innerHeight - h - 4);
        setPos({ x: nx, y: ny });
    };
    const onPointerUp = (e: React.PointerEvent) => {
        const d = dragState.current;
        if (!d.active || !pos) { d.active = false; return; }
        d.active = false;
        const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        // 保存位置
        localStorage.setItem(POS_KEY, JSON.stringify(pos));
        // 甩向左边缘 → 消失
        if (d.vx < -0.55 && e.clientX < 64) {
            setDismissed(true);
            return;
        }
        // 位移小于 8px → 视为点击：面板开着就收起，没开就展开
        if (dist < 8) {
            setPanelOpen(open => !open);
        }
    };
    const onPointerCancel = () => {
        dragState.current.active = false;
    };

    // ── 一起听占位 ──
    const [identities, setIdentities] = useState<UserIdentity[]>([]);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [listenUserId, setListenUserId] = useState<string | null>(null);
    const [listenCharId, setListenCharId] = useState<string | null>(null);
    const [picker, setPicker] = useState<null | "user" | "char">(null);
    const [listenOpen, setListenOpen] = useState(false);
    /** 剧情播送中不允许一起听（聊天室会广播这个状态） */
    const [deliveryActive, setDeliveryActive] = useState(false);

    useEffect(() => {
        const onDeliveryState = (e: Event) => {
            const detail = (e as CustomEvent<{ active?: boolean }>).detail;
            setDeliveryActive(Boolean(detail?.active));
        };
        window.addEventListener("float:delivery-state", onDeliveryState as EventListener);
        return () => window.removeEventListener("float:delivery-state", onDeliveryState as EventListener);
    }, []);

    useEffect(() => {
        if (!panelOpen) return;
        try {
            setIdentities(loadUserIdentities());
            setCharacters(loadCharacters());
            setListenUserId(localStorage.getItem(LISTEN_USER_KEY));
            setListenCharId(localStorage.getItem(LISTEN_CHAR_KEY));
        } catch { /* ignore */ }
    }, [panelOpen]);

    const me = identities.find(i => i.id === listenUserId) ?? identities[0];
    const partner = characters.find(c => c.id === listenCharId) ?? characters[0];

    /** 离开聊天室 → 自动结束一起听（补一条结束标记）。
     *  例外：去音乐 App 不算离开（那里是播歌的地方，开着一起听去点歌很正常，回来还在）。 */
    useEffect(() => {
        if (!listenOpen) return;
        if (!currentApp || currentApp === "chat" || currentApp === "music") return;
        setListenOpen(false);
        if (partner) appendListenMarker(partner.id, "end");
    }, [currentApp, listenOpen, partner]);

    // ── 剧情投递面板(只读摘要 + 背景开关) ──
    const [deliveryList, setDeliveryList] = useState<EnsembleDeliveryPanelSummary[]>([]);
    const [previewId, setPreviewId] = useState<string | null>(null);
    const refreshDelivery = useCallback(() => {
        try { setDeliveryList(getEnsembleDeliveryPanelSummaries()); } catch { /* ignore */ }
    }, []);
    const toggleDeliveryBackground = useCallback((sessionId: string, enabled: boolean) => {
        setDeliveryBackgroundEnabled(sessionId, enabled);
        refreshDelivery();
        showToast(enabled ? "已开启本段剧情背景" : "已关闭本段剧情背景");
    }, [refreshDelivery, showToast]);
    useEffect(() => {
        if (panelOpen && tab === "delivery") refreshDelivery();
    }, [panelOpen, tab, refreshDelivery]);
    // 进入剧情模式时自动切到剧情投递标签(由聊天室派发;无活动剧情时不切换)
    useEffect(() => {
        const onFocus = () => { setPanelOpen(true); setTab("delivery"); };
        window.addEventListener("float:delivery-focus", onFocus);
        return () => window.removeEventListener("float:delivery-focus", onFocus);
    }, []);

    // ── API 快切(点击即时生效并持久化) ──
    const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
    const [currentApiId, setCurrentApiId] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [modelCache, setModelCache] = useState<Record<string, string[]>>({});
    const [modelLoading, setModelLoading] = useState<string | null>(null);
    const [modelError, setModelError] = useState<string | null>(null);

    const refreshApi = useCallback(() => {
        try {
            const configs = loadApiConfigs();
            setApiConfigs(configs);
            setCurrentApiId(loadBindingConfig().globalDefaults?.apiConfigId ?? configs[0]?.id ?? null);
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        if (panelOpen && tab === "api") refreshApi();
    }, [panelOpen, tab, refreshApi]);

    const toggleExpand = async (id: string) => {
        setModelError(null);
        if (expandedId === id) { setExpandedId(null); return; }
        setExpandedId(id);
        if (!modelCache[id]) {
            const cfg = apiConfigs.find(c => c.id === id);
            if (!cfg) return;
            setModelLoading(id);
            try {
                const names = await fetchModelNames(cfg);
                setModelCache(prev => ({ ...prev, [id]: names }));
            } catch (err) {
                setModelError(err instanceof Error ? err.message : "拉取模型列表失败");
            } finally {
                setModelLoading(null);
            }
        }
    };

    /** 切换到某节点+模型:立即写盘并生效,无草稿态 */
    const applySelection = (cfg: ApiConfig, model: string) => {
        try {
            const updated = apiConfigs.map(c => c.id === cfg.id ? { ...c, defaultModel: model } : c);
            saveApiConfigs(updated);
            const binding = loadBindingConfig();
            binding.globalDefaults = { ...binding.globalDefaults, apiConfigId: cfg.id };
            saveBindingConfig(binding, true);
            setApiConfigs(updated);
            setCurrentApiId(cfg.id);
            showToast(`已切换 ${cfg.name} · ${model} ✓`);
        } catch {
            showToast("切换失败,请重试");
        }
    };

    // ── 播放状态 ──
    const track = controls?.currentTrack ?? null;
    const isPlaying = controls?.isPlaying ?? false;
    const duration = playerDuration > 0 ? playerDuration : (track?.duration && track.duration > 0 ? track.duration : 0);
    const currentTime = player?.currentTime ?? 0;
    const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0;

    const fmt = (s: number) => {
        if (!Number.isFinite(s) || s < 0) s = 0;
        const m = Math.floor(s / 60), sec = Math.floor(s % 60);
        return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    };

    if (hidden) return null;

    // ══ 已甩出消失:左边缘恢复小把手 ══
    if (dismissed && !panelOpen) {
        return (
            <button className="mfb-restore" onClick={() => setDismissed(false)} aria-label="恢复悬浮球">
                ♪
            </button>
        );
    }

    const ringR = 21, ringC = 2 * Math.PI * ringR;

    return (
        <>
            {/* ── 悬浮球：始终显示，面板展开时也可点击/拖动（点球收起面板） ── */}
            {pos && (
                <div
                    ref={ballRef}
                    className={`mfb-ball ${isPlaying ? "mfb-playing" : ""} ${panelOpen ? "mfb-ball-open" : ""}`}
                    style={{ left: pos.x, top: pos.y }}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerCancel}
                >
                    <svg className="mfb-ring" viewBox="0 0 48 48">
                        <circle className="mfb-ring-bg" cx="24" cy="24" r={ringR} />
                        <circle
                            className="mfb-ring-fg"
                            cx="24" cy="24" r={ringR}
                            strokeDasharray={ringC}
                            strokeDashoffset={ringC * (1 - progress)}
                        />
                    </svg>
                    {track?.coverUrl ? (
                        <img className="mfb-cover" src={track.coverUrl} alt="" draggable={false} />
                    ) : (
                        <div className="mfb-cover mfb-cover-empty">♪</div>
                    )}
                </div>
            )}

            {/* ── 展开面板：吸附在悬浮球下方（球在下半屏时贴在球上方），点外部关闭 ── */}
            {panelOpen && (() => {
                const vw = typeof window !== "undefined" ? window.innerWidth : 375;
                const vh = typeof window !== "undefined" ? window.innerHeight : 700;
                const w = Math.min(340, vw * 0.88);
                const anchor = pos
                    ? (pos.y < vh * 0.55
                        ? { left: Math.min(Math.max(8, pos.x + 24 - w / 2), Math.max(8, vw - w - 8)), top: Math.min(pos.y + 56, vh - 120) }
                        : { left: Math.min(Math.max(8, pos.x + 24 - w / 2), Math.max(8, vw - w - 8)), top: Math.max(8, pos.y - 16), transform: "translateY(-100%)" })
                    : undefined;
                return (
                    <div className="mfb-mask mfb-mask-clear" onClick={() => setPanelOpen(false)}>
                        <div
                            className="mfb-panel"
                            data-anchored={anchor ? "" : undefined}
                            style={anchor}
                            onClick={(e) => e.stopPropagation()}
                        >
                        {/* 顶栏:tab + 菜单 */}
                        <div className="mfb-head">
                            <button className={`mfb-tab ${tab === "music" ? "mfb-tab-on" : ""}`} onClick={() => setTab("music")}>音乐</button>
                            <button className={`mfb-tab ${tab === "api" ? "mfb-tab-on" : ""}`} onClick={() => setTab("api")}>API</button>
                            <button className={`mfb-tab ${tab === "delivery" ? "mfb-tab-on" : ""}`} onClick={() => setTab("delivery")}>剧情</button>
                            <div className="mfb-head-right">
                                <button className="mfb-icon-btn" onClick={() => setPanelOpen(false)}>✕</button>
                            </div>
                        </div>

                        {toast && <div className="mfb-toast">{toast}</div>}

                        {/* ─────── 音乐 Tab ─────── */}
                        {tab === "music" && (
                            <div className="mfb-body">
                                {/* 一起听入口 */}
                                <div
                                    className="mfb-listen"
                                    onClick={() => {
                                        if (!partner) { showToast("先在右边选一个角色"); return; }
                                        if (deliveryActive) { showToast("剧情播送中，先把这段看完再来一起听"); return; }
                                        setListenOpen(true);
                                        appendListenMarker(partner.id, "start");
                                    }}
                                >
                                    <button
                                        className="mfb-avatar-btn"
                                        onClick={(e) => { e.stopPropagation(); setPicker("user"); }}
                                    >
                                        {me?.avatarUrl
                                            ? <img className="mfb-avatar" src={me.avatarUrl} alt="" />
                                            : <div className="mfb-avatar mfb-avatar-empty">我</div>}
                                        <span className="mfb-avatar-name">{me?.name ?? "我"}</span>
                                    </button>
                                    <span className="mfb-heart">❤</span>
                                    <button
                                        className="mfb-avatar-btn"
                                        onClick={(e) => { e.stopPropagation(); setPicker("char"); }}
                                    >
                                        {partner?.avatar
                                            ? <img className="mfb-avatar" src={partner.avatar} alt="" />
                                            : <div className="mfb-avatar mfb-avatar-empty">TA</div>}
                                        <span className="mfb-avatar-name">{partner?.name ?? "选择角色"}</span>
                                    </button>
                                </div>

                                {/* 当前播放卡片 */}
                                {track ? (
                                    <div className="mfb-player">
                                        <div className="mfb-player-top">
                                            {track.coverUrl
                                                ? <img className={`mfb-player-cover ${isPlaying ? "mfb-spin" : ""}`} src={track.coverUrl} alt="" />
                                                : <div className={`mfb-player-cover mfb-cover-empty ${isPlaying ? "mfb-spin" : ""}`}>♪</div>}
                                            <div className="mfb-player-meta">
                                                <div className="mfb-player-title">{track.title}</div>
                                                <div className="mfb-player-artist">{track.artist}</div>
                                            </div>
                                        </div>
                                        <div className="mfb-progress">
                                            <div className="mfb-progress-fill" style={{ width: `${progress * 100}%` }} />
                                        </div>
                                        <div className="mfb-time"><span>{fmt(currentTime)}</span><span>{fmt(duration)}</span></div>
                                        <div className="mfb-ctrls">
                                            <button className="mfb-ctrl" onClick={() => player?.prev()}>⏮</button>
                                            <button className="mfb-ctrl mfb-ctrl-main" onClick={() => controls?.togglePlay()}>{isPlaying ? "⏸" : "▶"}</button>
                                            <button className="mfb-ctrl" onClick={() => player?.next()}>⏭</button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="mfb-player mfb-player-idle">
                                        <div className="mfb-player-idle-text">还没有播放歌曲</div>
                                        <div className="mfb-player-idle-sub">去 音乐App 挑一首吧</div>
                                    </div>
                                )}

                                {/* 迷你播放列表 */}
                                {playlist.length > 0 && (
                                    <div className="mfb-queue">
                                        <div className="mfb-queue-title">播放列表</div>
                                        <div className="mfb-queue-list">
                                            {playlist.slice(0, 50).map((t, i) => (
                                                <button
                                                    key={t.id}
                                                    className={`mfb-queue-item ${t.id === track?.id ? "mfb-queue-on" : ""}`}
                                                    onClick={() => playTrack(t)}
                                                >
                                                    <span className="mfb-queue-idx">{i + 1}</span>
                                                    <span className="mfb-queue-name">{t.title}</span>
                                                    <span className="mfb-queue-artist">{t.artist}</span>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ─────── API Tab ─────── */}
                        {tab === "api" && (
                            <div className="mfb-body">
                                <div className="mfb-api-label">API NODE</div>
                                <div className="mfb-api-list">
                                    {apiConfigs.length === 0 && <div className="mfb-api-empty">还没有 API 配置,去设置里添加</div>}
                                    {apiConfigs.map(cfg => {
                                        const isCurrent = cfg.id === currentApiId;
                                        return (
                                            <div key={cfg.id} className={`mfb-api-node ${isCurrent ? "mfb-api-node-on" : ""}`}>
                                                <div className="mfb-api-node-head">
                                                    {/* 点名称 = 直接选中该节点(用其当前默认模型) */}
                                                    <button
                                                        className="mfb-api-select"
                                                        onClick={() => {
                                                            if (!cfg.defaultModel) { showToast("该节点还没设置模型,点 MODEL ▾ 选一个"); setExpandedId(cfg.id); return; }
                                                            if (isCurrent) { showToast("已经在用这个节点啦"); return; }
                                                            applySelection(cfg, cfg.defaultModel);
                                                        }}
                                                    >
                                                        <span className={`mfb-dot ${isCurrent ? "mfb-dot-solid" : "mfb-dot-hollow"}`} />
                                                        <span className="mfb-api-text">
                                                            <span className="mfb-api-name">{cfg.name}</span>
                                                            <span className="mfb-api-model">{cfg.defaultModel || "未设置模型"}</span>
                                                        </span>
                                                    </button>
                                                    {/* MODEL ▾ 只负责展开/收起模型列表 */}
                                                    <button className="mfb-api-chev" onClick={() => toggleExpand(cfg.id)}>
                                                        {expandedId === cfg.id ? "▴" : "MODEL ▾"}
                                                    </button>
                                                </div>
                                                {expandedId === cfg.id && (
                                                    <div className="mfb-model-list">
                                                        {modelLoading === cfg.id && <div className="mfb-model-status">拉取模型列表中…</div>}
                                                        {modelError && <div className="mfb-model-status mfb-model-err">{modelError}</div>}
                                                        {(modelCache[cfg.id] ?? []).map(m => (
                                                            <button
                                                                key={m}
                                                                className={`mfb-model-item ${m === cfg.defaultModel && isCurrent ? "mfb-model-on" : ""}`}
                                                                onClick={() => applySelection(cfg, m)}
                                                            >
                                                                <span className="mfb-model-dot" />
                                                                {m}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                                <div className="mfb-api-foot">
                                    <span className="mfb-api-current">
                                        当前生效 {apiConfigs.find(c => c.id === currentApiId)?.name ?? "—"} · {apiConfigs.find(c => c.id === currentApiId)?.defaultModel ?? "—"}
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* ─────── 剧情投递 Tab ─────── */}
                        {tab === "delivery" && (
                            <div className="mfb-body">
                                {deliveryList.length === 0 ? (
                                    <div className="mfb-model-status">暂无进行中的剧情投递<br />在群像 App 投递一幕后，这里会显示本段剧情背景</div>
                                ) : (
                                    deliveryList.map(({ session: s, scriptTitle, characterName, startedAt, originPreview, backgroundActive, sceneCount, hasArchive, worldBookCount, inactiveReason }) => (
                                        <div key={s.id} className={`mfb-dl-card ${backgroundActive ? "" : "mfb-dl-card-off"}`}>
                                            <div className="mfb-dl-head">
                                                <span className="mfb-dl-title">{scriptTitle}</span>
                                                <span className="mfb-dl-date">
                                                    {new Date(startedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                                                </span>
                                            </div>
                                            {characterName && <div className="mfb-dl-char">投递角色：{characterName}</div>}
                                            {originPreview && <div className="mfb-dl-origin">「{originPreview}」</div>}
                                            {backgroundActive ? (
                                                <div className="mfb-dl-scope">
                                                    <span>本段带入：剧本背景 · 此前剧情 {sceneCount} 幕{hasArchive ? " · 归档摘要" : ""}{worldBookCount > 0 ? ` · 世界书 ${worldBookCount} 本` : ""}</span>
                                                </div>
                                            ) : (
                                                <div className="mfb-dl-scope mfb-dl-scope-off">
                                                    {inactiveReason === "off" ? "本段剧情背景已关闭" : "来源剧本已删除，背景不可用"}
                                                </div>
                                            )}
                                            <div className="mfb-dl-actions">
                                                <button
                                                    className="mfb-dl-link"
                                                    onClick={() => {
                                                        if (!s.chatSessionId) return;
                                                        try {
                                                            window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "chat", sessionId: s.chatSessionId } }));
                                                        } catch { /* ignore */ }
                                                        setPanelOpen(false);
                                                    }}
                                                >
                                                    进入聊天室 →
                                                </button>
                                                {backgroundActive && (
                                                    <button
                                                        className="mfb-dl-link"
                                                        onClick={() => setPreviewId(previewId === s.id ? null : s.id)}
                                                    >
                                                        {previewId === s.id ? "收起背景" : "查看背景"}
                                                    </button>
                                                )}
                                            </div>
                                            {previewId === s.id && backgroundActive && (
                                                <div className="mfb-dl-preview">
                                                    {(() => {
                                                        try {
                                                            const bg = s.chatSessionId ? buildEnsembleDeliveryPromptBackground(s.chatSessionId) : null;
                                                            return bg?.block || "（本段暂无可注入的背景内容）";
                                                        } catch {
                                                            return "（背景读取失败）";
                                                        }
                                                    })()}
                                                </div>
                                            )}
                                            <div className="mfb-dl-toggle-row">
                                                <span className="mfb-dl-toggle-label">本段带入剧情背景</span>
                                                <button
                                                    className={`mfb-dl-toggle ${backgroundActive ? "mfb-dl-toggle-on" : ""}`}
                                                    onClick={() => toggleDeliveryBackground(s.id, !backgroundActive)}
                                                >
                                                    <span className="mfb-dl-toggle-dot" />
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        )}

                        {/* ── 一起听:头像选择弹层 ── */}
                        {picker && (
                            <div className="mfb-picker-mask" onClick={() => setPicker(null)}>
                                <div className="mfb-picker" onClick={(e) => e.stopPropagation()}>
                                    <div className="mfb-picker-title">{picker === "user" ? "选择我的身份" : "选择一起听角色"}</div>
                                    <div className="mfb-picker-list">
                                        {picker === "user" && identities.map(i => (
                                            <button
                                                key={i.id}
                                                className={`mfb-picker-item ${i.id === me?.id ? "mfb-picker-on" : ""}`}
                                                onClick={() => { setListenUserId(i.id); localStorage.setItem(LISTEN_USER_KEY, i.id); setPicker(null); }}
                                            >
                                                {i.avatarUrl ? <img className="mfb-avatar mfb-avatar-sm" src={i.avatarUrl} alt="" /> : <div className="mfb-avatar mfb-avatar-sm mfb-avatar-empty">{i.name.slice(0, 1)}</div>}
                                                {i.name}
                                            </button>
                                        ))}
                                        {picker === "char" && characters.map(c => (
                                            <button
                                                key={c.id}
                                                className={`mfb-picker-item ${c.id === partner?.id ? "mfb-picker-on" : ""}`}
                                                onClick={() => { setListenCharId(c.id); localStorage.setItem(LISTEN_CHAR_KEY, c.id); setPicker(null); }}
                                            >
                                                {c.avatar ? <img className="mfb-avatar mfb-avatar-sm" src={c.avatar} alt="" /> : <div className="mfb-avatar mfb-avatar-sm mfb-avatar-empty">{c.name.slice(0, 1)}</div>}
                                                {c.name}
                                            </button>
                                        ))}
                                        {((picker === "user" && identities.length === 0) || (picker === "char" && characters.length === 0)) && (
                                            <div className="mfb-model-status">暂无可选项</div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )})()}

            {/* ── 一起听全屏浮层 ── */}
            {listenOpen && partner && (
                <ListenTogetherOverlay
                    character={partner}
                    userName={me?.name ?? "我"}
                    userAvatar={me?.avatarUrl}
                    onClose={() => {
                        setListenOpen(false);
                        appendListenMarker(partner.id, "end");
                    }}
                />
            )}
        </>
    );
}
