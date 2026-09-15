import type { Slide } from "@/app/presentation/Slides";
import { tasks as algebraTasks, type Task } from "@/app/tasks/tasks";

export type SubjectId =
  | "algebra"
  | "geometry"
  | "physics"
  | "chemistry"
  | "biology"
  | "russian"
  | "kazakh"
  | "history"
  | "informatics"
  | "geography";

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

const SUBJECT_TASKS: Record<Exclude<SubjectId, "algebra">, Task[]> = {
  geometry: [
    { id: 1, title: "Теорема Пифагора", problem: "В прямоугольном треугольнике катеты 9 и 12. Найди гипотенузу.", tags: ["треугольник"] },
    { id: 2, title: "Площадь треугольника", problem: "Найди площадь треугольника со сторонами 5, 5 и 6.", tags: ["площадь"] },
    { id: 3, title: "Центральный и вписанный углы", problem: "Центральный угол равен 110°. Найди вписанный, опирающийся на ту же дугу.", tags: ["углы"] },
    { id: 4, title: "Подобие", problem: "Стороны подобных треугольников относятся как 2:3. Площадь меньшего 24. Найди площадь большего.", tags: ["подобие"] },
  ],
  physics: [
    { id: 1, title: "Второй закон Ньютона", problem: "На тело массой 4 кг действует сила 20 Н. Найди ускорение.", tags: ["динамика"] },
    { id: 2, title: "Работа и мощность", problem: "Груз 500 Н подняли на высоту 8 м за 20 с. Найди работу и мощность.", tags: ["энергия"] },
    { id: 3, title: "Закон Ома", problem: "При R=12 Ом и I=1.5 А найди напряжение и мощность.", tags: ["электричество"] },
    { id: 4, title: "Импульс", problem: "Тело 2 кг движется со скоростью 6 м/с. Найди импульс.", tags: ["импульс"] },
  ],
  chemistry: [
    { id: 1, title: "Уравнение реакции", problem: "Составь и уравняй реакцию горения метана CH4.", tags: ["реакции"] },
    { id: 2, title: "Молярная масса", problem: "Найди молярную массу H2SO4.", tags: ["моль"] },
    { id: 3, title: "Стехиометрия", problem: "Сколько граммов CO2 получится при сжигании 12 г углерода?", tags: ["расчёты"] },
    { id: 4, title: "Ионные уравнения", problem: "Запиши сокращённое ионное уравнение для реакции HCl и NaOH.", tags: ["ионы"] },
  ],
  biology: [
    { id: 1, title: "Строение клетки", problem: "Назови основные органоиды клетки и кратко укажи их функции.", tags: ["клетка"] },
    { id: 2, title: "Генетика", problem: "Скрещивание Aa × aa. Определи вероятности генотипов потомства.", tags: ["генетика"] },
    { id: 3, title: "Фотосинтез", problem: "Объясни, от чего зависит интенсивность фотосинтеза.", tags: ["растения"] },
    { id: 4, title: "Экосистема", problem: "Приведи пример пищевой цепи из 4 звеньев.", tags: ["экология"] },
  ],
  russian: [
    { id: 1, title: "Сложное предложение", problem: "Определи тип связи в предложении и расставь знаки препинания.", tags: ["синтаксис"] },
    { id: 2, title: "Орфография", problem: "Вставь пропущенные буквы и объясни правила.", tags: ["орфография"] },
    { id: 3, title: "Морфология", problem: "Сделай морфологический разбор глагола в предложении.", tags: ["морфология"] },
    { id: 4, title: "Лексика", problem: "Подбери по 2 синонима и 2 антонима к слову «смелый».", tags: ["лексика"] },
  ],
  kazakh: [
    { id: 1, title: "Зат есім", problem: "Берілген сөздерді көпше түрге қойып, септеп жазыңдар.", tags: ["грамматика"] },
    { id: 2, title: "Етістік", problem: "Етістікті осы шақ, өткен шақ, келер шақ формаларында жазыңдар.", tags: ["етістік"] },
    { id: 3, title: "Сөйлем мүшелері", problem: "Сөйлемдегі бастауыш пен баяндауышты анықтаңдар.", tags: ["синтаксис"] },
    { id: 4, title: "Лексика", problem: "Берілген сөздерге синоним және антоним жазыңдар.", tags: ["лексика"] },
  ],
  history: [
    { id: 1, title: "Хронология", problem: "Расположи события в правильном историческом порядке.", tags: ["хронология"] },
    { id: 2, title: "Причины и последствия", problem: "Назови 3 причины и 3 последствия выбранной реформы.", tags: ["анализ"] },
    { id: 3, title: "Исторический источник", problem: "Определи, к какому периоду относится источник и почему.", tags: ["источник"] },
    { id: 4, title: "Краткое эссе", problem: "Напиши короткое объяснение роли события в истории Казахстана.", tags: ["эссе"] },
  ],
  informatics: [
    { id: 1, title: "Алгоритм", problem: "Запиши псевдокод поиска максимума в массиве из N чисел.", tags: ["алгоритмы"] },
    { id: 2, title: "Python: условия", problem: "Напиши программу, которая определяет чётность введённого числа.", tags: ["python"] },
    { id: 3, title: "Циклы", problem: "С помощью цикла выведи все числа Фибоначчи до 100.", tags: ["циклы"] },
    { id: 4, title: "SQL", problem: "Составь запрос: выбрать всех учеников 10А и отсортировать по фамилии.", tags: ["sql"] },
  ],
  geography: [
    { id: 1, title: "Координаты", problem: "Определи географические координаты заданной точки на карте.", tags: ["карта"] },
    { id: 2, title: "Климат", problem: "Объясни, почему в степи амплитуда температур выше, чем у моря.", tags: ["климат"] },
    { id: 3, title: "Ресурсы", problem: "Назови основные природные ресурсы региона и отрасли их использования.", tags: ["ресурсы"] },
    { id: 4, title: "Население", problem: "Сравни показатели урбанизации двух регионов и сделай вывод.", tags: ["демография"] },
  ],
};

export const getDefaultTasksForSubject = (subjectId: string): Task[] => {
  const sid = normalizeId(subjectId);
  const baseTasks = sid === "algebra" ? algebraTasks : SUBJECT_TASKS[sid];
  return baseTasks.map((task) => ({ ...task, tags: [...task.tags] }));
};

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
