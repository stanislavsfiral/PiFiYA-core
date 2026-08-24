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
            
            # --- 3D КВАНТОВЫЙ РАСЧЕТ УРОВНЯ СФИРАЛИ ---
            H_matrix = (1.0 / np.sqrt(2)) * np.array([[1, 1], [1, -1]], dtype=complex)
            quantum_results = []
            total_intensity = 0.0

            for node in nodes:
                params = node.get('params', {})
                show_right = params.get('showRight', True)
                show_left = params.get('showLeft', True)
                angles = params.get('angles', [0, 0, 0])
                x, y, z = node.get('x', 0), node.get('y', 0), node.get('z', 0)
                
                # Поддержка кастомных квантовых вентилей и троичных состояний
                gate_type = params.get('activeGate', 'H')
                
                if show_right and not show_left:
                    pos_count += 1
                    node_signals.append(1.0)
                elif show_left and not show_right:
                    neg_count += 1
                    node_signals.append(-1.0)
                else:
                    zero_count += 1
                    node_signals.append(0.0)

                # Пространственный фазовый набег с учетом типа вентиля
                phi_spatial = np.radians(angles[1] + angles[2]) + (np.sqrt(x**2 + y**2 + z**2) / 1000.0)
                
                if gate_type == 'S_TRANSITION':
                    # Топологический S-переход: плавная инверсия фазы без разрыва потока
                    phase_tensor = np.exp(1j * (phi_spatial + np.pi / 3))
                else:
                    phase_tensor = np.exp(1j * phi_spatial)
                
                # Применение матричного преобразования в 3D пространстве
                state_vector = np.array([1.0, 0.0], dtype=complex)
                transformed_state = np.dot(H_matrix, state_vector) * phase_tensor
                
                psi_real = float(np.real(transformed_state[0]))
                psi_imag = float(np.imag(transformed_state[1]))
                intensity = float(np.abs(transformed_state[0])**2 + np.abs(transformed_state[1])**2)
                total_intensity += intensity

                quantum_results.append({
                    "id": node.get('id'),
                    "psi_real": round(psi_real, 4),
                    "psi_imag": round(psi_imag, 4),
                    "intensity": round(intensity, 4),
                    "activeGate": gate_type
                })

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

            is_closed_ring = (total_nodes == 3 or total_nodes == 6)
            elapsed_ms = (time.time() - start_time) * 1000

            response_data = {
                "status": "success",
                "computed_nodes": total_nodes,
                "execution_time_ms": round(elapsed_ms, 2),
                "topology_ring_stable": is_closed_ring,
                "total_intensity": round(total_intensity, 2),
                "nodes_quantum": quantum_results,
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
            print(f"⚡ [3D Квантовое ядро] Узлов: {total_nodes} | Время: {elapsed_ms:.2f}мс | Интенсивность: {total_intensity:.2f} | Хиральность: {response_data['metrics']['integral_chirality']}")

        except Exception as e:
            error_response = {"status": "error", "message": str(e)}
            self._set_headers(400)
            self.wfile.write(json.dumps(error_response).encode('utf-8'))
            print(f"❌ [Ошибка расчета]: {e}")

if __name__ == "__main__":
    server = http.server.HTTPServer(('localhost', PORT), SfiralComputeHandler)
    print(f"🚀 Вычислительное ядро Сфирали запущено: http://localhost:{PORT}/index.html")
    print("⏳ Ожидание запросов от сайта...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 Сервер остановлен.")
        server.server_close()