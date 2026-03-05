FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run එකට අවශ්‍ය Port එක සෙට් කිරීම
ENV PORT 8080
EXPOSE 8080

CMD exec uvicorn main:app --host 0.0.0.0 --port $PORT