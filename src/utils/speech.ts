import { getStoredToken } from '../api/client.ts';

const audioBlobUrlCache = new Map<string, string>();
let activeAudio: HTMLAudioElement | null = null;
let pendingSpeechTimeout: ReturnType<typeof setTimeout> | null = null;

export function stopSpeech(): void {
  if (pendingSpeechTimeout) {
    clearTimeout(pendingSpeechTimeout);
    pendingSpeechTimeout = null;
  }
  if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.currentTime = 0;
    } catch {
      // Ignore audio cleanup issues
    }
    activeAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore synthesis cancel errors
    }
  }
}

function playAudioElement(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(src);
    activeAudio = audio;
    let settled = false;

    const cleanup = () => {
      if (activeAudio === audio) {
        activeAudio = null;
      }
    };

    audio.onended = () => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    audio.onerror = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Audio load failed'));
      }
    };

    audio.play().catch((err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    });
  });
}

function speakWithBrowserSynthesis(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      resolve();
      return;
    }
    const synth = window.speechSynthesis;
    try {
      synth.cancel();
      synth.resume();
    } catch {
      // Ignore
    }

    pendingSpeechTimeout = setTimeout(() => {
      pendingSpeechTimeout = null;
      try {
        const utt = new SpeechSynthesisUtterance(text);
        utt.lang = 'en-US';
        utt.rate = 0.94;
        const voices = synth.getVoices();
        const enVoice =
          voices.find((v) => v.lang.toLowerCase().startsWith('en-us')) ||
          voices.find((v) => v.lang.toLowerCase().startsWith('en-gb')) ||
          voices.find((v) => v.lang.toLowerCase().startsWith('en'));
        if (enVoice) {
          utt.voice = enVoice;
        }
        utt.onend = () => resolve();
        utt.onerror = () => resolve();
        synth.speak(utt);
      } catch {
        resolve();
      }
    }, 60);
  });
}

export async function speakEnglish(text: string, audioUrl?: string): Promise<void> {
  const cleanText = text.trim();
  if (!cleanText) return;

  stopSpeech();

  // 1. Try direct Dictionary API audio URL if provided
  if (audioUrl && audioUrl.startsWith('http')) {
    const safeUrl = audioUrl.startsWith('//') ? `https:${audioUrl}` : audioUrl;
    try {
      await playAudioElement(safeUrl);
      return;
    } catch {
      // Fall through to same-origin TTS proxy
    }
  }

  // 2. Try same-origin MP3 TTS endpoint (cached on client & server, works even without local voices)
  const cacheKey = cleanText.toLowerCase();
  const cachedObjectUrl = audioBlobUrlCache.get(cacheKey);
  if (cachedObjectUrl) {
    try {
      await playAudioElement(cachedObjectUrl);
      return;
    } catch {
      audioBlobUrlCache.delete(cacheKey);
    }
  }

  try {
    const token = getStoredToken();
    const res = await fetch(`/api/audio/tts?text=${encodeURIComponent(cleanText)}`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size > 128) {
        const objectUrl = URL.createObjectURL(blob);
        if (audioBlobUrlCache.size > 60) {
          const oldest = audioBlobUrlCache.entries().next().value;
          if (oldest) {
            URL.revokeObjectURL(oldest[1]);
            audioBlobUrlCache.delete(oldest[0]);
          }
        }
        audioBlobUrlCache.set(cacheKey, objectUrl);
        await playAudioElement(objectUrl);
        return;
      }
    }
  } catch {
    // Fall through to repaired browser Web Speech API
  }

  // 3. Final fallback: repaired Web Speech synthesis
  await speakWithBrowserSynthesis(cleanText);
}
