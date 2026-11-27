"use client";

import { useEffect, useState } from "react";
import { Layers, X } from "lucide-react";
import type { EnsembleScript } from "@/lib/ensemble-storage";
import { buildSideStoryScript, inheritStoryClock } from "@/lib/side-story";

type CastCandidate = {
    id: string;
    name: string;
    avatar?: string | null;
    persona: string;
    /** 这张卡绑的面具名（没绑就传空） */
    maskName?: string;
};

type Props = {
    parent: EnsembleScript | null;
    /** 可补充的角色卡（除父剧本阵容外的全部角色） */
    candidates?: CastCandidate[];
    onClose: () => void;
    onCreated: (script: EnsembleScript, copiedWorldBooks: number) => void;
};

/**
 * 建番外向导（2026-11-27）
 *
 * 收集"名字 / 要不要复制世界书 / 要不要补充参演角色"，其余全部按父剧本复制：
 * 阵容（人设快照）/ 模型 / 设置；开场白清空、场景设定预填、剧情时间继承父剧本当前时刻。
 * 补充的角色只写本番外 cast 快照，不动角色卡本体、不动父剧本。
 */
export function SideStoryWizard({ parent, candidates = [], onClose, onCreated }: Props) {
    const [title, setTitle] = useState("");
    const [copyBooks, setCopyBooks] = useState(true);
    const [extraIds, setExtraIds] = useState<string[]>([]);
    const [showPicker, setShowPicker] = useState(false);
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        if (!parent) return;
        setTitle(`${parent.title} · 番外`);
        setCopyBooks(true);
        setExtraIds([]);
        setShowPicker(false);
        setCreating(false);
    }, [parent?.id]);

    if (!parent) return null;

    const bookCount = (parent.worldBookIds ?? []).length;
    const inCast = new Set((parent.cast ?? []).map(member => member.id));
    const pickable = candidates.filter(candidate => !inCast.has(candidate.id));

    function toggleExtra(id: string) {
        setExtraIds(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]));
    }

    function handleCreate() {
        if (!parent || creating) return;
        setCreating(true);
        try {
            const extraCast = candidates
                .filter(candidate => extraIds.includes(candidate.id))
                .map(candidate => ({
                    id: candidate.id,
                    name: candidate.name,
                    avatar: candidate.avatar ?? "",
                    persona: candidate.persona,
                }));
            const result = buildSideStoryScript({ parent, title, copyWorldBooks: copyBooks, extraCast });
            inheritStoryClock(parent, result.script);
            onCreated(result.script, result.copiedWorldBooks.length);
        } finally {
            setCreating(false);
        }
    }

    return (
        <div
            className="absolute inset-0 z-[60] flex items-end justify-center"
            style={{ background: "rgba(0,0,0,0.28)" }}
            onClick={onClose}
        >
            <div
                className="w-full max-h-[86%] overflow-y-auto rounded-t-3xl bg-[#FAF7F2] p-5 pb-7"
                style={{ touchAction: "manipulation" }}
                onClick={event => event.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Layers size={16} className="text-[#8a7550]" />
                        <span className="text-sm font-semibold text-[#1a1a1a]">新建番外</span>
                    </div>
                    <button type="button" onClick={onClose} className="p-1 text-black/30">
                        <X size={16} />
                    </button>
                </div>

                <p className="mt-2 text-[12px] leading-relaxed text-black/50">
                    番外是<strong>另一个剧本</strong>：剧情、归档、走向卡、时间线都和主线各管各的。
                    它的杀青归档会进「番外记忆库」，不会自动影响角色记忆。
                </p>

                <div className="mt-4">
                    <label className="text-[12px] text-black/45">番外标题</label>
                    <input
                        value={title}
                        onChange={event => setTitle(event.target.value)}
                        className="mt-1 w-full rounded-xl border border-black/[0.08] bg-white px-3 py-2 text-[13px] outline-none"
                        placeholder="例如：反80 · if 线：庭审之后"
                    />
                </div>

                <div className="mt-4 rounded-2xl bg-white/70 px-4 py-3 text-[12px] leading-relaxed text-black/55">
                    <div className="font-medium text-[#1a1a1a]">会从《{parent.title}》复制</div>
                    <ul className="mt-1.5 list-disc pl-4 space-y-0.5">
                        <li>阵容 {parent.cast.length} 人（人设是快照，之后改角色卡不影响这里）</li>
                        <li>模型绑定与每轮设置、自定义样式</li>
                        <li>剧情时间：从主线此刻开始，之后在番外功能页单独拨</li>
                        <li>世界书 {bookCount} 本 → <strong>复制成副本</strong>，改番外不会动到主线</li>
                    </ul>
                    <div className="mt-1.5 text-black/40">
                        不复制：剧情、归档、章节、走向卡、开场白（需要自己写）。
                    </div>
                    {bookCount > 0 && (
                        <label className="mt-2 flex items-center gap-2 text-[12px] text-black/55">
                            <input
                                type="checkbox"
                                checked={copyBooks}
                                onChange={event => setCopyBooks(event.target.checked)}
                            />
                            复制世界书副本（建议保持勾选）
                        </label>
                    )}
                </div>

                <div className="mt-3 rounded-2xl bg-white/70 px-4 py-3">
                    <button
                        type="button"
                        onClick={() => setShowPicker(prev => !prev)}
                        className="flex w-full items-center justify-between text-left text-[12px]"
                    >
                        <span className="font-medium text-[#1a1a1a]">补充参演角色（可选）</span>
                        <span className="text-black/45">
                            {extraIds.length > 0 ? `已选 ${extraIds.length} 人` : "不补充"}
                        </span>
                    </button>
                    {showPicker && (
                        <div className="mt-2">
                            {pickable.length === 0 ? (
                                <p className="text-[12px] text-black/40">没有可补充的角色卡。</p>
                            ) : (
                                <div className="max-h-[184px] space-y-1 overflow-y-auto pr-1">
                                    {pickable.map(candidate => (
                                        <label
                                            key={candidate.id}
                                            className="flex items-center gap-2 rounded-lg px-1 py-1 text-[12px] text-black/65"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={extraIds.includes(candidate.id)}
                                                onChange={() => toggleExtra(candidate.id)}
                                            />
                                            <span className="truncate">{candidate.name}</span>
                                            {candidate.maskName ? (
                                                <span className="ml-auto shrink-0 text-[11px] text-black/35">
                                                    {candidate.maskName}
                                                </span>
                                            ) : null}
                                        </label>
                                    ))}
                                </div>
                            )}
                            <p className="mt-1.5 text-[11px] leading-relaxed text-black/40">
                                只写本番外的人设快照，不改角色卡本体，也不改《{parent.title}》的阵容。
                            </p>
                        </div>
                    )}
                </div>

                <div className="mt-5 flex gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex-1 rounded-xl bg-black/[0.06] py-2.5 text-[13px] text-black/60"
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        onClick={handleCreate}
                        disabled={creating || !title.trim()}
                        className="flex-1 rounded-xl py-2.5 text-[13px] text-white disabled:opacity-50"
                        style={{ background: "#5B8FB9" }}
                    >
                        {creating ? "创建中…" : "创建番外"}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default SideStoryWizard;