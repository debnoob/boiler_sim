sudo tee /etc/mosquitto/conf.d/websockets.conf > /dev/null << 'EOF'
# WebSocket listener for browser dashboards
listener 9001
protocol websockets
allow_anonymous true
EOF