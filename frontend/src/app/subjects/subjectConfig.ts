import type { Slide } from "@/app/presentation/Slides";
import type { Task } from "@/app/tasks/tasks";

export type SubjectId =
  | "math"
  | "natural_science"
  | "algebra"
  | "geometry"
  | "physics"
  | "chemistry"
  | "biology"
  | "russian"
  | "kazakh"
  | "history"
  | "informatics"
  | "geography"
  | "english";

export type SubjectMeta = {
  id: SubjectId;
  nameRu: string;
  nameKk: string;
  lessonRu: string;
  lessonKk: string;
  focusRu: string[];
  focusKk: string[];
};

const SUBJECT_MAP: Record<SubjectId, SubjectMeta> = {
  math: {
    id: "math", nameRu: "Математика", nameKk: "Математика",
    lessonRu: "Математика · практическая лаборатория", lessonKk: "Математика · практикалық зертхана",
    focusRu: ["числа", "вычисления", "задачи"], focusKk: ["сандар", "есептеулер", "есептер"],
  },
  natural_science: {
    id: "natural_science", nameRu: "Естествознание", nameKk: "Жаратылыстану",
    lessonRu: "Естествознание · практическая лаборатория", lessonKk: "Жаратылыстану · практикалық зертхана",
    focusRu: ["природа", "наблюдения", "опыты"], focusKk: ["табиғат", "бақылау", "тәжірибе"],
  },
  algebra: {
    id: "algebra",
    nameRu: "Алгебра",
    nameKk: "Алгебра",
    lessonRu: "Алгебра · практическая лаборатория",
    lessonKk: "Алгебра · практикалық зертхана",
    focusRu: ["многочлены", "уравнения", "преобразования"],
    focusKk: ["көпмүшелер", "теңдеулер", "түрлендірулер"],
  },
  geometry: {
    id: "geometry",
    nameRu: "Геометрия",
    nameKk: "Геометрия",
    lessonRu: "Геометрия · практическая лаборатория",
    lessonKk: "Геометрия · практикалық зертхана",
    focusRu: ["треугольники", "окружности", "площади"],
    focusKk: ["үшбұрыштар", "шеңберлер", "аудандар"],
  },
  physics: {
    id: "physics",
    nameRu: "Физика",
    nameKk: "Физика",
    lessonRu: "Физика · практическая лаборатория",
    lessonKk: "Физика · практикалық зертхана",
    focusRu: ["механика", "энергия", "электричество"],
    focusKk: ["механика", "энергия", "электр"],
  },
  chemistry: {
    id: "chemistry",
    nameRu: "Химия",
    nameKk: "Химия",
    lessonRu: "Химия · практическая лаборатория",
    lessonKk: "Химия · практикалық зертхана",
    focusRu: ["реакции", "стехиометрия", "растворы"],
    focusKk: ["реакциялар", "стехиометрия", "ерітінділер"],
  },
  biology: {
    id: "biology",
    nameRu: "Биология",
    nameKk: "Биология",
    lessonRu: "Биология · практическая лаборатория",
    lessonKk: "Биология · практикалық зертхана",
    focusRu: ["клетка", "генетика", "экосистемы"],
    focusKk: ["жасуша", "генетика", "экожүйелер"],
  },
  russian: {
    id: "russian",
    nameRu: "Русский язык",
    nameKk: "Орыс тілі",
    lessonRu: "Русский язык · практическая лаборатория",
    lessonKk: "Орыс тілі · практикалық зертхана",
    focusRu: ["грамматика", "синтаксис", "орфография"],
    focusKk: ["грамматика", "синтаксис", "орфография"],
  },
  kazakh: {
    id: "kazakh",
    nameRu: "Казахский язык",
    nameKk: "Қазақ тілі",
    lessonRu: "Казахский язык · практическая лаборатория",
    lessonKk: "Қазақ тілі · практикалық зертхана",
    focusRu: ["лексика", "морфология", "синтаксис"],
    focusKk: ["лексика", "морфология", "синтаксис"],
  },
  history: {
    id: "history",
    nameRu: "История Казахстана",
    nameKk: "Қазақстан тарихы",
    lessonRu: "История · практическая лаборатория",
    lessonKk: "Тарих · практикалық зертхана",
    focusRu: ["периоды", "причины и последствия", "источники"],
    focusKk: ["кезеңдер", "себеп пен салдар", "дереккөздер"],
  },
  informatics: {
    id: "informatics",
    nameRu: "Информатика",
    nameKk: "Информатика",
    lessonRu: "Информатика · практическая лаборатория",
    lessonKk: "Информатика · практикалық зертхана",
    focusRu: ["алгоритмы", "структуры данных", "программирование"],
    focusKk: ["алгоритмдер", "деректер құрылымы", "бағдарламалау"],
  },
  geography: {
    id: "geography",
    nameRu: "География",
    nameKk: "География",
    lessonRu: "География · практическая лаборатория",
    lessonKk: "География · практикалық зертхана",
    focusRu: ["карты", "климат", "ресурсы"],
    focusKk: ["карталар", "климат", "ресурстар"],
  },
  english: {
    id: "english", nameRu: "Английский язык", nameKk: "Ағылшын тілі",
    lessonRu: "Английский язык · практическая лаборатория", lessonKk: "Ағылшын тілі · практикалық зертхана",
    focusRu: ["лексика", "грамматика", "речь"], focusKk: ["лексика", "грамматика", "сөйлеу"],
  },
};

const SUBJECT_IDS: SubjectId[] = Object.keys(SUBJECT_MAP) as SubjectId[];
export const DEFAULT_SUBJECT_ID: SubjectId = "algebra";

const normalizeId = (value: string | null | undefined): SubjectId => {
  const cleaned = (value ?? "").trim().toLowerCase();
  return SUBJECT_IDS.includes(cleaned as SubjectId) ? (cleaned as SubjectId) : DEFAULT_SUBJECT_ID;
};

export const getSubjectIdFromWindow = (): SubjectId => {
  if (typeof window === "undefined") return DEFAULT_SUBJECT_ID;
  const params = new URLSearchParams(window.location.search);
  return normalizeId(params.get("subject"));
};

export type PortalRole = "student" | "teacher" | "parent" | "admin";

/** Read the one-time token from the URL query string */
export const getPracticeTokenFromWindow = (): string | null => {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("token") ?? null;
};

/**
 * Verify the token with the practice-module backend.
 * Returns the role on success, null if the token is missing/invalid.
 */
export const verifyPracticeToken = async (token: string): Promise<PortalRole | null> => {
  try {
    const res = await fetch(`/api/auth/verify?token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const role = data?.role as string | undefined;
    if (role === "student" || role === "parent" || role === "teacher" || role === "admin")
      return role;
    return null;
  } catch {
    return null;
  }
};

export const withSubjectQuery = (path: string, subjectId: string): string => {
  const sid = normalizeId(subjectId);
  return `${path}${path.includes("?") ? "&" : "?"}subject=${encodeURIComponent(sid)}`;
};

export const getSubjectMeta = (subjectId: string): SubjectMeta => SUBJECT_MAP[normalizeId(subjectId)];

export const getDefaultTasksForSubject = (_subjectId: string): Task[] => [];

export const buildDefaultSlidesForSubject = (subjectId: string, locale: "ru" | "kk"): Slide[] => {
  const meta = getSubjectMeta(subjectId);
  const name = locale === "kk" ? meta.nameKk : meta.nameRu;
  const focus = locale === "kk" ? meta.focusKk : meta.focusRu;

  if (locale === "kk") {
    return [
      {
        id: 1,
        title: `${name}: кіріспе`,
        content: `${name} зертханасына қош келдіңіз.\nБүгінгі фокус: ${focus.join(", ")}.`,
        notes: "Сабақ мақсатын 1 минутта нақтылап, күтілетін нәтижелерді айтыңыз.",
      },
      {
        id: 2,
        title: "Оқу мақсаты",
        content: `1) Негізгі ұғымдарды бекіту.\n2) Типтік есептерді шешу.\n3) Қателерді талдап, дұрыс стратегияны табу.`,
        notes: "Оқушыларға бағалау критерийлерін алдын ала көрсетіңіз.",
      },
      {
        id: 3,
        title: "Әдіс пен қадам",
        content: `Тізбек: шартты түсіну → шешу жоспары → есептеу/талдау → тексеру.`,
        notes: "Әр қадамда «неге?» сұрағын қойып отырыңыз.",
      },
      {
        id: 4,
        title: "Практика бөлімі",
        content: `Карточкалармен жұмыс: алдымен өз бетімен, кейін жұппен тексеру.`,
        notes: "1-2 тапсырманы тақтада бірге талдаңыз.",
      },
      {
        id: 5,
        title: "Рефлексия",
        content: `Қандай тақырып түсінікті болды?\nҚай жерде қате көп кездесті?`,
        notes: "Қысқа ауызша кері байланыс жинаңыз.",
      },
      {
        id: 6,
        title: "Қорытынды",
        content: `Үйге: осы зертханадағы 2-3 тапсырманы қайталау.\nКелесі сабаққа дайындық: ${focus[0]}.`,
        notes: "Келесі сабақтағы байланыс тақырыбын алдын ала атап өтіңіз.",
      },
    ];
  }

  return [
    {
      id: 1,
      title: `${name}: вводный блок`,
      content: `Добро пожаловать в лабораторию по предмету «${name}».\nСегодня в фокусе: ${focus.join(", ")}.`,
      notes: "Обозначьте цель занятия и ожидаемый результат в начале урока.",
    },
    {
      id: 2,
      title: "Цели урока",
      content: "1) Закрепить ключевые понятия.\n2) Решить типовые задачи.\n3) Разобрать частые ошибки.",
      notes: "Сразу покажите критерии проверки и логику оценивания.",
    },
    {
      id: 3,
      title: "Алгоритм работы",
      content: "Схема: понять условие → выбрать стратегию → выполнить решение → проверить результат.",
      notes: "На каждом шаге просите ученика объяснить ход мысли.",
    },
    {
      id: 4,
      title: "Практическая часть",
      content: "Работаем по карточкам: сначала индивидуально, затем сверяем решения в паре.",
      notes: "Один пример разберите на доске в формате «ошибка → исправление».",
    },
    {
      id: 5,
      title: "Рефлексия",
      content: "Какая тема далась легче всего?\nГде возникли ошибки и почему?",
      notes: "Соберите короткую обратную связь в конце практики.",
    },
    {
      id: 6,
      title: "Итоги",
      content: `Домашняя отработка: 2-3 задания из лаборатории.\nПодготовка к следующему занятию: ${focus[0]}.`,
      notes: "Подведите итог и обозначьте следующий учебный шаг.",
    },
  ];
};
