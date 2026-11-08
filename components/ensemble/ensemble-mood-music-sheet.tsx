"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, RotateCw, Trash2, X, Loader2 } from "lucide-react";
import { useMusicControls } from "@/lib/music-context";
import type { ApiConfig } from "@/lib/settings-types";
import {
  MOOD_TRACK_LIMIT,
  loadMoodRecords,
  moodTrackToMusicTrack,
  refillMoodRecord,
  refreshMoodRecord,
  removeMoodRecord,
  setMoodRecordTracks,
  startMoodMusicJob,
  subscribeMoodMusic,
  type MoodMusicRecord,
} from "@/lib/ensemble-mood-music";

type Props = {
  scriptId: string;
  scriptTitle?: string;
  apiConfig: ApiConfig | null;
  plotText: string;
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EnsembleMoodMusicSheet({ scriptId, scriptTitle, apiConfig, plotText }: Props) {
  const controls = useMusicControls();
  const [instruction, setInstruction] = useState("");
  const [records, setRecords] = useState<MoodMusicRecord[]>(() => loadMoodRecords(scriptId));
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setRecords(loadMoodRecords(scriptId));
  }, [scriptId]);

  useEffect(() => {
    refresh();
    return subscribeMoodMusic(id => {
      if (id === scriptId) refresh();
    });
  }, [scriptId, refresh]);

  const running = useMemo(() => records.some(item => item.status === "running"), [records]);

  const handleGenerate = () => {
    if (!apiConfig || running) return;
    startMoodMusicJob({
      scriptId,
      scriptTitle,
      config: apiConfig,
      plotText,
      instruction: instruction.trim(),
    });
    setInstruction("");
    refresh();
  };

  const handleDeleteTrack = (record: MoodMusicRecord, trackId: string) => {
    const next = record.tracks.filter(item => item.trackId !== trackId);
    setMoodRecordTracks(scriptId, record.id, next);
    refresh();
    if (apiConfig && next.length < MOOD_TRACK_LIMIT) {
      void refillMoodRecord({ ...record, tracks: next }, apiConfig).then(refresh);
    }
  };

  const handleRefresh = async (record: MoodMusicRecord) => {
    if (!apiConfig) return;
    setBusyId(record.id);
    await refreshMoodRecord(record, apiConfig);
    setBusyId(null);
    refresh();
  };

  return (
    <div>
        <div className="bg-white rounded-[16px] p-3 mb-3">
          <textarea
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            placeholder="想听什么？可以直接写：请根据这几天海边旅游的剧情给他的心情配乐（留空就按最近剧情自动配）"
            className="w-full h-[62px] bg-transparent text-[12px] leading-relaxed text-[#111111] placeholder:text-black/25 outline-none resize-none"
          />
          <div className="flex items-center justify-between gap-3 mt-1">
            <span className="text-[10px] text-black/30 leading-relaxed">
              会先概括最近剧情（200 字内），再去找 4 首贴合心情的歌
            </span>
            <button
              onClick={handleGenerate}
              disabled={running || !apiConfig}
              className={`shrink-0 px-3.5 py-2 rounded-[11px] text-[12px] font-medium transition-all ${
                running || !apiConfig
                  ? "bg-black/[0.06] text-black/25"
                  : "bg-[#111111] text-white active:scale-[0.97]"
              }`}
            >
              {running ? "生成中" : apiConfig ? "生成" : "无模型"}
            </button>
          </div>
        </div>

        {records.length === 0 && (
          <div className="text-center text-[11.5px] text-black/30 py-8 leading-relaxed">
            还没有配过乐
            <br />
            写一句指令，让他把此刻的心情放出来
          </div>
        )}

        <div className="space-y-2.5">
          {records.map(record => (
            <div key={record.id} className="bg-white rounded-[14px] p-3">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[10px] text-black/30 shrink-0">{formatTime(record.createdAt)}</span>
                  {record.mood && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/[0.05] text-black/50 truncate">
                      {record.mood}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => {
                    removeMoodRecord(scriptId, record.id);
                    refresh();
                  }}
                  className="shrink-0 w-6 h-6 grid place-items-center rounded-full text-black/20 active:scale-90 transition-transform"
                  aria-label="删除记录"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {record.status === "running" && (
                <div className="flex items-center gap-2 text-[11.5px] text-black/40 py-2">
                  <Loader2 size={13} className="animate-spin" />
                  正在读剧情、找歌…可以离开这个页面，回来就在
                </div>
              )}

              {record.status === "failed" && (
                <div className="text-[11.5px] text-black/40 py-1.5 leading-relaxed">
                  {record.error || "生成失败"}
                </div>
              )}

              {record.summary && (
                <div className="text-[11.5px] leading-[1.75] text-black/55 mb-2.5">{record.summary}</div>
              )}

              {record.tracks.length > 0 && (
                <div className="space-y-1">
                  {record.tracks.map(track => (
                    <div key={track.trackId} className="flex items-center gap-2 group">
                      <button
                        onClick={() => controls.playTrack(moodTrackToMusicTrack(track))}
                        className="shrink-0 w-7 h-7 grid place-items-center rounded-full bg-black/[0.05] text-black/60 active:scale-90 transition-transform"
                        aria-label="播放"
                      >
                        <Play size={12} className="ml-[1px]" />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] text-[#111111] truncate">{track.title}</div>
                        <div className="text-[10px] text-black/35 truncate">{track.artist}</div>
                      </div>
                      <button
                        onClick={() => handleDeleteTrack(record, track.trackId)}
                        className="shrink-0 w-6 h-6 grid place-items-center rounded-full text-black/15 active:scale-90 transition-transform"
                        aria-label="移除"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {record.status === "done" && (
                <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-black/[0.05]">
                  <span className="text-[10px] text-black/25">
                    {record.tracks.length}/{MOOD_TRACK_LIMIT} 首
                  </span>
                  <button
                    onClick={() => handleRefresh(record)}
                    disabled={!apiConfig || busyId === record.id}
                    className="flex items-center gap-1 text-[11px] text-black/45 active:opacity-60 disabled:opacity-30"
                  >
                    <RotateCw size={11} className={busyId === record.id ? "animate-spin" : ""} />
                    换一批
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
    </div>
  );
}
