"use client";

/**
 * 群像 · 下一步走向「选牌」弹窗
 *
 * 两张牌淡入后一左一右轻微倾斜叠在一起（120ms 先后）→ 点一张它抬到最前、
 * 转正、蓝光，另一张沉下去变暗 → 再点「就用这张」才采纳（避免误触）。
 * 每张牌右上「↻ 重抽」只重抽那一张，另一张不动。
 *
 * 只负责抽牌与展示；生成逻辑全在 lib/story-direction.ts，采纳后的指令拼装由
 * ensemble-app 处理。关掉 = 什么都没发生（唯一的写入是 "展示过即记" 的去重列表）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, RotateCcw, X } from "lucide-react";
import {
    clearLastBatch,
    DIRECTION_TYPE_LABEL,
    drawCardTypes,
    generateStoryDirectionCards,
    loadStoryDirectionState,
    pickTypeForRedraw,
    restoreLastBatch,
    type DirectionType,
    type StoryDirection,
    type StoryDirectionContext,
} from "@/lib/story-direction";

interface StoryDirectionSheetProps {
    open: boolean;
    /** 剧本 id：去重列表（recent）每次生成前现读，避免同一会话里越抽越像 */
    scriptId?: string;
    /** 当前回合数：重开弹窗时回合数没变就还原上次那两张，不重新抽 */
    turnCount?: number;
    context: StoryDirectionContext;
    onClose: () => void;
    onAdopt: (card: StoryDirection) => void;
    /** 展示过即记（跨批去重），不采纳也记 */
    onShown: (cards: StoryDirection[], turnCount?: number) => void;
}

const TYPE_ACCENT: Record<DirectionType, string> = {
    character: "#5B8FB9",
    you: "#8A6FB0",
    environment: "#4E9E8F",
    accident: "#C77B4A",
};

export default function StoryDirectionSheet({ open, scriptId, turnCount, context, onClose, onAdopt, onShown }: StoryDirectionSheetProps) {
    const [cards, setCards] = useState<StoryDirection[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [redrawingId, setRedrawingId] = useState<string | null>(null);
    const [adoptingId, setAdoptingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const requestSeq = useRef(0);
    const shownRef = useRef<StoryDirection[]>([]);

    const drawBatch = useCallback(async () => {
        const seq = ++requestSeq.current;
        setLoading(true);
        setError(null);
        setSelectedId(null);
        setAdoptingId(null);
        setCards([]);

        // 每次生成前现读 recent：同一会话里连抽也不会越抽越像
        const freshContext: StoryDirectionContext = {
            ...context,
            recentDirections: loadStoryDirectionState(scriptId).recent,
        };
        const types = drawCardTypes(freshContext.recentDirections ?? []);
        const result = await generateStoryDirectionCards(freshContext, { types });
        if (seq !== requestSeq.current) return;
        setLoading(false);
        if (result.cards.length === 0) {
            setError(result.error || "这次没抽出可用的卡，再试一次吧");
            return;
        }
        setCards(result.cards);
        shownRef.current = result.cards;
        onShown(result.cards, turnCount);
    }, [context, onShown, scriptId, turnCount]);

    useEffect(() => {
        if (!open) return;
        // 手滑关掉再打开：还原刚才那两张，不重新抽（重抽有单独的按钮）
        const saved = restoreLastBatch(scriptId, turnCount);
        if (saved.length > 0) {
            setCards(saved);
            setSelectedId(null);
            setAdoptingId(null);
            setError(null);
            setLoading(false);
            shownRef.current = saved;
            return;
        }
        void drawBatch();
        // 只在打开时抽一批；context 变化不重抽（避免边看边被换掉）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const redrawOne = useCallback(async (cardId: string) => {
        const target = cards.find(c => c.id === cardId);
        if (!target) return;
        const other = cards.find(c => c.id !== cardId);
        const nextType = pickTypeForRedraw((other?.type ?? target.type) as DirectionType);
        setRedrawingId(cardId);
        setError(null);
        const freshContext: StoryDirectionContext = {
            ...context,
            recentDirections: loadStoryDirectionState(scriptId).recent,
        };
        const result = await generateStoryDirectionCards(freshContext, { types: [nextType] });
        setRedrawingId(null);
        if (result.cards.length === 0) {
            setError(result.error || "重抽失败，再试一次吧");
            return;
        }
        const fresh = result.cards[0];
        setCards(prev => {
            const next = prev.map(c => (c.id === cardId ? fresh : c));
            shownRef.current = next;
            onShown(next, turnCount);
            return next;
        });
        if (selectedId === cardId) setSelectedId(fresh.id);
    }, [cards, context, onShown, scriptId, selectedId, turnCount]);

    const adopt = useCallback(() => {
        const chosen = cards.find(c => c.id === selectedId);
        if (!chosen) return;
        setAdoptingId(chosen.id);
        window.setTimeout(() => {
            onAdopt(chosen);
            // 这一批用掉了：下次打开要重新抽，不还原旧牌
            clearLastBatch(scriptId);
            setAdoptingId(null);
        }, 200);
    }, [cards, onAdopt, scriptId, selectedId]);

    /** 两张都不要：明确表示不满意，清掉这批，下次打开重新抽 */
    const discard = useCallback(() => {
        clearLastBatch(scriptId);
        onClose();
    }, [onClose, scriptId]);

    if (!open) return null;

    const chosen = cards.find(c => c.id === selectedId);

    return (
        <div className="sd-overlay" onClick={onClose} role="presentation">
            <style>{STYLE}</style>
            <div
                className="sd-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="下一步走向"
                onClick={e => e.stopPropagation()}
            >
                <div className="sd-head">
                    <div>
                        <h3>下一步走向</h3>
                        <p>抽两张，选一张，下一轮就照它发生</p>
                    </div>
                    <button type="button" className="sd-close" onClick={onClose} aria-label="关闭">
                        <X size={18} />
                    </button>
                </div>

                <div className="sd-deck">
                    {loading && (
                        <div className="sd-loading">
                            <span className="sd-dot" />
                            <span className="sd-dot" />
                            <span className="sd-dot" />
                            <em>正在抽牌…</em>
                        </div>
                    )}

                    {!loading && cards.map((card, index) => {
                        const isSelected = card.id === selectedId;
                        const dim = !!selectedId && !isSelected;
                        const extra = dim ? " sd-card-dim" : isSelected ? " sd-card-sel" : "";
                        return (
                            <button
                                key={card.id}
                                type="button"
                                className={`sd-card sd-card-${index === 0 ? "a" : "b"}${extra}${adoptingId === card.id ? " sd-card-out" : ""}`}
                                onClick={() => setSelectedId(isSelected ? null : card.id)}
                                aria-pressed={isSelected}
                            >
                                <span className="sd-card-top">
                                    <span className="sd-tag">
                                        <b style={{ background: TYPE_ACCENT[card.type] }} />
                                        {DIRECTION_TYPE_LABEL[card.type]}
                                    </span>
                                    <span
                                        role="button"
                                        tabIndex={0}
                                        className="sd-swap"
                                        onClick={e => {
                                            e.stopPropagation();
                                            if (redrawingId) return;
                                            void redrawOne(card.id);
                                        }}
                                        onKeyDown={e => {
                                            if (e.key !== "Enter" && e.key !== " ") return;
                                            e.preventDefault();
                                            e.stopPropagation();
                                            if (!redrawingId) void redrawOne(card.id);
                                        }}
                                    >
                                        {redrawingId === card.id ? "重抽中…" : (<><RotateCcw size={11} /> 重抽</>)}
                                    </span>
                                </span>
                                <span className="sd-title">{card.title}</span>
                                <span className="sd-kv">
                                    <i>会发生</i>
                                    <b>{card.event}</b>
                                </span>
                                <span className="sd-kv">
                                    <i>后果</i>
                                    <b>{card.consequence}</b>
                                </span>
                                <span className="sd-pick">{isSelected ? "✓ 已选中" : "点一下选中"}</span>
                            </button>
                        );
                    })}
                </div>

                {error && <p className="sd-error">{error}</p>}

                <div className="sd-foot">
                    {chosen ? (
                        <>
                            <button type="button" className="sd-btn sd-btn-ghost" onClick={() => setSelectedId(null)}>
                                <ChevronLeft size={14} /> 重选
                            </button>
                            <button type="button" className="sd-btn sd-btn-primary" onClick={adopt}>
                                就用这张
                            </button>
                        </>
                    ) : (
                        <>
                            <button type="button" className="sd-btn sd-btn-ghost" onClick={discard}>
                                两张都不要
                            </button>
                            <button type="button" className="sd-btn sd-btn-soft" onClick={() => void drawBatch()} disabled={loading}>
                                重抽一批
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

const STYLE = `
.sd-overlay{position:fixed; inset:0; z-index:120; background:rgba(12,18,26,.55); display:flex; align-items:center; justify-content:center; padding:0 14px; animation:sd-fade .18s ease-out}
.sd-sheet{width:100%; max-width:360px; border-radius:22px; background:#F6F8FA; padding:16px 14px 14px; box-shadow:0 26px 60px rgba(8,14,22,.4); animation:sd-rise .24s cubic-bezier(.22,.9,.3,1)}
@keyframes sd-fade{from{opacity:0}to{opacity:1}}
@keyframes sd-rise{from{opacity:0; transform:translateY(10px) scale(.985)}to{opacity:1; transform:none}}
.sd-head{display:flex; align-items:flex-start; gap:8px; margin-bottom:14px}
.sd-head h3{margin:0; font-size:17px; font-weight:800; color:var(--c-text-title)}
.sd-head p{margin:4px 0 0; font-size:11.5px; color:var(--c-text); opacity:.55}
.sd-close{margin-left:auto; width:30px; height:30px; border-radius:50%; border:none; background:rgba(0,0,0,.05); color:#6B7480; display:flex; align-items:center; justify-content:center}
.sd-deck{position:relative; height:322px; margin-bottom:12px}
.sd-loading{position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; color:var(--c-text); opacity:.6; font-size:12.5px}
.sd-dot{width:7px; height:7px; border-radius:50%; background:var(--c-primary); display:inline-block; animation:sd-blink 1s infinite ease-in-out}
.sd-dot:nth-child(2){animation-delay:.15s}
.sd-dot:nth-child(3){animation-delay:.3s}
@keyframes sd-blink{0%,100%{opacity:.25; transform:translateY(0)}50%{opacity:1; transform:translateY(-3px)}}
.sd-card{position:absolute; left:50%; top:0; width:244px; height:322px; margin-left:-122px; padding:15px 15px 13px;
  display:flex; flex-direction:column; text-align:left; background:var(--c-panel); color:var(--c-text);
  border:1px solid var(--c-card-border); border-radius:20px; cursor:pointer;
  box-shadow:0 16px 34px rgba(8,14,22,.18);
  transition:transform .26s cubic-bezier(.22,.9,.3,1), box-shadow .26s ease, opacity .26s ease, filter .26s ease;
  animation:sd-deal .32s cubic-bezier(.22,.9,.3,1) both}
.sd-card-a{transform:rotate(-6deg) translate(-34px,14px); z-index:2; animation-delay:.02s}
.sd-card-b{transform:rotate(5deg) translate(34px,-4px); z-index:3; animation-delay:.14s}
@keyframes sd-deal{from{opacity:0; transform:translate(0,14px) scale(.96)}}
.sd-card-sel{transform:rotate(0deg) translate(0,-6px) scale(1.03); z-index:5;
  box-shadow:0 26px 56px rgba(8,14,22,.3), 0 0 0 2px var(--c-primary) inset}
.sd-card-dim{transform:rotate(-11deg) translate(-54px,42px) scale(.94); opacity:.42; z-index:1; filter:saturate(.6)}
.sd-card-out{transform:translateY(-26px) scale(1.02); opacity:0; z-index:6}
.sd-card-top{display:flex; align-items:center; gap:6px}
.sd-tag{font-size:10.5px; font-weight:800; letter-spacing:.08em; color:#8B95A1; display:inline-flex; align-items:center}
.sd-tag b{width:6px; height:6px; border-radius:50%; margin-right:5px; display:inline-block}
.sd-swap{margin-left:auto; display:inline-flex; align-items:center; gap:3px; font-size:11px; font-weight:800;
  color:var(--c-primary-ink); background:var(--c-primary-soft); border-radius:999px; padding:4px 9px; cursor:pointer}
.sd-title{display:block; font-size:17px; font-weight:800; margin:9px 0 10px; color:var(--c-text-title)}
.sd-kv{display:block; margin-bottom:9px; font-size:12.5px; line-height:1.6}
.sd-kv i{display:block; font-style:normal; font-size:10.5px; letter-spacing:.06em; color:#98A2AE; margin-bottom:2px}
.sd-kv b{font-weight:700}
.sd-pick{margin-top:auto; text-align:center; font-size:11.5px; font-weight:800; color:#BCC6D2; padding-top:8px}
.sd-card-sel .sd-pick{color:var(--c-primary-ink)}
.sd-error{margin:0 0 10px; font-size:11.5px; font-weight:700; color:var(--c-danger); text-align:center}
.sd-foot{display:flex; gap:10px}
.sd-btn{flex:1; display:inline-flex; align-items:center; justify-content:center; gap:4px; padding:13px 10px; border-radius:14px; border:none;
  font-size:13.5px; font-weight:800; transition:transform .12s ease, opacity .12s ease}
.sd-btn:active{transform:scale(.98)}
.sd-btn:disabled{opacity:.5}
.sd-btn-ghost{background:var(--c-panel); color:#5B6673; border:1px solid var(--c-card-border)}
.sd-btn-soft{background:var(--c-primary-soft); color:var(--c-primary-ink)}
.sd-btn-primary{background:var(--c-primary); color:#fff; box-shadow:var(--c-primary-shadow)}
@media (prefers-reduced-motion: reduce){
  .sd-overlay,.sd-sheet,.sd-card,.sd-dot{animation:none !important}
  .sd-card{transition:opacity .15s linear}
}
`;
