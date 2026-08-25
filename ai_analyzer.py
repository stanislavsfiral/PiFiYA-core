import os
import json

AI_MEMORY_DIR = "ai_memory"
TIMELINE_LOG_FILE = os.path.join(AI_MEMORY_DIR, "ai_timeline_log.jsonl")

def analyze_memory():
    print("🧠 [AI Analyzer]: Сканирование памяти проекта...")
    
    if not os.path.exists(AI_MEMORY_DIR):
        print(f"❌ Папка '{AI_MEMORY_DIR}' не найдена!")
        return

    # 1. Анализ общего файла логов (JSONL)
    total_sessions = 0
    all_actions = {}
    node_counts = []

    if os.path.exists(TIMELINE_LOG_FILE):
        with open(TIMELINE_LOG_FILE, "r", encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                    total_sessions += 1
                    node_counts.append(record.get("total_nodes", 0))
                    
                    for step in record.get("timeline", []):
                        action = step.get("action", "UNKNOWN")
                        all_actions[action] = all_actions.get(action, 0) + 1
                except json.JSONDecodeError:
                    pass

    # 2. Подсчет детальных JSON-файлов сессий в папке
    json_files = [f for f in os.listdir(AI_MEMORY_DIR) if f.startswith("session_") and f.endswith(".json")]

    print("\n" + "="*40)
    print("📊 ОТЧЕТ ПО ПАМЯТИ ИИ (AI MEMORY SUMMARY)")
    print("="*40)
    print(f"📁 Всего файлов сессий на диске: {len(json_files)}")
    print(f"📜 Записей в логе таймлайна (JSONL): {total_sessions}")
    
    if node_counts:
        print(f"📦 Максимальное число узлов в сессиях: {max(node_counts)}")
        print(f"📦 Среднее число узлов на сессию: {sum(node_counts)/len(node_counts):.1f}")
    
    print("\n🛠️ Статистика действий (Топ паттернов):")
    if all_actions:
        sorted_actions = sorted(all_actions.items(), key=lambda x: x[1], reverse=True)
        for act, count in sorted_actions:
            print(f"   • {act}: {count} раз(а)")
    else:
        print("   • Действий пока нет в логах.")
    print("="*40)
    print("💡 Совет: Можете скопировать этот текстовый отчет и прислать сюда — я сразу пойму, над какими узлами вы работали!")

if __name__ == "__main__":
    analyze_memory()