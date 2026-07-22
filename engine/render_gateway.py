"""
NEXUS OS - Render Gateway & Health Check Proxy
Exposes port $PORT (Render default 10000):
- Serves HTTP 200 OK for Render health check scans
- Transparently proxies WebSocket traffic to Mosquitto on localhost:9001
"""

import os
import select
import socket
import threading


LOCAL_MOSQUITTO_PORT = 9001


def forward_stream(source, destination):
    try:
        while True:
            data = source.recv(4096)
            if not data:
                break
            destination.sendall(data)
    except Exception:
        pass
    finally:
        try:
            source.close()
        except Exception:
            pass
        try:
            destination.close()
        except Exception:
            pass


def handle_client(client_sock):
    try:
        client_sock.settimeout(5.0)
        peek_data = client_sock.recv(4096, socket.MSG_PEEK)
        client_sock.settimeout(None)

        if not peek_data:
            client_sock.close()
            return

        request_str = peek_data.decode("utf-8", errors="ignore")

        # Check if this is a WebSocket upgrade request
        if "upgrade: websocket" in request_str.lower():
            # Connect to Mosquitto WebSockets listener
            mosq_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            mosq_sock.connect(("127.0.0.1", LOCAL_MOSQUITTO_PORT))

            # Start bi-directional byte relaying
            t1 = threading.Thread(target=forward_stream, args=(client_sock, mosq_sock), daemon=True)
            t2 = threading.Thread(target=forward_stream, args=(mosq_sock, client_sock), daemon=True)
            t1.start()
            t2.start()
            return

        # Standard HTTP request (Render Health Check GET)
        response = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: text/plain\r\n"
            "Content-Length: 13\r\n"
            "Connection: close\r\n"
            "\r\n"
            "NEXUS OS Live"
        )
        # Drain the actual request bytes before closing
        client_sock.recv(4096)
        client_sock.sendall(response.encode("utf-8"))
        client_sock.close()

    except Exception as e:
        try:
            client_sock.close()
        except Exception:
            pass


def main():
    port = int(os.environ.get("PORT", 10000))
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", port))
    server.listen(128)
    print(f"[Render Gateway] Listening on 0.0.0.0:{port} -> forwarding WebSockets to localhost:{LOCAL_MOSQUITTO_PORT}")

    while True:
        try:
            client_sock, _ = server.accept()
            t = threading.Thread(target=handle_client, args=(client_sock,), daemon=True)
            t.start()
        except Exception as e:
            print(f"[Render Gateway] Accept error: {e}")


if __name__ == "__main__":
    main()
