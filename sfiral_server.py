import http.server
import json
import os
import numpy as np
import time
from datetime import datetime

PORT = 8000
AI_MEMORY_DIR = "ai_memory"
os.makedirs(AI_MEMORY_DIR, exist_ok=True)
TIMELINE_LOG_FILE = os.path.join(AI_MEMORY_DIR, "ai_timeline_log.jsonl")

# ==========================================
# ЯДРО ТРОИЧНОЙ ЛОГИКИ И КВАНТОВЫХ ВЕСОВ
# ==========================================
class SfiralQutrit:
    def __init__(self, state_minus=0.0, state_zero=0.0, state_plus=1.0):
        self.state = np.array([state_minus, state_zero, state_plus], dtype=np.complex128)
        self.normalize()

    def normalize(self):
        norm = np.linalg.norm(self.state)
        if norm > 0:
            self.state = self.state / norm

    def apply_gate(self, gate_matrix):
        self.state = np.dot(gate_matrix, self.state)
        self.normalize()

    def add(self, other_qutrit):
        self.state = self.state + other_qutrit.state
        self.normalize()

    def get_probabilities(self):
        probs = np.abs(self.state)**2
        return {"L": round(float(probs[0]), 4), "S": round(float(probs[1]), 4), "R": round(float(probs[2]), 4)}

    def copy(self):
        new_q = SfiralQutrit(0, 0, 0)
        new_q.state = np.copy(self.state)
        return new_q

class SfiralTopologyGates:
    @staticmethod
    def s_junction(): 
        return np.array([[0, 0, 1], [0, 1, 0], [1, 0, 0]], dtype=np.complex128)
    
    @staticmethod
    def hadamard():
        w = np.exp(2j * np.pi / 3)
        return (1 / np.sqrt(3)) * np.array([[1, 1, 1], [1, w, w**2], [1, w**2, w]], dtype=np.complex128)

# ==========================================
# МОСТ: ГЕОМЕТРИЧЕСКИЙ ГРАФ -> СЕМАНТИЧЕСКИЕ ТРИНГЛЫ
# ==========================================
class ModelMappedBingle:
    def __init__(self, node_id, thesis, antithesis):
        self.node_id = node_id
        self.stored_thesis = thesis
        self.stored_antithesis = antithesis
        self.is_crystalized = False

    def crystallize(self, thesis, antithesis):
        self.stored_thesis = thesis
        self.stored_antithesis = antithesis
        self.is_crystalized = True

    def to_dict(self):
        return {
            "node_id": self.node_id,
            "thesis": round(self.stored_thesis, 4),
            "antithesis": round(self.stored_antithesis, 4),
            "is_crystalized": self.is_crystalized
        }

class ModelMappedTringleNode:
    """
    Трингл, выросший прямо из загруженной модели (узла графа и его связей).
    """
    def __init__(self, node_id, node_data, incoming_signal=None, depth=0, max_depth=2, threshold=0.15):
        self.node_id = node_id
        self.node_data = node_data
        self.depth = depth
        self.max_depth = max_depth
        self.threshold = threshold
        
        # Извлекаем параметры из реального узла модели (углы, гейты)
        params = node_data.get('params', {})
        angles = params.get('angles', [0, 0, 0])
        
        # Тезис и антитезис формируются на основе пространственного поворота узла (Axis Y и Z)
        self.thesis = np.cos(np.radians(angles[1])) + (1.0 if incoming_signal is None else incoming_signal)
        self.antithesis = np.sin(np.radians(angles[2])) - 0.5
        
        self.memory = ModelMappedBingle(node_id, self.thesis, self.antithesis)
        self.children = []
        self.is_resonant = False

    def evaluate_node(self, edges, all_nodes_map):
        # S-инвертор: вычисление напряжения на основе геометрии модели
        tension = abs(self.thesis + self.antithesis)
        meaning = (self.thesis - self.antithesis) / 2.0

        if tension <= self.threshold:
            self.memory.crystallize(self.thesis, self.antithesis)
            self.is_resonant = True
            return self

        # Если напряжение высокое, запускаем фрактальное «умно-жение» по связям графа (edges)
        if self.depth < self.max_depth:
            outgoing_edges = [e for e in edges if e['from'] == self.node_id]
            
            for edge in outgoing_edges:
                next_id = edge['to']
                if next_id in all_nodes_map:
                    child_data = all_nodes_map[next_id]
                    # Создаем дочерний трингл на основе связанного узла модели
                    child_node = ModelMappedTringleNode(
                        node_id=next_id,
                        node_data=child_data,
                        incoming_signal=meaning,
                        depth=self.depth + 1,
                        max_depth=self.max_depth,
                        threshold=self.threshold
                    )
                    child_node.evaluate_node(edges, all_nodes_map)
                    self.children.append(child_node)
                    
        return self

    def to_dict(self):
        return {
            "node_id": self.node_id,
            "label": self.node_data.get('label', self.node_id),
            "depth": self.depth,
            "memory": self.memory.to_dict(),
            "children": [child.to_dict() for child in self.children]
        }

# ==========================================
# СЕРВЕР (REST API)
# ==========================================
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
            req_data = json.loads(post_data.decode('utf-8'))
            nodes = {n['id']: n for n in req_data.get('nodes', [])}
            edges = req_data.get('edges', [])
            
            # Логируем сессию в AI Memory
            session_record = {
                "timestamp": time.time(),
                "model_name": req_data.get("model_name", "GIDEON-Model-Semantic"),
                "total_nodes": len(nodes),
                "nodes": list(nodes.values()),
                "edges": edges
            }
            with open(TIMELINE_LOG_FILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(session_record, ensure_ascii=False) + "\n")

            # ====================================================
            # СЕМАНТИЧЕСКИЙ АНАЛИЗ ЗАГРУЖЕННОЙ 3D-МОДЕЛИ
            # ====================================================
            semantic_trees = []
            to_nodes = {e['to'] for e in edges}
            start_nodes = [nid for nid in nodes.keys() if nid not in to_nodes]
            if not start_nodes and nodes: 
                start_nodes = [list(nodes.keys())[0]]

            # Превращаем стартовые узлы модели в корневые Тринглы смыслов
            for start_id in start_nodes:
                root_node = ModelMappedTringleNode(
                    node_id=start_id,
                    node_data=nodes[start_id],
                    max_depth=2,
                    threshold=0.2
                )
                root_node.evaluate_node(edges, nodes)
                semantic_trees.append(root_node.to_dict())

            # Также считаем стандартный квантовый роутинг для отрисовки сигналов
            quantum_results_map = {}
            active_signals = {sid: SfiralQutrit(0, 0, 1) for sid in start_nodes}
            
            for tick in range(len(nodes) + 5):
                if not active_signals: break
                next_signals = {}
                for curr_id, qutrit in active_signals.items():
                    if curr_id not in nodes: continue
                    node = nodes[curr_id]
                    gate_type = node.get('params', {}).get('activeGate', 'ROUTER_SWAP')
                    
                    if gate_type == 'ROUTER_SWAP': qutrit.apply_gate(SfiralTopologyGates.hadamard())
                    elif gate_type == 'SCALE_CORRECTOR': qutrit.apply_gate(SfiralTopologyGates.s_junction())
                        
                    quantum_results_map[curr_id] = {
                        "id": curr_id,
                        "qutrit_state": qutrit.get_probabilities(),
                        "activeGate": gate_type
                    }
                    
                    for edge in [e for e in edges if e['from'] == curr_id]:
                        next_id = edge['to']
                        prop = qutrit.copy()
                        if next_id in next_signals: next_signals[next_id].add(prop)
                        else: next_signals[next_id] = prop
                active_signals = next_signals

            elapsed_ms = (time.time() - start_time) * 1000

            response_data = {
                "status": "success",
                "mode": "model_semantic_mapping",
                "computed_nodes": len(nodes),
                "execution_time_ms": round(elapsed_ms, 2),
                "semantic_trees": semantic_trees,
                "nodes_quantum": list(quantum_results_map.values())
            }

            self._set_headers(200)
            self.wfile.write(json.dumps(response_data, ensure_ascii=False).encode('utf-8'))
            print(f"💎 [Model Semantic] Модель проанализирована! Узлов: {len(nodes)} | Деревьев смыслов: {len(semantic_trees)} | Время: {elapsed_ms:.2f}мс")

        except Exception as e:
            self._set_headers(400)
            self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
            print(f"❌ [Ошибка семантики модели]: {e}")

if __name__ == "__main__":
    server = http.server.HTTPServer(('localhost', PORT), SfiralComputeHandler)
    print(f"🚀 Ядро Сфирали (Связь Модели с Семантикой) активно: http://localhost:{PORT}")
    server.serve_forever()