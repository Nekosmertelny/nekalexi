# nekaLexi — Python FastAPI Backend

Полный порт серверной части **nekaLexi** на Python + FastAPI, полностью совместимый со схемой SQLite (`data/lexiforge.db`) и React-фронтендом (`dist/`).

## Локальный запуск (Python 3.11+)

```bash
# 1. Собрать фронтенд из корня проекта
npm run build

# 2. Установить Python-зависимости
cd fastapi_backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. Запустить FastAPI (совместимо с существующей базой ../data/lexiforge.db)
uvicorn main:app --host 0.0.0.0 --port 3000 --reload
```

## Запуск в Docker

```bash
cd fastapi_backend
docker compose up --build -d
```

## Бэкапы

В папке `/backups` сохранены:
- `lexiforge.db.bak` — консистентная резервная копия SQLite базы данных.
- `nekalexi-source-backup.tar.gz` — архив исходного кода проекта.
