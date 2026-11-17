from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Literal, TypedDict
from urllib.parse import quote

import httpx

WIKIMEDIA_USER_AGENT = "nekaLexi/1.0 (https://nekalexi.local; mailto:nekajon.nekka@gmail.com)"
_CYRILLIC_RE = re.compile(r"[а-яё]", re.IGNORECASE)

_BAD_IMAGE_KEYWORDS_RE = re.compile(
    r"(\.svg|diagram|chart|graph|screenshot|logo|flag|coat[_ ]of[_ ]arms|emblem|map[_.]|poster|flyer|"
    r"sheet[_ ]music|tombstone|grave|monument[_ ]plaque|scan|document|cartoon|meme|mugshot|icon|watermark|"
    r"1[5-9]\d\d|amateur|sexy|babe|lingerie|bikini|nude|erotic|glamour|boudoir|fetish|nsfw|playboy|"
    r"penthouse|etching|engraving|lithograph|woodcut|oil[_ ]on[_ ]canvas|fresco|caricature|"
    r"plate[_ ]\d+|disasters[_ ]of[_ ]war|met[_ ]mm\d+)",
    re.IGNORECASE,
)

_BAD_WIKI_TOPIC_RE = re.compile(
    r"(\bdisambiguation\b|\bsurname\b|\bgiven name\b|\bborn \d{4}\b|\bpolitician\b|\bactor\b|\bactress\b|"
    r"\bsinger\b|\brapper\b|\bfootballer\b|\bathlete\b|\bcomposer\b|\bmonarch\b|\bpresident\b|\bfilm\b|"
    r"\bmovie\b|\btelevision\b|\balbum\b|\bsong\b|\bband\b|\bmusician\b|\bnovel\b|\bvideo game\b|\banime\b|"
    r"\bmanga\b|\bcompany\b|\bcorporation\b|\bsoftware\b|\bstartup\b|\bmunicipality\b|\bvillage\b|\bcounty\b|"
    r"\bcity in\b|\btown in\b|\bpainting\b|\betching\b|\bengraving\b|\bsculpture\b)",
    re.IGNORECASE,
)

CONTEXTUAL_VISUAL_HINTS: dict[str, str] = {
    "achieve": "trophy medal",
    "ambiguous": "foggy forest path",
    "ambition": "mountain summit",
    "anxiety": "stressed desk",
    "borrow": "library books",
    "challenge": "mountain climbing",
    "collaborate": "team meeting",
    "comfortable": "cozy armchair",
    "confidence": "public speaker stage",
    "confident": "speaker podium",
    "courage": "rock climbing",
    "creativity": "artist studio",
    "curiosity": "magnifying glass",
    "deadline": "calendar clock",
    "decide": "crossroads",
    "discipline": "morning running",
    "efficient": "high speed train",
    "eloquent": "public speaking",
    "ephemeral": "cherry blossom",
    "experience": "mountain hiking",
    "explain": "classroom teacher",
    "explore": "hiking map",
    "focus": "desk study",
    "freedom": "open sky bird",
    "goal": "target archery",
    "habit": "morning coffee notebook",
    "happy": "kid smiling",
    "improve": "study notebook",
    "knowledge": "library books",
    "look forward to": "boarding pass",
    "memory": "photo album",
    "mistake": "eraser pencil",
    "motivation": "runner sunrise",
    "negotiate": "handshake",
    "opportunity": "open door",
    "patience": "hourglass sand",
    "perseverance": "mountain climbing",
    "perspective": "city perspective",
    "pragmatic": "checklist",
    "prepare": "desk notebooks",
    "progress": "stairs climbing",
    "reliable": "watch movement",
    "resilient": "succulent rock",
    "schedule": "calendar planner",
    "scrutinize": "magnifying glass",
    "solution": "puzzle piece",
    "success": "graduation celebration",
    "suggest": "light bulb",
    "sustainable": "wind turbines",
    "travel": "suitcase travel",
    "ubiquitous": "smartphone cafe",
    "wisdom": "owl library",
}

_STOPWORDS = {
    "a", "an", "the", "to", "of", "in", "on", "at", "by", "for", "with", "from", "as", "into", "or", "and",
    "is", "are", "be", "been", "being", "have", "has", "had", "do", "does", "did", "make", "makes", "made",
    "get", "give", "take", "come", "go", "something", "someone", "anything", "anyone", "person", "people",
    "thing", "things", "way", "state", "quality", "act", "action", "process", "having", "using", "used",
    "very", "more", "most", "able", "capable", "such", "other", "one", "two", "often", "usually", "especially",
}

_word_image_cache: dict[str, str] = {}
_ru_word_cache: dict[str, str] = {}
_ru_sentence_cache: dict[str, str] = {}
_translate_sem = asyncio.Semaphore(2)


class DictionaryLookupResult(TypedDict):
    word: str
    phonetic: str
    audioUrl: str
    partOfSpeech: str
    englishDefinition: str
    englishExamples: list[str]
    source: Literal["dictionaryapi", "fallback"]


class ParsedWordEntry(TypedDict, total=False):
    word: str
    translation: str | None
    partOfSpeech: str | None
    exampleEn: str | None
    exampleRu: str | None


def normalize_word_for_lookup(raw: str) -> str:
    s = re.sub(r"\s+", " ", raw).strip()
    s = re.sub(r'^["\'«»“”‘’`.,;:!?()\[\]{}]+', "", s)
    s = re.sub(r'["\'«»“”‘’`.,;:!?()\[\]{}]+$', "", s)
    return s.strip()


def _normalize_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _normalize_pos_tag(pos: str | None) -> str:
    low = (pos or "").strip().lower()
    if not low:
        return ""
    if "noun" in low or "существит" in low:
        return "noun"
    if "phrasal" in low or "verb" in low or "глагол" in low:
        return "verb"
    if "adj" in low or "прилагат" in low:
        return "adjective"
    if "adv" in low or "нареч" in low:
        return "adverb"
    if "prep" in low or "предлог" in low:
        return "preposition"
    if "conj" in low or "союз" in low:
        return "conjunction"
    if "pron" in low or "местоимен" in low:
        return "pronoun"
    if "interj" in low or "междомет" in low:
        return "interjection"
    return low


async def lookup_english_dictionary(raw_word: str, preferred_pos: str = "") -> DictionaryLookupResult:
    clean_word = normalize_word_for_lookup(raw_word).lower()
    target_pos = _normalize_pos_tag(preferred_pos)
    if not clean_word:
        return {
            "word": clean_word,
            "phonetic": "",
            "audioUrl": "",
            "partOfSpeech": target_pos or "noun",
            "englishDefinition": "",
            "englishExamples": [],
            "source": "fallback",
        }

    try:
        async with httpx.AsyncClient(timeout=4.5) as client:
            res = await client.get(
                f"https://api.dictionaryapi.dev/api/v2/entries/en/{quote(clean_word)}"
            )
            if res.status_code != 200:
                raise RuntimeError(f"Dictionary API {res.status_code}")
            entries = res.json()

        first = entries[0] if isinstance(entries, list) and entries else None
        if not isinstance(first, dict):
            raise RuntimeError("Empty dictionary response")

        phonetics = first.get("phonetics") or []
        phonetic = first.get("phonetic") or next(
            (p.get("text", "") for p in phonetics if isinstance(p, dict) and p.get("text")), ""
        )
        raw_audio = next(
            (p.get("audio", "") for p in phonetics if isinstance(p, dict) and p.get("audio")), ""
        )
        audio_url = f"https:{raw_audio}" if raw_audio.startswith("//") else raw_audio

        meanings = first.get("meanings") or []
        ordered_meanings = (
            [m for m in meanings if _normalize_pos_tag(m.get("partOfSpeech")) == target_pos]
            + [m for m in meanings if _normalize_pos_tag(m.get("partOfSpeech")) != target_pos]
            if target_pos
            else meanings
        )
        first_meaning = ordered_meanings[0] if ordered_meanings else {}
        part_of_speech = first_meaning.get("partOfSpeech") or target_pos or "noun"
        first_defs = first_meaning.get("definitions") or []
        english_definition = (
            first_defs[0].get("definition", "") if first_defs and isinstance(first_defs[0], dict) else ""
        )
        english_examples: list[str] = []
        for meaning in ordered_meanings:
            for d in meaning.get("definitions") or []:
                ex = d.get("example") if isinstance(d, dict) else None
                if ex:
                    english_examples.append(ex)
                    if len(english_examples) >= 2:
                        break
            if len(english_examples) >= 2:
                break

        return {
            "word": first.get("word") or clean_word,
            "phonetic": phonetic,
            "audioUrl": audio_url,
            "partOfSpeech": part_of_speech,
            "englishDefinition": english_definition,
            "englishExamples": english_examples,
            "source": "dictionaryapi",
        }
    except Exception:
        return {
            "word": clean_word,
            "phonetic": "",
            "audioUrl": "",
            "partOfSpeech": target_pos or "noun",
            "englishDefinition": "",
            "englishExamples": [],
            "source": "fallback",
        }


async def _fetch_json_safe(url: str, timeout_s: float = 3.0) -> Any | None:
    async with _translate_sem:
        for attempt in range(2):
            try:
                async with httpx.AsyncClient(timeout=timeout_s) as client:
                    res = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
                    if res.status_code == 200:
                        trimmed = res.text.strip()
                        if not trimmed or trimmed.startswith("<"):
                            return None
                        return json.loads(trimmed)
            except Exception:
                pass
            if attempt == 0:
                await asyncio.sleep(0.15)
    return None


def _extract_meanings_from_clients5(
    data: dict[str, Any], clean_word: str, target_pos: str
) -> list[str]:
    source_lower = clean_word.lower()
    is_short = len(clean_word.split()) <= 3
    meanings: list[str] = []
    seen: set[str] = set()

    def add_meaning(candidate: str) -> None:
        normalized = _normalize_spaces(candidate).rstrip(".,;:").lower()
        if not normalized or not _CYRILLIC_RE.search(normalized):
            return
        if normalized == source_lower or normalized in seen:
            return
        if is_short and len(normalized.split()) > 4:
            return
        seen.add(normalized)
        meanings.append(normalized)

    sentences = data.get("sentences")
    primary_raw = ""
    if isinstance(sentences, list):
        primary_raw = "".join(
            s.get("trans", "") for s in sentences if isinstance(s, dict) and isinstance(s.get("trans"), str)
        ).strip()

    dict_groups = data.get("dict")
    if is_short and isinstance(dict_groups, list) and dict_groups:
        matching = (
            [g for g in dict_groups if isinstance(g, dict) and _normalize_pos_tag(g.get("pos")) == target_pos]
            if target_pos
            else []
        )
        groups_to_use = matching or [g for g in dict_groups if isinstance(g, dict)]
        candidates: list[tuple[str, float]] = []
        group_terms_lower: set[str] = set()
        for g in groups_to_use:
            if isinstance(g.get("terms"), list):
                for t in g["terms"]:
                    if isinstance(t, str):
                        group_terms_lower.add(_normalize_spaces(t).lower())
            entries = g.get("entry")
            if isinstance(entries, list) and entries:
                for e in entries:
                    if isinstance(e, dict) and isinstance(e.get("word"), str) and _CYRILLIC_RE.search(e["word"]):
                        group_terms_lower.add(_normalize_spaces(e["word"]).lower())
                        score = float(e["score"]) if isinstance(e.get("score"), (int, float)) else 0.0
                        candidates.append((e["word"], score))
            elif isinstance(g.get("terms"), list):
                for t in g["terms"][:3]:
                    if isinstance(t, str) and _CYRILLIC_RE.search(t):
                        candidates.append((t, 0.1))

        primary_norm = _normalize_spaces(primary_raw).rstrip(".,;:").lower() if primary_raw else ""
        primary_matches_pos = bool(primary_norm) and (
            not matching or len(dict_groups) == 1 or primary_norm in group_terms_lower
        )
        if primary_matches_pos and primary_norm:
            add_meaning(primary_norm)

        if candidates:
            candidates.sort(key=lambda x: x[1], reverse=True)
            top_score = candidates[0][1]
            min_threshold = top_score * 0.25 if top_score >= 0.02 else top_score * 0.15
            for w, sc in candidates:
                if not meanings or sc >= min_threshold:
                    add_meaning(w)
                if len(meanings) >= 3:
                    break

        if not meanings and primary_raw:
            add_meaning(primary_raw)
    elif primary_raw:
        add_meaning(primary_raw)

    return meanings[:3]


def _extract_meanings_from_gtx_array(
    data: list[Any], clean_word: str, target_pos: str
) -> list[str]:
    source_lower = clean_word.lower()
    is_short = len(clean_word.split()) <= 3
    meanings: list[str] = []
    seen: set[str] = set()

    def add_meaning(candidate: str) -> None:
        normalized = _normalize_spaces(candidate).rstrip(".,;:").lower()
        if not normalized or not _CYRILLIC_RE.search(normalized):
            return
        if normalized == source_lower or normalized in seen:
            return
        seen.add(normalized)
        meanings.append(normalized)

    chunks = data[0] if len(data) > 0 and isinstance(data[0], list) else []
    primary_raw = "".join(
        c[0] for c in chunks if isinstance(c, list) and len(c) > 0 and isinstance(c[0], str)
    ).strip()

    if is_short and len(data) > 1 and isinstance(data[1], list):
        matching = (
            [
                g for g in data[1]
                if isinstance(g, list) and len(g) > 0 and _normalize_pos_tag(str(g[0] or "")) == target_pos
            ]
            if target_pos
            else []
        )
        groups_to_use = matching or [g for g in data[1] if isinstance(g, list)]
        candidates: list[tuple[str, float]] = []
        for g in groups_to_use:
            if len(g) > 2 and isinstance(g[2], list):
                for e in g[2]:
                    if isinstance(e, list) and len(e) > 0 and isinstance(e[0], str) and _CYRILLIC_RE.search(e[0]):
                        sc = float(e[3]) if len(e) > 3 and isinstance(e[3], (int, float)) else 0.0
                        candidates.append((e[0], sc))
            elif len(g) > 1 and isinstance(g[1], list):
                for t in g[1][:3]:
                    if isinstance(t, str) and _CYRILLIC_RE.search(t):
                        candidates.append((t, 0.1))

        if candidates:
            candidates.sort(key=lambda x: x[1], reverse=True)
            top_score = candidates[0][1]
            min_threshold = max(0.04, top_score * 0.25) if top_score > 0 else 0.0
            for w, sc in candidates:
                if not meanings or sc >= min_threshold:
                    add_meaning(w)
                if len(meanings) >= 3:
                    break

    if primary_raw and (not meanings or not target_pos):
        prev = list(meanings)
        meanings.clear()
        seen.clear()
        add_meaning(primary_raw)
        for m in prev:
            if len(meanings) >= 3:
                break
            add_meaning(m)

    return meanings[:3]


async def _translate_via_ru_wiktionary(clean_word: str) -> str:
    if " " in clean_word:
        return ""
    try:
        url = (
            f"https://ru.wiktionary.org/w/api.php?action=query&titles={quote(clean_word.lower())}"
            "&prop=extracts&explaintext=1&format=json"
        )
        async with httpx.AsyncClient(timeout=2.2) as client:
            res = await client.get(url, headers={"User-Agent": WIKIMEDIA_USER_AGENT})
            if res.status_code != 200:
                return ""
            data = res.json()
        pages = ((data.get("query") or {}).get("pages") or {}).values()
        page = next(iter(pages), {})
        extract = str(page.get("extract") or "")
        m = re.search(r"====\s*Значение\s*====\s*([\s\S]*?)(?:\n===|$)", extract, re.IGNORECASE)
        if not m:
            return ""
        glosses: list[str] = []
        for raw_line in m.group(1).splitlines():
            line = re.sub(r"◆.*$", "", re.sub(r"\[[^\]]*\]", "", raw_line)).strip()
            if not line or not _CYRILLIC_RE.search(line):
                continue
            first_part = re.split(r"[;,.]", line)[0].strip().lower()
            if first_part and _CYRILLIC_RE.search(first_part) and len(first_part.split()) <= 3:
                if first_part not in glosses:
                    glosses.append(first_part)
            if len(glosses) >= 2:
                break
        return ", ".join(glosses)
    except Exception:
        return ""


async def translate_english_to_russian(raw_word: str, part_of_speech: str = "") -> str:
    clean_word = normalize_word_for_lookup(raw_word)
    if not clean_word:
        return ""
    if _CYRILLIC_RE.search(clean_word):
        return clean_word

    norm_pos = _normalize_pos_tag(part_of_speech)
    cache_key = f"{clean_word.lower()}::{norm_pos}"
    if cache_key in _ru_word_cache:
        return _ru_word_cache[cache_key]

    meanings: list[str] = []

    c5_url = (
        "https://clients5.google.com/translate_a/single"
        f"?dj=1&dt=t&dt=bd&client=dict-chrome-ex&sl=en&tl=ru&q={quote(clean_word)}"
    )
    c5_data = await _fetch_json_safe(c5_url)
    if isinstance(c5_data, dict):
        meanings = _extract_meanings_from_clients5(c5_data, clean_word, norm_pos)
    elif isinstance(c5_data, list):
        meanings = _extract_meanings_from_gtx_array(c5_data, clean_word, norm_pos)

    if not meanings:
        t_url = f"https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=ru&q={quote(clean_word)}"
        t_data = await _fetch_json_safe(t_url)
        if isinstance(t_data, list) and t_data:
            flat = t_data[0] if isinstance(t_data[0], str) else (t_data[0][0] if isinstance(t_data[0], list) and t_data[0] and isinstance(t_data[0][0], str) else "")
            cand = _normalize_spaces(flat).rstrip(".,;:").lower()
            if cand and _CYRILLIC_RE.search(cand) and cand != clean_word.lower():
                meanings = [cand]

    if not meanings:
        gtx_url = (
            "https://translate.googleapis.com/translate_a/single"
            f"?client=gtx&sl=en&tl=ru&dt=t&dt=bd&q={quote(clean_word)}"
        )
        gtx_data = await _fetch_json_safe(gtx_url)
        if isinstance(gtx_data, list):
            meanings = _extract_meanings_from_gtx_array(gtx_data, clean_word, norm_pos)

    result = ", ".join(meanings[:3]) or await _translate_via_ru_wiktionary(clean_word)
    if result:
        if len(_ru_word_cache) > 600:
            _ru_word_cache.clear()
        _ru_word_cache[cache_key] = result
    return result


def _extract_sentence_translation_from_json(data: Any) -> str:
    if isinstance(data, dict) and isinstance(data.get("sentences"), list):
        return "".join(
            s.get("trans", "") for s in data["sentences"] if isinstance(s, dict) and isinstance(s.get("trans"), str)
        )
    if isinstance(data, list) and data:
        if isinstance(data[0], str):
            return data[0]
        if isinstance(data[0], list):
            return "".join(
                c[0] if isinstance(c, list) and c and isinstance(c[0], str) else (c if isinstance(c, str) else "")
                for c in data[0]
            )
    return ""


async def translate_sentence_en_to_ru(sentence: str) -> str:
    clean = _normalize_spaces(sentence)
    if not clean:
        return ""
    if _CYRILLIC_RE.search(clean):
        return clean

    cache_key = clean.lower()
    if cache_key in _ru_sentence_cache:
        return _ru_sentence_cache[cache_key]

    endpoints = [
        f"https://clients5.google.com/translate_a/single?dj=1&dt=t&client=dict-chrome-ex&sl=en&tl=ru&q={quote(clean)}",
        f"https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=ru&q={quote(clean)}",
        f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q={quote(clean)}",
    ]
    for url in endpoints:
        data = await _fetch_json_safe(url)
        translated = _normalize_spaces(_extract_sentence_translation_from_json(data))
        if translated and _CYRILLIC_RE.search(translated):
            if len(_ru_sentence_cache) > 600:
                _ru_sentence_cache.clear()
            _ru_sentence_cache[cache_key] = translated
            return translated
    return ""


async def translate_sentences_batch_en_to_ru(sentences: list[str]) -> list[str]:
    cleaned = [re.sub(r"\s+", " ", s.replace("\r\n", " ").replace("\n", " ")).strip() for s in sentences]
    results = [""] * len(cleaned)
    missing_indexes: list[int] = []

    for i, s in enumerate(cleaned):
        if not s:
            continue
        if _CYRILLIC_RE.search(s):
            results[i] = s
        elif s.lower() in _ru_sentence_cache:
            results[i] = _ru_sentence_cache[s.lower()]
        else:
            missing_indexes.append(i)

    if not missing_indexes:
        return results

    batch_text = "\n".join(cleaned[idx] for idx in missing_indexes)
    endpoints = [
        f"https://clients5.google.com/translate_a/single?dj=1&dt=t&client=dict-chrome-ex&sl=en&tl=ru&q={quote(batch_text)}",
        f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q={quote(batch_text)}",
    ]
    for url in endpoints:
        data = await _fetch_json_safe(url)
        joined = _extract_sentence_translation_from_json(data)
        if not joined:
            continue
        lines = joined.splitlines()
        if len(lines) == len(missing_indexes):
            for idx, line in zip(missing_indexes, lines):
                translated = _normalize_spaces(line)
                if translated and _CYRILLIC_RE.search(translated):
                    if len(_ru_sentence_cache) > 600:
                        _ru_sentence_cache.clear()
                    _ru_sentence_cache[cleaned[idx].lower()] = translated
                    results[idx] = translated
            return results

    for idx in missing_indexes:
        if not results[idx]:
            results[idx] = await translate_sentence_en_to_ru(cleaned[idx])
    return results


async def lookup_tatoeba_examples(raw_word: str) -> list[dict[str, str]]:
    clean_word = normalize_word_for_lookup(raw_word)
    if not clean_word:
        return []
    try:
        url = f"https://tatoeba.org/en/api_v0/search?from=eng&to=rus&query={quote(clean_word)}&limit=4"
        async with httpx.AsyncClient(timeout=1.4) as client:
            res = await client.get(url, headers={"User-Agent": WIKIMEDIA_USER_AGENT})
            if res.status_code != 200:
                return []
            data = res.json()
        stem = clean_word.lower()[: max(3, len(clean_word) - 1)]
        pairs: list[dict[str, str]] = []
        seen_en: set[str] = set()
        for item in data.get("results") or []:
            en = _normalize_spaces(str(item.get("text") or ""))
            if not en or len(en) > 120 or stem not in en.lower():
                continue
            flat: list[dict[str, Any]] = []
            for g in item.get("translations") or []:
                if isinstance(g, list):
                    flat.extend(x for x in g if isinstance(x, dict))
                elif isinstance(g, dict):
                    flat.append(g)
            ru_obj = next(
                (
                    t for t in flat
                    if (t.get("lang") == "rus" or not t.get("lang"))
                    and isinstance(t.get("text"), str)
                    and _CYRILLIC_RE.search(t["text"])
                    and len(t["text"]) <= 140
                ),
                None,
            )
            if not ru_obj:
                continue
            ru = _normalize_spaces(ru_obj["text"])
            if en.lower() not in seen_en:
                seen_en.add(en.lower())
                pairs.append({"en": en, "ru": ru})
                if len(pairs) >= 2:
                    break
        return pairs
    except Exception:
        return []


def _extract_definition_visual_keywords(definition: str | None) -> str:
    if not definition:
        return ""
    tokens = re.sub(r"[^a-z\s]", " ", definition.lower()).split()
    unique: list[str] = []
    for tok in tokens:
        if len(tok) >= 4 and tok not in _STOPWORDS and tok not in unique:
            unique.append(tok)
            if len(unique) >= 2:
                break
    return " ".join(unique)


def _is_acceptable_real_photo_url(url: str) -> bool:
    if not url or not url.startswith("https://"):
        return False
    if _BAD_IMAGE_KEYWORDS_RE.search(url):
        return False
    low = url.lower()
    if any(ext in low for ext in (".pdf", ".ogg", ".webm")):
        return False
    return any(
        host in low
        for host in ("upload.wikimedia.org", "thumb.wikimedia.org", "api.openverse.org")
    )


async def _verify_image_url_loads(url: str) -> bool:
    if not url.startswith("https://"):
        return False
    try:
        async with httpx.AsyncClient(timeout=1.1) as client:
            res = await client.head(url, headers={"User-Agent": WIKIMEDIA_USER_AGENT})
            if res.status_code != 200:
                return False
            ct = res.headers.get("content-type", "")
            return ct.startswith("image/") and "svg" not in ct
    except Exception:
        return False


async def _fetch_wikipedia_exact_photo(query: str, exclude_set: set[str]) -> str:
    try:
        async with httpx.AsyncClient(timeout=1.6) as client:
            res = await client.get(
                f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote(query)}",
                headers={"User-Agent": WIKIMEDIA_USER_AGENT},
            )
            if res.status_code != 200:
                return ""
            data = res.json()
        if data.get("type") != "standard":
            return ""
        topic_text = f"{data.get('description', '')} {data.get('extract', '')}"
        if _BAD_WIKI_TOPIC_RE.search(topic_text):
            return ""
        thumb = data.get("thumbnail") or {}
        src = str(thumb.get("source") or "").split("?")[0]
        if not src or src in exclude_set or not _is_acceptable_real_photo_url(src):
            return ""
        if (thumb.get("width") or 0) < 240:
            return ""
        return src
    except Exception:
        return ""


async def _fetch_openverse_photo(
    match_terms: list[str],
    query: str,
    exclude_set: set[str],
) -> str:
    try:
        url = (
            f"https://api.openverse.org/v1/images/?q={quote(query)}"
            "&category=photograph&page_size=15&mature=false"
        )
        async with httpx.AsyncClient(timeout=2.2) as client:
            res = await client.get(url, headers={"User-Agent": WIKIMEDIA_USER_AGENT})
            if res.status_code != 200:
                return ""
            data = res.json()
        results = data.get("results") or []

        norm_terms = list(dict.fromkeys(t.strip().lower() for t in match_terms if len(t.strip()) >= 3))
        query_words = list(dict.fromkeys(t for t in query.strip().lower().split() if len(t) >= 3))
        term_res = [re.compile(rf"\b{re.escape(t)}", re.IGNORECASE) for t in norm_terms]
        q_res = [re.compile(rf"\b{re.escape(t)}", re.IGNORECASE) for t in query_words]

        scored: list[tuple[int, str]] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            thumb = item.get("thumbnail") or ""
            raw = item.get("url") or ""
            cand_url = thumb if str(thumb).startswith("https://") else (raw if str(raw).startswith("https://") else "")
            if not cand_url or cand_url in exclude_set or _BAD_IMAGE_KEYWORDS_RE.search(cand_url):
                continue

            title = str(item.get("title") or "").strip()
            tags_text = " ".join(str(t.get("name") or "") for t in (item.get("tags") or []) if isinstance(t, dict))
            if _BAD_IMAGE_KEYWORDS_RE.search(f"{title} {tags_text}"):
                continue
            if len(title) > 90 or "//" in title or ":-)" in title or "!" in title:
                continue
            if (item.get("width") or 640) < 320 or (item.get("height") or 480) < 220:
                continue

            title_matches = sum(1 for r in term_res if r.search(title))
            tag_matches = sum(1 for r in term_res if r.search(tags_text))
            q_combined = sum(1 for r in q_res if r.search(title) or r.search(tags_text))

            if title_matches == 0 and tag_matches == 0:
                continue
            if len(query_words) >= 2 and q_combined < 2 and title_matches < 2:
                continue
            if len(query_words) == 1 and title_matches == 0:
                continue
            if re.match(r"^(img|dsc|pxl|photo|image)[_-]?\d+", title, re.IGNORECASE) and tag_matches < 2:
                continue
            if re.match(r"^[A-Z][a-z]+ [A-Z][a-z]+$", title) and title_matches == 0:
                continue

            score = title_matches * 6 + q_combined * 4 + tag_matches * 2
            if any(title.lower() == t for t in norm_terms):
                score += 6
            if query.strip().lower() in title.lower():
                score += 8
            if (item.get("width") or 0) > (item.get("height") or 0):
                score += 2
            if item.get("thumbnail"):
                score += 1
            scored.append((score, cand_url))

        scored.sort(key=lambda x: x[0], reverse=True)
        top = [u for _, u in scored[:3]]
        if not top:
            return ""
        checks = await asyncio.gather(*(_verify_image_url_loads(u) for u in top))
        for ok, u in zip(checks, top):
            if ok:
                return u
        return ""
    except Exception:
        return ""


async def _fetch_wikimedia_commons_fallback(query: str, exclude_set: set[str]) -> str:
    try:
        url = (
            "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6"
            f"&gsrsearch={quote(f'filetype:bitmap {query}')}&gsrlimit=5"
            "&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=640&format=json"
        )
        async with httpx.AsyncClient(timeout=1.8) as client:
            res = await client.get(url, headers={"User-Agent": WIKIMEDIA_USER_AGENT})
            if res.status_code != 200:
                return ""
            data = res.json()
        pages = sorted(
            ((data.get("query") or {}).get("pages") or {}).values(),
            key=lambda p: p.get("index", 99),
        )
        for p in pages:
            info = (p.get("imageinfo") or [{}])[0]
            src = info.get("thumburl") or info.get("url") or ""
            mime = info.get("mime") or ""
            if (
                src
                and src not in exclude_set
                and not _BAD_IMAGE_KEYWORDS_RE.search(p.get("title") or "")
                and _is_acceptable_real_photo_url(src)
                and mime in ("image/jpeg", "image/png", "image/webp")
                and (info.get("width") or 0) >= 320
            ):
                return src
    except Exception:
        pass
    return ""


async def lookup_word_image(
    raw_word: str,
    *,
    part_of_speech: str = "",
    english_definition: str = "",
    hint_query: str = "",
    exclude_urls: list[str] | None = None,
) -> str:
    clean_word = raw_word.strip().lower()
    if not clean_word:
        return ""

    pos = part_of_speech.strip().lower()
    hint = hint_query.strip().lower()
    def_keywords = _extract_definition_visual_keywords(english_definition)
    semantic_scene = CONTEXTUAL_VISUAL_HINTS.get(clean_word, "")
    exclude_set = {u for u in (exclude_urls or []) if u}

    cache_key = f"{clean_word}::{pos}::{hint}::{def_keywords}"
    if not exclude_set and cache_key in _word_image_cache:
        return _word_image_cache[cache_key]

    primary_query = hint or semantic_scene or clean_word
    primary_terms = primary_query.split()
    can_use_wiki = (not pos or pos == "noun") and not semantic_scene and not hint

    match_terms = primary_terms if (semantic_scene or hint) else [*primary_terms, *clean_word.split()]
    wiki_coro = _fetch_wikipedia_exact_photo(clean_word, exclude_set) if can_use_wiki else asyncio.sleep(0, result="")
    ov_coro = _fetch_openverse_photo(match_terms, primary_query, exclude_set)
    wiki_photo, ov_photo = await asyncio.gather(wiki_coro, ov_coro)

    chosen = (wiki_photo or ov_photo) if can_use_wiki else ov_photo
    if not chosen and def_keywords and def_keywords != primary_query:
        chosen = await _fetch_openverse_photo(def_keywords.split(), def_keywords, exclude_set)
    if not chosen:
        chosen = await _fetch_wikimedia_commons_fallback(primary_query, exclude_set)

    if not exclude_set and chosen:
        if len(_word_image_cache) > 400:
            _word_image_cache.clear()
        _word_image_cache[cache_key] = chosen
    return chosen


def _split_csv_line(line: str, sep: str) -> list[str]:
    result: list[str] = []
    current = ""
    in_quotes = False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == '"':
            if in_quotes and i + 1 < len(line) and line[i + 1] == '"':
                current += '"'
                i += 1
            else:
                in_quotes = not in_quotes
        elif ch == sep and not in_quotes:
            result.append(current)
            current = ""
        else:
            current += ch
        i += 1
    result.append(current)
    return [re.sub(r'^"|"$', "", s).strip() for s in result]


def parse_word_list_input(raw_content: str, format_hint: str | None = None) -> list[ParsedWordEntry]:
    trimmed = raw_content.strip()
    if not trimmed:
        return []

    if format_hint == "json" or trimmed.startswith("["):
        try:
            parsed = json.loads(trimmed)
            if isinstance(parsed, list):
                out: list[ParsedWordEntry] = []
                for item in parsed:
                    if isinstance(item, str) and item.strip():
                        out.append({"word": item.strip()})
                    elif isinstance(item, dict) and isinstance(item.get("word"), str) and item["word"].strip():
                        out.append(
                            {
                                "word": item["word"].strip(),
                                "translation": item["translation"].strip() if isinstance(item.get("translation"), str) else None,
                                "partOfSpeech": item["partOfSpeech"].strip() if isinstance(item.get("partOfSpeech"), str) else None,
                                "exampleEn": item["exampleEn"].strip() if isinstance(item.get("exampleEn"), str) else None,
                                "exampleRu": item["exampleRu"].strip() if isinstance(item.get("exampleRu"), str) else None,
                            }
                        )
                return out
        except Exception:
            pass

    lines = [l.strip() for l in trimmed.splitlines() if l.strip() and not l.strip().startswith("#")]
    results: list[ParsedWordEntry] = []
    seen: set[str] = set()

    for idx, line in enumerate(lines):
        if idx == 0 and re.match(r"^word\s*[,;\t]", line, re.IGNORECASE):
            continue
        word = ""
        translation = None
        pos = None
        ex_en = None
        ex_ru = None
        if "," in line or ";" in line or "\t" in line:
            sep = "\t" if "\t" in line else (";" if ";" in line else ",")
            cols = _split_csv_line(line, sep)
            word = cols[0].strip() if len(cols) > 0 else ""
            translation = cols[1].strip() or None if len(cols) > 1 else None
            pos = cols[2].strip() or None if len(cols) > 2 else None
            ex_en = cols[3].strip() or None if len(cols) > 3 else None
            ex_ru = cols[4].strip() or None if len(cols) > 4 else None
        elif re.search(r"\s[-–—]\s", line):
            parts = re.split(r"\s[-–—]\s", line)
            word = parts[0].strip()
            translation = " - ".join(parts[1:]).strip() or None
        else:
            word = line

        key = word.lower()
        if word and key not in seen:
            seen.add(key)
            results.append(
                {
                    "word": word,
                    "translation": translation,
                    "partOfSpeech": pos,
                    "exampleEn": ex_en,
                    "exampleRu": ex_ru,
                }
            )
    return results
