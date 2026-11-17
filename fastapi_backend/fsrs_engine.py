from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, TypedDict

from fsrs import Card, Rating, Scheduler, State

ReviewQuality = Literal[1, 2, 3, 4]  # 1: Again, 2: Hard, 3: Good, 4: Easy
WordStatus = Literal["new", "learning", "review", "mastered"]


class FsrsCardInput(TypedDict, total=False):
    dueAt: str | None
    stability: float
    difficulty: float
    state: int
    reps: int
    lapses: int
    learningSteps: int
    lastReviewedAt: str | None
    status: WordStatus
    intervalDays: float


class FsrsResult(TypedDict):
    stability: float
    difficulty: float
    state: int
    lapses: int
    learningSteps: int
    repetitions: int
    intervalDays: float
    easeFactor: float
    status: WordStatus
    nextReviewAt: str
    intervalLabelRu: str


_scheduler = Scheduler(desired_retention=0.9, enable_fuzzing=False)


def _parse_iso(raw: str | None, fallback: datetime) -> datetime:
    if not raw:
        return fallback
    try:
        cleaned = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return fallback


def _quality_to_rating(quality: ReviewQuality) -> Rating:
    if quality == 1:
        return Rating.Again
    if quality == 2:
        return Rating.Hard
    if quality == 3:
        return Rating.Good
    return Rating.Easy


def _to_card(data: FsrsCardInput, now: datetime) -> Card:
    card = Card()
    raw_state = int(data.get("state") or 0)
    reps = max(0, int(data.get("reps") or 0))
    stability = float(data.get("stability") or 0.0)
    difficulty = float(data.get("difficulty") or 0.0)
    lapses = max(0, int(data.get("lapses") or 0))
    learning_steps = max(0, int(data.get("learningSteps") or 0))
    interval_days = max(0.0, float(data.get("intervalDays") or 0.0))

    due_dt = _parse_iso(data.get("dueAt"), now)
    last_rev = _parse_iso(data.get("lastReviewedAt"), now) if data.get("lastReviewedAt") else None

    if raw_state == 0 and reps > 0:
        inferred = State.Learning if data.get("status") == "learning" else State.Review
        card.due = due_dt
        card.stability = max(1.0, interval_days or 1.0)
        card.difficulty = 5.0
        card.state = inferred
        card.step = learning_steps
        card.last_review = last_rev
        return card

    state_map = {
        1: State.Learning,
        2: State.Review,
        3: State.Relearning,
    }
    card.due = due_dt
    card.stability = max(0.0, stability) if stability > 0 else None
    card.difficulty = max(0.0, difficulty) if difficulty > 0 else None
    card.state = state_map.get(raw_state, State.Learning if reps > 0 else State.Learning)
    if raw_state == 0 and reps == 0:
        # Fresh card defaults
        return Card()
    card.step = learning_steps
    card.last_review = last_rev
    return card


def _state_to_int(state: State) -> int:
    if state == State.Learning:
        return 1
    if state == State.Review:
        return 2
    if state == State.Relearning:
        return 3
    return 0


def _map_status(card: Card, interval_days: float, reps: int) -> WordStatus:
    if card.state in (State.Learning, State.Relearning):
        return "learning"
    if card.state == State.Review and (card.stability or 0) >= 21 and interval_days >= 21 and reps >= 3:
        return "mastered"
    return "review"


def _difficulty_to_legacy_ease(difficulty: float) -> float:
    if difficulty <= 0:
        return 2.5
    mapped = 3.1 - (difficulty - 1.0) * 0.18
    return round(max(1.3, min(3.0, mapped)), 2)


def format_interval_ms_ru(diff_ms: float) -> str:
    mins = max(1, round(diff_ms / 60_000))
    if mins < 60:
        return f"{mins} мин"
    hours = round(mins / 60)
    if hours < 24:
        return f"{hours} ч"
    days = round(diff_ms / 86_400_000)
    if days < 30:
        return f"{max(1, days)} дн"
    months = round(days / 30)
    return f"{max(1, months)} мес"


def calculate_fsrs(
    current: FsrsCardInput,
    quality: ReviewQuality,
    now: datetime | None = None,
) -> FsrsResult:
    now_dt = now or datetime.now(timezone.utc)
    card = _to_card(current, now_dt)
    rating = _quality_to_rating(quality)
    next_card, _review_log = _scheduler.review_card(card, rating, now_dt)

    prev_reps = max(0, int(current.get("reps") or 0))
    prev_lapses = max(0, int(current.get("lapses") or 0))
    next_reps = prev_reps + 1
    next_lapses = prev_lapses + (1 if quality == 1 and int(current.get("state") or 0) == 2 else 0)

    diff_ms = max(60_000.0, (next_card.due - now_dt).total_seconds() * 1000.0)
    exact_days = round(diff_ms / 86_400_000.0, 4)
    interval_days = round(exact_days, 4)
    stability = round(float(next_card.stability or 0.0), 4)
    difficulty = round(float(next_card.difficulty or 5.0), 4)

    return {
        "stability": stability,
        "difficulty": difficulty,
        "state": _state_to_int(next_card.state),
        "lapses": next_lapses,
        "learningSteps": int(next_card.step or 0),
        "repetitions": next_reps,
        "intervalDays": interval_days,
        "easeFactor": _difficulty_to_legacy_ease(difficulty),
        "status": _map_status(next_card, interval_days, next_reps),
        "nextReviewAt": next_card.due.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "intervalLabelRu": format_interval_ms_ru(diff_ms),
    }


def preview_all_fsrs_intervals(
    current: FsrsCardInput,
    now: datetime | None = None,
) -> dict[str, str]:
    now_dt = now or datetime.now(timezone.utc)
    card = _to_card(current, now_dt)

    out: dict[str, str] = {}
    for q, rating in ((1, Rating.Again), (2, Rating.Hard), (3, Rating.Good), (4, Rating.Easy)):
        preview_card, _ = _scheduler.review_card(Card.from_dict(card.to_dict()), rating, now_dt)
        diff_ms = max(60_000.0, (preview_card.due - now_dt).total_seconds() * 1000.0)
        out[str(q)] = format_interval_ms_ru(diff_ms)
    return out
