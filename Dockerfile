FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DB_PATH=/data/trains.db
WORKDIR /srv

# Säkerhetsuppdateringar för operativsystemet, även om basimagen inte hunnit byggas om.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# pip behövs bara vid bygget. Den tas bort efteråt, tillsammans med pip-hjulet i ensurepip,
# så att imagen inte innehåller pip eller paketen som pip bär med sig.
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt \
 && pip uninstall -y pip \
 && rm -rf /usr/local/lib/python3.13/ensurepip/_bundled /root/.cache

COPY app ./app
COPY VERSION .
RUN useradd --system --uid 10001 tagkoll && mkdir /data && chown tagkoll /data
USER tagkoll
VOLUME /data
EXPOSE 8843

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8843/api/health', timeout=4)"

# Ingen Server-rubrik, högst 200 samtidiga anslutningar och korta keep-alive-tider.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8843", "--no-server-header", "--no-proxy-headers", \
     "--limit-concurrency", "200", "--timeout-keep-alive", "5"]
