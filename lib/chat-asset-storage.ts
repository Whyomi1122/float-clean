import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "./theme-storage";
import type { ThemeAssetType } from "./theme-types";
import type { ChatMessage } from "./chat-storage";

/**
 * Prepare synthesized call audio for the existing voice bubble. Save these fields
 * with the chat message (or pass mediaUrl to persistMessageVoiceAudio for an
 * existing message). The data URL is durable in ChatDB and needs no URL revocation
 * or separate asset cleanup when its message is deleted.
 * synthesizedFromText must be the exact spoken text (the original for bilingual text).
 */
export async function prepareChatVoiceAudio(
    blob: Blob,
    synthesizedFromText: string,
    voiceDuration?: number,
): Promise<Pick<ChatMessage, "mediaType" | "mediaUrl" | "mediaData">> {
    if (!blob.size) throw new Error("Cannot persist empty voice audio");
    const mediaUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === "string") resolve(reader.result);
            else reject(new Error("Failed to read voice audio"));
        };
        reader.onerror = () => reject(reader.error || new Error("Failed to read voice audio"));
        reader.onabort = () => reject(new Error("Voice audio read aborted"));
        reader.readAsDataURL(blob);
    });
    return {
        mediaType: "audio",
        mediaUrl,
        mediaData: {
            label: synthesizedFromText,
            synthesizedFromText,
            ...(typeof voiceDuration === "number" && Number.isFinite(voiceDuration) && voiceDuration > 0
                ? { voiceDuration } : {}),
        },
    };
}

// We can leverage the existing IndexedDB logic in theme-storage.ts by 
// just casting a custom type like "chat_bg" to ThemeAssetType to store chat assets.

export async function saveChatImageToIndexedDB(blob: Blob): Promise<string> {
    // "chat_bg" is not in ThemeAssetType strictly, but JS at runtime doesn't care.
    return saveThemeAssetFromBlob(blob, "chat_bg" as ThemeAssetType);
}

export async function getChatImageFromIndexedDB(id: string): Promise<string | null> {
    return getThemeAssetDataUrl(id);
}
