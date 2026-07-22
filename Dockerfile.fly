FROM python:3.11-slim

# Install Mosquitto MQTT broker, Supervisor, and build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    mosquitto \
    supervisor \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Mosquitto config
COPY mosquitto.conf /etc/mosquitto/mosquitto.conf

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source code
COPY engine/ /app/engine/
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Create directory for SQLite historian volume
RUN mkdir -p /app/historian

# Set Environment Defaults
ENV MQTT_BROKER_HOST=localhost
ENV HISTORIAN_DB_PATH=/app/historian/nexus_historian.db

# Expose WebSockets port for dashboard
EXPOSE 9001

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
