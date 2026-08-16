import http.server
import json
import os
import numpy as np
import time

PORT = 8000

class SfiralComputeHandler(http.server.SimpleHTTPRequestHandler):
    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers()

    def do_GET(self):
        if self.path == '/' or self.path == '':
            self.path = '/index.html'
        return super().do_GET()

    def do_POST(self):
        start_time = time.time()
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        
        try:
            model_data = json.loads(post_data.decode('utf-8'))
            nodes = model_data.get('nodes', [])
            
            total_nodes = len(nodes)
            pos_count, neg_count, zero_count = 0, 0, 0
            node_signals = []

            for node in nodes:
                params = node.get('params', {})
                show_right = params.get('showRight', True)
                show_left = params.get('showLeft', True)
                
                if show_right and not show_left:
                    pos_count += 1
                    node_signals.append(1.0)
                elif show_left and not show_right:
                    neg_count += 1
                    node_signals.append(-1.0)
                else:
                    zero_count += 1
                    node_signals.append(0.0)

            if total_nodes > 0:
                signal_array = np.array(node_signals, dtype=np.float32)
                base_matrix = np.zeros((total_nodes, total_nodes))
                for i in range(total_nodes):
                    for j in range(total_nodes):
                        base_matrix[i, j] = np.cos(np.pi * i * j / max(total_nodes, 1))
                
                if total_nodes > 1:
                    H_exact, _ = np.linalg.qr(base_matrix)
                    H_exact = np.sign(H_exact)
                    H_exact[H_exact == 0] = 1
                else:
                    H_exact = np.array([[1.0]])

                encoded_spectrum = np.dot(H_exact, signal_array)
                integral_chirality = float(np.sum(encoded_spectrum))
                matrix_norm = float(np.linalg.norm(encoded_spectrum))
            else:
                integral_chirality = 0.0
                matrix_norm = 0.0

            elapsed_ms = (time.time() - start_time) * 1000

            response_data = {
                "status": "success",
                "computed_nodes": total_nodes,
                "execution_time_ms": round(elapsed_ms, 2),
                "metrics": {
                    "positive": pos_count,
                    "negative": neg_count,
                    "neutral": zero_count,
                    "integral_chirality": round(integral_chirality, 4),
                    "matrix_norm": round(matrix_norm, 4)
                }
            }

            self._set_headers(200)
            self.wfile.write(json.dumps(response_data).encode('utf-8'))
            print(f"⚡ [Тест ядра] Узлов: {total_nodes} | Время: {elapsed_ms:.2f}мс | Хиральность: {response_data['metrics']['integral_chirality']} | Норма: {matrix_norm}")

        except Exception as e:
            error_response = {"status": "error", "message": str(e)}
            self._set_headers(400)
            self.wfile.write(json.dumps(error_response).encode('utf-8'))
            print(f"❌ [Ошибка расчета]: {e}")

if __name__ == "__main__":
    server = http.server.HTTPServer(('localhost', PORT), SfiralComputeHandler)
    print(f"🚀 Вычислительное ядро Сфирали запущенно: http://localhost:{PORT}/index.html")
    print("⏳ Ожидание запросов от сайта...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Сервер остановлен.")
        server.server_close()