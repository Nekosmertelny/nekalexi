from __future__ import annotations

import asyncio
import json
import os
import random
import re
import time
from typing import Any, Literal

from google import genai
from google.genai import types

from dictionary import (
    DictionaryLookupResult,
    lookup_tatoeba_examples,
    translate_english_to_russian,
    translate_sentences_batch_en_to_ru,
)

PRIMARY_MODEL = "gemini-4-hydrogen"
FALLBACK_MODEL = "gemini-3.1-flash-lite"
MODEL_COOLDOWN_SEC = 10 * 60

_model_cooldown_until: dict[str, float] = {}
_last_quota_error_by_model: dict[str, str] = {}
_HAS_CYRILLIC_RE = re.compile(r"[а-яё]", re.IGNORECASE)


class AiServiceError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def _get_gemini_client() -> genai.Client | None:
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key or api_key == "MY_GEMINI_API_KEY":
        return None
    return genai.Client(api_key=api_key)


def _is_quota_error(msg: str) -> bool:
    low = msg.lower()
    return "429" in msg or "resource_exhausted" in low or "quota exceeded" in low or "rate-limit" in low


def _is_auth_error(msg: str) -> bool:
    low = msg.lower()
    return "403" in msg or "permission_denied" in low or "api_key_invalid" in low or "api key not valid" in low


def _extract_retry_hint_ru(msg: str) -> str:
    m = re.search(r"Please retry in ([^.\"\\]+)", msg, re.IGNORECASE)
    if not m:
        return ""
    raw = m.group(1)
    parts: list[str] = []
    h = re.search(r"(\d+)h", raw)
    mi = re.search(r"(\d+)m", raw)
    s = re.search(r"(\d+(?:\.\d+)?)s", raw)
    if h:
        parts.append(f"{h.group(1)} ч")
    if mi:
        parts.append(f"{mi.group(1)} мин")
    if not h and not mi and s:
        parts.append(f"{int(float(s.group(1))) + 1} сек")
    return f" Повтор через ~{' '.join(parts)}." if parts else ""


def to_friendly_ai_error(err: Exception) -> AiServiceError:
    if isinstance(err, AiServiceError):
        return err
    msg = str(err)
    if _is_quota_error(msg):
        return AiServiceError(
            429,
            "QUOTA_EXHAUSTED",
            f"Дневной лимит бесплатных запросов Gemini API исчерпан.{_extract_retry_hint_ru(msg)} "
            "Для увеличения квоты выберите ключ с платным тарифом в Settings > Secrets или воспользуйтесь локальной проверкой по словарю.",
        )
    if _is_auth_error(msg):
        return AiServiceError(
            403,
            "AUTH_ERROR",
            "Ключ Gemini API отклонён или недействителен.",
        )
    if "404" in msg or "NOT_FOUND" in msg:
        return AiServiceError(
            502,
            "MODEL_ERROR",
            "Выбранная модель ИИ временно недоступна. Попробуйте повторить запрос чуть позже.",
        )
    return AiServiceError(
        502,
        "MODEL_ERROR",
        "Не удалось получить ответ от ИИ-наставника. Попробуйте повторить запрос.",
    )


def _generate_with_fallback_sync(client: genai.Client, contents: str, schema: dict[str, Any]) -> str:
    now = time.time()
    available = [m for m in (PRIMARY_MODEL, FALLBACK_MODEL) if _model_cooldown_until.get(m, 0) <= now]
    if not available:
        cached = _last_quota_error_by_model.get(PRIMARY_MODEL) or _last_quota_error_by_model.get(FALLBACK_MODEL)
        if cached:
            raise to_friendly_ai_error(RuntimeError(cached))
        raise AiServiceError(
            429,
            "QUOTA_EXHAUSTED",
            "Дневной лимит бесплатных запросов Gemini API исчерпан. Используется перевод по словарю и локальная проверка.",
        )

    last_err: Exception | None = None
    quota_err: Exception | None = None
    for model in available:
        for attempt in range(2):
            try:
                res = client.models.generate_content(
                    model=model,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=schema,
                    ),
                )
                _model_cooldown_until.pop(model, None)
                _last_quota_error_by_model.pop(model, None)
                return (res.text or "{}").strip()
            except Exception as exc:
                last_err = exc
                msg = str(exc)
                if _is_quota_error(msg):
                    quota_err = exc
                    _model_cooldown_until[model] = time.time() + MODEL_COOLDOWN_SEC
                    _last_quota_error_by_model[model] = msg
                    break
                if _is_auth_error(msg):
                    raise to_friendly_ai_error(exc) from exc
                if attempt == 0 and any(k in msg for k in ("500", "503", "UNAVAILABLE", "TIMEOUT")):
                    time.sleep(0.7)
                    continue
                break

    raise to_friendly_ai_error(quota_err or last_err or RuntimeError("AI error"))


def _is_valid_russian(text: str | None, source_word: str) -> bool:
    if not text:
        return False
    clean = text.strip()
    if not clean or clean.lower() == source_word.strip().lower():
        return False
    return bool(_HAS_CYRILLIC_RE.search(clean))


async def enrich_vocabulary_word(
    raw_word: str,
    dict_res: DictionaryLookupResult | None = None,
    user_translation: str | None = None,
    preferred_pos: str | None = None,
) -> dict[str, Any]:
    word = raw_word.strip()
    effective_pos = (preferred_pos or (dict_res or {}).get("partOfSpeech") or "noun").strip()
    examples = (dict_res or {}).get("englishExamples") or []
    needs_tatoeba = len(examples) < 2
    needs_trans = not _is_valid_russian(user_translation, word)

    trans_coro = (
        translate_english_to_russian(word, effective_pos)
        if needs_trans
        else asyncio.sleep(0, result=(user_translation or "").strip())
    )
    tatoeba_coro = lookup_tatoeba_examples(word) if needs_tatoeba else asyncio.sleep(0, result=[])
    translated_word, tatoeba_pairs = await asyncio.gather(trans_coro, tatoeba_coro)

    ex1 = examples[0] if len(examples) > 0 else ""
    tr1 = ""
    if not ex1 and tatoeba_pairs:
        ex1 = tatoeba_pairs[0]["en"]
        tr1 = tatoeba_pairs[0]["ru"]
    if not ex1:
        ex1 = f'I often hear "{word}" in everyday English conversations.'

    ex2 = examples[1] if len(examples) > 1 else ""
    tr2 = ""
    alt_tatoeba = next((p for p in tatoeba_pairs if p["en"] != ex1), None)
    if not ex2 and alt_tatoeba:
        ex2 = alt_tatoeba["en"]
        tr2 = alt_tatoeba["ru"]
    if not ex2:
        ex2 = f'Try using "{word}" in a short sentence today.'

    to_translate: list[str] = []
    if not tr1:
        to_translate.append(ex1)
    if not tr2:
        to_translate.append(ex2)
    if to_translate:
        translated_batch = await translate_sentences_batch_en_to_ru(to_translate)
        idx = 0
        if not tr1:
            tr1 = translated_batch[idx] if idx < len(translated_batch) else ""
            idx += 1
        if not tr2:
            tr2 = translated_batch[idx] if idx < len(translated_batch) else ""

    final_translation = (user_translation or "").strip() or translated_word or word
    return {
        "word": word,
        "phonetic": (dict_res or {}).get("phonetic", ""),
        "partOfSpeech": effective_pos,
        "translation": final_translation,
        "exampleEn": ex1,
        "exampleRu": tr1 or f"Постарайтесь естественно использовать слово «{word}» в английской речи.",
        "secondaryExampleEn": ex2,
        "secondaryExampleRu": tr2 or f"Попробуйте составить короткое предложение со словом «{word}».",
        "cefrLevel": "B1",
        "aiGenerated": False,
    }


async def evaluate_context_writing(target_words: list[str], user_sentence: str) -> dict[str, Any]:
    client = _get_gemini_client()
    if not client:
        raise AiServiceError(
            503,
            "UNCONFIGURED",
            "GEMINI_API_KEY не настроен. Добавьте ключ в Settings > Secrets для ИИ-проверки грамматики.",
        )

    words_list = ", ".join(f'"{w}"' for w in target_words)
    prompt = f"""You are an expert English language tutor helping a Russian-speaking student practice active vocabulary.
Target vocabulary word(s): {words_list}.
Student's English text:
\"\"\"
{user_sentence}
\"\"\"
Analyze grammar, naturalness, and target word usage. Return feedbackRu and grammarNotes in Russian, correctedSentence in English, and 2 improvedVariants (en, ru, tone)."""

    schema = {
        "type": "OBJECT",
        "properties": {
            "isCorrect": {"type": "BOOLEAN"},
            "grammarScore": {"type": "INTEGER"},
            "naturalnessScore": {"type": "INTEGER"},
            "usedTargetWordsCorrectly": {"type": "BOOLEAN"},
            "correctedSentence": {"type": "STRING"},
            "feedbackRu": {"type": "STRING"},
            "grammarNotes": {"type": "ARRAY", "items": {"type": "STRING"}},
            "improvedVariants": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "en": {"type": "STRING"},
                        "ru": {"type": "STRING"},
                        "tone": {"type": "STRING"},
                    },
                    "required": ["en", "ru", "tone"],
                },
            },
        },
        "required": [
            "isCorrect", "grammarScore", "naturalnessScore", "usedTargetWordsCorrectly",
            "correctedSentence", "feedbackRu", "grammarNotes", "improvedVariants",
        ],
    }

    raw_text = await asyncio.to_thread(_generate_with_fallback_sync, client, prompt, schema)
    parsed = json.loads(raw_text)
    return {
        "isCorrect": bool(parsed.get("isCorrect")),
        "grammarScore": max(0, min(100, int(parsed.get("grammarScore", 75)))),
        "naturalnessScore": max(0, min(100, int(parsed.get("naturalnessScore", 75)))),
        "usedTargetWordsCorrectly": bool(parsed.get("usedTargetWordsCorrectly")),
        "correctedSentence": parsed.get("correctedSentence") or user_sentence,
        "feedbackRu": parsed.get("feedbackRu") or "Предложение проверено.",
        "grammarNotes": parsed.get("grammarNotes") if isinstance(parsed.get("grammarNotes"), list) else [],
        "improvedVariants": parsed.get("improvedVariants") if isinstance(parsed.get("improvedVariants"), list) else [],
        "aiGenerated": True,
    }


async def generate_learning_report(snapshot: dict[str, Any]) -> dict[str, Any]:
    client = _get_gemini_client()
    if not client:
        raise AiServiceError(503, "UNCONFIGURED", "GEMINI_API_KEY не настроен.")

    hardest = ", ".join(f"{h['word']} ({h['translation']})" for h in snapshot.get("hardestWords", [])) or "нет"
    topics = ", ".join(snapshot.get("recentTopics", [])) or "Базовая лексика"
    prompt = f"""Generate a structured, personalized English learning analytics report in Russian for student "{snapshot['userName']}".
Level: {snapshot['level']}, XP: {snapshot['xp']}, Streak: {snapshot['streakDays']} days,
Words: {snapshot['totalWords']} (mastered {snapshot['masteredWords']}, learning {snapshot['learningWords']}, due {snapshot['dueWords']}),
14d reviews: {snapshot['reviewsLast14Days']}, Accuracy: {snapshot['accuracyPercent']}%, Avg grammar: {snapshot['avgGrammarScore']}/100,
Hardest words: {hardest}, Topics: {topics}."""

    schema = {
        "type": "OBJECT",
        "properties": {
            "title": {"type": "STRING"},
            "summaryRu": {"type": "STRING"},
            "strengths": {"type": "ARRAY", "items": {"type": "STRING"}},
            "focusAreas": {"type": "ARRAY", "items": {"type": "STRING"}},
            "actionPlan": {"type": "ARRAY", "items": {"type": "STRING"}},
            "predictedMilestone": {"type": "STRING"},
        },
        "required": ["title", "summaryRu", "strengths", "focusAreas", "actionPlan", "predictedMilestone"],
    }
    raw_text = await asyncio.to_thread(_generate_with_fallback_sync, client, prompt, schema)
    parsed = json.loads(raw_text)
    return {
        "title": parsed.get("title") or "Персональный отчет по прогрессу",
        "summaryRu": parsed.get("summaryRu") or "",
        "strengths": parsed.get("strengths") or [],
        "focusAreas": parsed.get("focusAreas") or [],
        "actionPlan": parsed.get("actionPlan") or [],
        "predictedMilestone": parsed.get("predictedMilestone") or "",
        "aiGenerated": True,
    }


def _build_dictionary_fallback_prompt(
    target_words: list[str],
    direction: Literal["ru_to_en", "en_to_ru"],
    db_hints: list[dict[str, Any]],
    reason_notice: str | None = None,
) -> dict[str, Any]:
    candidates: list[dict[str, str]] = []
    for item in db_hints:
        if item.get("exampleEn") and item.get("exampleRu"):
            candidates.append(
                {
                    "sourceSentence": item["exampleRu"] if direction == "ru_to_en" else item["exampleEn"],
                    "referenceTranslation": item["exampleEn"] if direction == "ru_to_en" else item["exampleRu"],
                    "hint": (
                        f"Используйте слово «{item['word']}» ({item['translation']})."
                        if direction == "ru_to_en"
                        else f"Ключевое слово: «{item['word']}» — {item['translation']}."
                    ),
                    "cefrLevel": item.get("cefrLevel") or "A2–B1",
                }
            )
    if candidates:
        picked = random.choice(candidates)
        return {
            "direction": direction,
            "sourceSentence": picked["sourceSentence"],
            "targetWords": target_words,
            "hint": picked["hint"],
            "cefrLevel": picked["cefrLevel"],
            "aiGenerated": False,
            "fallbackNotice": reason_notice,
            "referenceTranslation": picked["referenceTranslation"],
        }

    primary_word = target_words[0] if target_words else "practice"
    ru_hint = db_hints[0]["translation"] if db_hints else primary_word
    return {
        "direction": direction,
        "sourceSentence": (
            f"Я хочу использовать слово «{ru_hint}» в простом предложении на каждый день."
            if direction == "ru_to_en"
            else f'I often use "{primary_word}" when I talk about my daily plans.'
        ),
        "targetWords": target_words,
        "hint": f"Целевое слово: {primary_word}.",
        "cefrLevel": "A2–B1",
        "aiGenerated": False,
        "fallbackNotice": reason_notice,
        "referenceTranslation": (
            f'I want to use "{primary_word}" in a simple everyday sentence.'
            if direction == "ru_to_en"
            else f"Я часто использую «{ru_hint}», когда говорю о планах на день."
        ),
    }


async def generate_translation_prompt(
    target_words: list[str],
    direction: Literal["ru_to_en", "en_to_ru"],
    db_hints: list[dict[str, Any]],
) -> dict[str, Any]:
    client = _get_gemini_client()
    if not client:
        return _build_dictionary_fallback_prompt(
            target_words, direction, db_hints, "Используется задание из вашего словаря (GEMINI_API_KEY не настроен)."
        )
    words_list = ", ".join(f'"{w}"' for w in target_words)
    instruction = (
        f"Generate ONE clear everyday A2–B1 Russian sentence prompting translation into English with: {words_list}."
        if direction == "ru_to_en"
        else f"Generate ONE clear everyday A2–B1 English sentence using: {words_list} for translation into Russian."
    )
    schema = {
        "type": "OBJECT",
        "properties": {
            "sourceSentence": {"type": "STRING"},
            "hint": {"type": "STRING"},
            "cefrLevel": {"type": "STRING"},
        },
        "required": ["sourceSentence", "hint", "cefrLevel"],
    }
    try:
        raw_text = await asyncio.to_thread(_generate_with_fallback_sync, client, instruction, schema)
        parsed = json.loads(raw_text)
        return {
            "direction": direction,
            "sourceSentence": parsed.get("sourceSentence", ""),
            "targetWords": target_words,
            "hint": parsed.get("hint", ""),
            "cefrLevel": parsed.get("cefrLevel", "B1"),
            "aiGenerated": True,
        }
    except Exception as exc:
        friendly = to_friendly_ai_error(exc)
        return _build_dictionary_fallback_prompt(target_words, direction, db_hints, friendly.message)


async def evaluate_translation_attempt(
    direction: Literal["ru_to_en", "en_to_ru"],
    source_sentence: str,
    user_translation: str,
    target_words: list[str],
) -> dict[str, Any]:
    client = _get_gemini_client()
    if not client:
        raise AiServiceError(503, "UNCONFIGURED", "GEMINI_API_KEY не настроен.")

    prompt = (
        f"Evaluate bilingual translation ({direction}). Source: {source_sentence}. "
        f"Student translation: {user_translation}. Target words: {', '.join(target_words)}. "
        "Provide JSON with isCorrect, grammarScore, naturalnessScore, usedTargetWordsCorrectly, correctedSentence, feedbackRu, grammarNotes, improvedVariants."
    )
    schema = {
        "type": "OBJECT",
        "properties": {
            "isCorrect": {"type": "BOOLEAN"},
            "grammarScore": {"type": "INTEGER"},
            "naturalnessScore": {"type": "INTEGER"},
            "usedTargetWordsCorrectly": {"type": "BOOLEAN"},
            "correctedSentence": {"type": "STRING"},
            "feedbackRu": {"type": "STRING"},
            "grammarNotes": {"type": "ARRAY", "items": {"type": "STRING"}},
            "improvedVariants": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "en": {"type": "STRING"},
                        "ru": {"type": "STRING"},
                        "tone": {"type": "STRING"},
                    },
                    "required": ["en", "ru", "tone"],
                },
            },
        },
        "required": [
            "isCorrect", "grammarScore", "naturalnessScore", "usedTargetWordsCorrectly",
            "correctedSentence", "feedbackRu", "grammarNotes", "improvedVariants",
        ],
    }
    raw_text = await asyncio.to_thread(_generate_with_fallback_sync, client, prompt, schema)
    parsed = json.loads(raw_text)
    return {
        "isCorrect": bool(parsed.get("isCorrect")),
        "grammarScore": max(0, min(100, int(parsed.get("grammarScore", 75)))),
        "naturalnessScore": max(0, min(100, int(parsed.get("naturalnessScore", 75)))),
        "usedTargetWordsCorrectly": bool(parsed.get("usedTargetWordsCorrectly")),
        "correctedSentence": parsed.get("correctedSentence") or user_translation,
        "feedbackRu": parsed.get("feedbackRu") or "Перевод проверен.",
        "grammarNotes": parsed.get("grammarNotes") or [],
        "improvedVariants": parsed.get("improvedVariants") or [],
        "aiGenerated": True,
    }


def evaluate_locally_without_ai(
    mode: Literal["free", "ru_to_en", "en_to_ru"],
    user_text: str,
    target_words: list[str],
    db_hints: list[dict[str, Any]],
    source_sentence: str | None = None,
) -> dict[str, Any]:
    normalized = user_text.strip().lower()
    matching = next(
        (
            h
            for h in db_hints
            if not source_sentence
            or source_sentence in (h.get("exampleEn"), h.get("exampleRu"), h.get("secondaryExampleEn"), h.get("secondaryExampleRu"))
        ),
        db_hints[0] if db_hints else None,
    )

    ref_sentence = (matching or {}).get("exampleEn" if mode != "en_to_ru" else "exampleRu") or user_text
    is_en_output = mode in ("free", "ru_to_en")

    used_target = False
    for w in target_words:
        stem = w.strip().lower()[: max(3, len(w.strip()) - 2)]
        if is_en_output:
            if w.lower() in normalized or stem in normalized:
                used_target = True
                break
        else:
            hint = next((h for h in db_hints if h["word"].lower() == w.lower()), None)
            if not hint:
                used_target = len(normalized) >= 6
                break
            tokens = [t.strip() for t in re.split(r"[,;/]+", hint["translation"].lower()) if len(t.strip()) >= 3]
            if any(t[: max(3, len(t) - 2)] in normalized for t in tokens):
                used_target = True
                break

    ends_punct = bool(re.search(r"[.!?]$", user_text.strip()))
    starts_cap = bool(re.match(r"^[A-ZА-ЯЁ]", user_text.strip()))
    word_count = len(user_text.strip().split())

    score = 60 + (20 if used_target else 0) + (10 if word_count >= 4 else 0) + (5 if ends_punct else 0) + (5 if starts_cap else 0)
    notes: list[str] = []
    if not used_target:
        notes.append(f"Проверьте использование целевого слова ({', '.join(target_words)}).")
    else:
        notes.append("Целевое слово использовано в ответе.")
    if not starts_cap or not ends_punct:
        notes.append("Начинайте предложение с заглавной буквы и ставьте знак препинания в конце.")
    if word_count < 4:
        notes.append("Старайтесь строить более полное предложение для закрепления контекста.")

    return {
        "isCorrect": score >= 75,
        "grammarScore": min(95, score),
        "naturalnessScore": min(90, score - 5),
        "usedTargetWordsCorrectly": used_target,
        "correctedSentence": ref_sentence,
        "feedbackRu": "Выполнена базовая локальная проверка по словарю. Сравните свой ответ с эталоном из словаря.",
        "grammarNotes": notes,
        "improvedVariants": (
            [{"en": matching["exampleEn"], "ru": matching["exampleRu"], "tone": "Пример из вашего словаря"}]
            if matching and matching.get("exampleEn")
            else []
        ),
        "aiGenerated": False,
    }
