"""Общие промпты: одинаковые при обучении, в бенчмарке и в RAG."""

SYSTEM_PROMPT = {
    "kk": "Сен мектеп мұғалімінің көмекшісісің. Қысқа әрі нақты жауап бер.",
    "ru": "Ты помощник школьного учителя. Отвечай кратко и точно.",
    "en": "You are a school teacher's assistant. Answer briefly and accurately.",
}

# Как подавать найденные фрагменты учебника/вики в вопрос (--rag)
RAG_TEMPLATE = {
    "kk": "Төмендегі мәтіндерді пайдаланып сұраққа жауап бер. Мәтінде жауап болмаса, өз біліміңмен жауап бер.\n\n{context}\n\nСұрақ: {question}",
    "ru": "Используй приведённые ниже фрагменты, чтобы ответить на вопрос. Если ответа в них нет, отвечай по своим знаниям.\n\n{context}\n\nВопрос: {question}",
    "en": "Use the passages below to answer the question. If they do not contain the answer, answer from your own knowledge.\n\n{context}\n\nQuestion: {question}",
}


def format_context(hits):
    return "\n\n".join(f"[{i}] {h['title']}\n{h['text']}" for i, h in enumerate(hits, 1))
