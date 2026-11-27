"use client";

import { useEffect, useState } from "react";
import { Layers, X } from "lucide-react";
import type { EnsembleScript } from "@/lib/ensemble-storage";
import { buildSideStoryScript, inheritStoryClock } from "@/lib/side-story";

type Props = {
    parent: EnsembleScript | null;
    onClose: () => void;
    onCreated: (script: EnsembleScript, copiedWorldBooks: number) => void;
};

/**
 * 建番外向导（2026-11-27）
 *
 * 只收集"名字"和"要不要复制世界书"，其余全部按父剧本复制：
 * 阵容（人设快照）/ 模型 / 设置；开场白清空、场景设定预填、剧情时间继承父剧本当前时刻。
 */
export function SideStoryWizard({ parent, onClose, onCreated }: Props) {
    const [title, setTitle] = useState("");
    const [copyBooks, setCopyBooks] = useState(true);
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        if (!parent) return;
        setTitle(`${parent.title} · 番外`);
        setCopyBooks(true);
        setCreating(false);
    }, [parent?.id]);

    if (!parent) return null;

    const bookCount = (parent.worldBookIds ?? []).length;

    function handleCreate() {
        if (!parent || creating) return;
        setCreating(true);
        try {
            const result = buildSideStoryScript({ parent, title, copyWorldBooks: copyBooks });
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