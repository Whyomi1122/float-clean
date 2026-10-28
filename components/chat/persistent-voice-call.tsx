"use client";

import { useEffect, useState } from "react";
import type { ChatSession } from "@/lib/chat-storage";
import type { Character } from "@/lib/character-types";
import { VoiceCallScreen } from "./voice-call-screen";

type ActiveCall = { session: ChatSession; character: Character; initiator: "user" | "character" };
const START = "float-start-voice-call";
export const VOICE_CALL_ENDED = "float-voice-call-ended";
let active: ActiveCall | null = null;
export function startPersistentVoiceCall(call: ActiveCall) {
    if (active) { window.dispatchEvent(new Event(START)); return; }
    active = call;
    window.dispatchEvent(new Event(START));
}

export function PersistentVoiceCall() {
    const [call, setCall] = useState<ActiveCall | null>(active);
    const [minimized, setMinimized] = useState(false);
    useEffect(() => {
        const sync = () => { setCall(active); setMinimized(false); };
        window.addEventListener(START, sync);
        return () => window.removeEventListener(START, sync);
    }, []);
    if (!call) return null;
    return <VoiceCallScreen
        session={call.session} character={call.character} initiator={call.initiator}
        minimized={minimized} onMinimize={() => setMinimized(true)} onRestore={() => setMinimized(false)}
        onEnd={() => {
            const sessionId = call.session.id;
            active = null;
            setCall(null);
            window.dispatchEvent(new CustomEvent(VOICE_CALL_ENDED, { detail: { sessionId } }));
        }}
    />;
}
