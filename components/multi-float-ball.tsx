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
import "./../styles/multi-float.css";

type Props = {
    hidden: boolean;
};

const POS_KEY = "ai_phone_float_ball_pos";
const LISTEN_USER_KEY = "ai_phone_float_listen_user";
const LISTEN_CHAR_KEY = "ai_phone_float_listen_char";

export default function MultiFloatBall({ hidden }: Props) {
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
    const [tab, setTab] = useState<"music" | "api">("music");
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
        // 位移小于 8px → 视为点击,展开面板
        if (dist < 8) {
            setPanelOpen(true);
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

    // ── API 快切 ──
    type Draft = { configId: string; model: string } | null;
    const [apiConfigs, setApiConfigs] = useState<ApiConfig[]>([]);
    const [currentApiId, setCurrentApiId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft>(null);
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
        if (panelOpen && tab === "api") { refreshApi(); setDraft(null); }
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

    const selectModel = (cfg: ApiConfig, model: string) => {
        // 立即把该配置的默认模型写进配置存储,等「同步设置」时一起生效
        try {
            const updated = apiConfigs.map(c => c.id === cfg.id ? { ...c, defaultModel: model } : c);
            saveApiConfigs(updated);
            setApiConfigs(updated);
            setDraft({ configId: cfg.id, model });
            showToast(`已选 ${cfg.name} · ${model},点「同步设置」生效`);
        } catch {
            showToast("保存失败,请重试");
        }
    };

    const syncSettings = () => {
        if (!draft) return;
        try {
            const binding = loadBindingConfig();
            binding.globalDefaults = { ...binding.globalDefaults, apiConfigId: draft.configId };
            saveBindingConfig(binding, true);
            setCurrentApiId(draft.configId);
            setDraft(null);
            showToast("已同步,API 切换生效 ✓");
        } catch {
            showToast("同步失败,请重试");
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
            {/* ── 收起态小球 ── */}
            {pos && !panelOpen && (
                <div
                    ref={ballRef}
                    className={`mfb-ball ${isPlaying ? "mfb-playing" : ""}`}
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

            {/* ── 展开面板 ── */}
            {panelOpen && (
                <div className="mfb-mask" onClick={() => setPanelOpen(false)}>
                    <div className="mfb-panel" onClick={(e) => e.stopPropagation()}>
                        {/* 顶栏:tab + 菜单 */}
                        <div className="mfb-head">
                            <button className={`mfb-tab ${tab === "music" ? "mfb-tab-on" : ""}`} onClick={() => setTab("music")}>音乐</button>
                            <button className={`mfb-tab ${tab === "api" ? "mfb-tab-on" : ""}`} onClick={() => setTab("api")}>API</button>
                            <div className="mfb-head-right">
                                <button className="mfb-icon-btn" onClick={() => setPanelOpen(false)}>✕</button>
                            </div>
                        </div>

                        {toast && <div className="mfb-toast">{toast}</div>}

                        {/* ─────── 音乐 Tab ─────── */}
                        {tab === "music" && (
                            <div className="mfb-body">
                                {/* 一起听入口(占位) */}
                                <div
                                    className="mfb-listen"
                                    onClick={() => showToast("一起听功能开发中,敬请期待 💕")}
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
                                        const isDraft = draft?.configId === cfg.id;
                                        return (
                                            <div key={cfg.id} className={`mfb-api-node ${isCurrent || isDraft ? "mfb-api-node-on" : ""}`}>
                                                <button className="mfb-api-node-head" onClick={() => toggleExpand(cfg.id)}>
                                                    <span className={`mfb-dot ${isDraft ? "mfb-dot-solid" : isCurrent ? "mfb-dot-solid" : "mfb-dot-hollow"}`} />
                                                    <span className="mfb-api-name">{cfg.name}</span>
                                                    <span className="mfb-api-model">{cfg.defaultModel || "未设置模型"}</span>
                                                    <span className="mfb-api-chev">{expandedId === cfg.id ? "▴" : "MODEL ▾"}</span>
                                                </button>
                                                {expandedId === cfg.id && (
                                                    <div className="mfb-model-list">
                                                        {modelLoading === cfg.id && <div className="mfb-model-status">拉取模型列表中…</div>}
                                                        {modelError && <div className="mfb-model-status mfb-model-err">{modelError}</div>}
                                                        {(modelCache[cfg.id] ?? []).map(m => (
                                                            <button
                                                                key={m}
                                                                className={`mfb-model-item ${m === (draft?.configId === cfg.id ? draft.model : cfg.defaultModel) ? "mfb-model-on" : ""}`}
                                                                onClick={() => selectModel(cfg, m)}
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
                                        {draft
                                            ? <>已切 {apiConfigs.find(c => c.id === draft.configId)?.name} · {draft.model}</>
                                            : <>当前 {apiConfigs.find(c => c.id === currentApiId)?.name ?? "—"}</>}
                                    </span>
                                    <button className="mfb-sync-btn" disabled={!draft} onClick={syncSettings}>同步设置</button>
                                </div>
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
            )}
        </>
    );
}
