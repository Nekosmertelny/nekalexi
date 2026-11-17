FROM node:22-slim AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM python:3.11-slim
WORKDIR /app

COPY fastapi_backend/requirements.txt ./fastapi_backend/requirements.txt
RUN pip install --no-cache-dir -r fastapi_backend/requirements.txt

COPY fastapi_backend ./fastapi_backend
COPY --from=frontend-builder /app/dist ./dist
RUN mkdir -p /app/data

ENV PYTHONPATH=/app/fastapi_backend
ENV DATABASE_PATH=/app/data/lexiforge.db
EXPOSE 3000

CMD ["uvicorn", "fastapi_backend.main:app", "--host", "0.0.0.0", "--port", "3000"]
