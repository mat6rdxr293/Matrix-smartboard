import { expect, test, type Page, type Route } from "@playwright/test";

const school = {
  id: "school-e2e",
  name: "Matrix E2E",
  createdAt: 1_790_000_000_000,
};

const room = {
  id: "room-e2e",
  schoolId: school.id,
  name: "11A",
  createdAt: 1_790_000_000_000,
};

const lesson = {
  id: "lesson-e2e",
  schoolId: school.id,
  roomId: room.id,
  roomName: room.name,
  grade: 11,
  subjectId: "algebra",
  status: "active",
  startedAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_000,
  endedAt: null,
};

const graph = {
  id: "graph-e2e",
  x: 720,
  y: 120,
  width: 420,
  height: 300,
  xLabel: "x",
  yLabel: "y",
  xMin: -10,
  xMax: 10,
  yMin: -10,
  yMax: 10,
  expressions: [
    { id: "expr-e2e", expression: "x^2", color: "#4DA3FF", visible: true },
  ],
};

type TestStroke = {
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
  mode: "draw";
  source?: "user" | "ai";
};

type CapturedOp = {
  op?: string;
  stroke?: TestStroke;
  strokes?: TestStroke[];
};

const taskStroke = (x1: number, y1: number, x2: number, y2: number): TestStroke => ({
  points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
  color: "#ff0000",
  width: 4,
  mode: "draw",
  source: "user",
});

const defaultTaskStrokes = [
  taskStroke(90, 120, 150, 180),
  taskStroke(155, 145, 210, 145),
  taskStroke(220, 115, 220, 185),
  taskStroke(235, 145, 295, 145),
];

const json = (route: Route, body: unknown) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

async function seedLesson(
  page: Page,
  options?: {
    withGraph?: boolean;
    captureOps?: CapturedOp[];
    initialStrokes?: TestStroke[];
    aiMode?: "hint" | "check" | "solution";
    aiResponse?: {
      text: string;
      steps: Array<{ text: string; kind: "text" | "math" | "warning" | "result" }>;
    };
  },
) {
  await page.addInitScript(({ schoolId, roomId, lessonId }) => {
    localStorage.setItem("practice.room." + schoolId, roomId);
    localStorage.setItem("practice.lesson." + lessonId + ".boardProfile", "universal");
  }, { schoolId: school.id, roomId: room.id, lessonId: lesson.id });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === "/api/auth/session") return json(route, { school });
    if (path === "/api/rooms" && method === "GET") return json(route, { items: [room] });
    if (path === "/api/rooms/" + room.id + "/active-lesson") return json(route, { lesson });
    if (path === "/api/lessons/" + lesson.id + "/resume" && method === "POST") return json(route, { lesson });
    if (path === "/api/lessons/" + lesson.id + "/chat") return json(route, { items: [] });

    if (path === "/api/lessons/" + lesson.id + "/board" && method === "GET") {
      const initialStrokes = options?.initialStrokes ?? defaultTaskStrokes;
      const strokeOperations = initialStrokes.map((stroke, index) => ({
        sequence: index + 1,
        clientOperationId: "stroke-op-" + index,
        op: "add",
        stroke,
        ts: 100 + index,
      }));
      const graphOperations = options?.withGraph
        ? [{
            sequence: strokeOperations.length + 1,
            clientOperationId: "graph-op-e2e",
            op: "graph_add",
            graph,
            ts: 200,
          }]
        : [];
      return json(route, { operations: [...strokeOperations, ...graphOperations] });
    }

    if (path === "/api/lessons/" + lesson.id + "/board/operations" && method === "POST") {
      const body = request.postDataJSON() as { operations?: CapturedOp[] };
      options?.captureOps?.push(...(body.operations ?? []));
      return json(route, { ok: true, inserted: body.operations?.length ?? 0 });
    }

    if (path === "/api/status") return json(route, { ok: true, ai: true, ocr: true });
    if (path === "/api/storage" && method === "GET") return json(route, { tasks: [], slides: [] });
    if (path === "/api/storage" && method === "POST") return json(route, { ok: true });
    if (path === "/api/ocr" && method === "POST") return json(route, { text: "Решить: x^2 - 4 = 0" });

    if (path === "/api/ai" && method === "POST") {
      const payload = request.postDataJSON() as { mode?: string; board_output?: boolean; response_locale?: string };
      expect(payload.mode).toBe(options?.aiMode ?? "solution");
      expect(payload.board_output).toBe(true);
      expect(payload.response_locale).toBe("ru");
      return json(route, options?.aiResponse ?? {
        text: "Решение",
        steps: [
          { text: "$$x^2 - 4 = 0$$", kind: "math" },
          { text: "$$(x-2)(x+2)=0$$", kind: "math" },
          { text: "$$x=-2,\\;2$$", kind: "result" },
        ],
      });
    }

    return json(route, {});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Вернуться к уроку" }).click();
  await expect(page.getByTestId("board-canvas-root")).toBeVisible();
}

async function generateSolution(page: Page, operations: CapturedOp[]) {
  await page.getByTestId("open-ai-assistant").click();
  await page.getByTestId("ai-full-solution").click();
  await expect(page.getByTestId("ocr-confirm")).toBeVisible();
  await page.getByTestId("ocr-confirm").click();

  await expect.poll(() =>
    operations.find((operation) => operation.op === "stroke_batch_add")?.strokes?.length ?? 0,
    { timeout: 20_000 },
  ).toBeGreaterThan(8);
}

test("full solution is handwriting strokes placed away from an existing graph", async ({ page }) => {
  const operations: CapturedOp[] = [];
  await seedLesson(page, { withGraph: true, captureOps: operations });
  await generateSolution(page, operations);

  await expect(page.getByTestId("ai-solution-block")).toHaveCount(0);

  const batch = operations.find((operation) => operation.op === "stroke_batch_add");
  expect(batch?.strokes?.length).toBeGreaterThan(8);

  const points = batch?.strokes?.flatMap((stroke) => stroke.points) ?? [];
  expect(points.length).toBeGreaterThan(30);

  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));

  const overlapsGraph =
    left < graph.x + graph.width &&
    right > graph.x &&
    top < graph.y + graph.height &&
    bottom > graph.y;
  expect(overlapsGraph).toBe(false);
});

test("one undo removes the whole AI handwriting batch and redo restores it", async ({ page }) => {
  const operations: CapturedOp[] = [];
  await seedLesson(page, { captureOps: operations });
  await generateSolution(page, operations);

  await page.getByTestId("board-undo").evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => operations.some((operation) => operation.op === "undo")).toBe(true);

  await page.getByTestId("board-redo").evaluate((button) => (button as HTMLButtonElement).click());
  await expect.poll(() => operations.some((operation) => operation.op === "redo")).toBe(true);

  expect(operations.filter((operation) => operation.op === "stroke_batch_add")).toHaveLength(1);
});


test("with two equations the latest user block is OCR target and solution stays close to it", async ({ page }) => {
  const operations: CapturedOp[] = [];
  const first = [
    taskStroke(60, 100, 120, 165),
    taskStroke(125, 130, 180, 130),
    taskStroke(190, 100, 190, 170),
  ];
  const second = [
    taskStroke(390, 110, 450, 175),
    taskStroke(455, 140, 510, 140),
    taskStroke(520, 110, 520, 180),
  ];
  await seedLesson(page, {
    captureOps: operations,
    initialStrokes: [...first, ...second],
  });
  await generateSolution(page, operations);

  const batch = operations.find((operation) => operation.op === "stroke_batch_add");
  const points = batch?.strokes?.flatMap((stroke) => stroke.points) ?? [];
  expect(points.length).toBeGreaterThan(30);

  const solution = {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
  const firstBounds = { left: 58, top: 98, right: 192, bottom: 172 };
  const secondBounds = { left: 388, top: 108, right: 522, bottom: 182 };

  const overlaps = (
    a: { left: number; top: number; right: number; bottom: number },
    b: { left: number; top: number; right: number; bottom: number },
  ) =>
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top;

  expect(overlaps(solution, firstBounds)).toBe(false);
  expect(overlaps(solution, secondBounds)).toBe(false);

  const dx = Math.max(
    0,
    secondBounds.left - solution.right,
    solution.left - secondBounds.right,
  );
  const dy = Math.max(
    0,
    secondBounds.top - solution.bottom,
    solution.top - secondBounds.bottom,
  );
  expect(Math.hypot(dx, dy)).toBeLessThan(90);
});


async function generateBoardMode(
  page: Page,
  operations: CapturedOp[],
  buttonTestId: "ai-hint" | "ai-check" | "ai-full-solution",
) {
  await page.getByTestId("open-ai-assistant").click();
  await page.getByTestId(buttonTestId).click();
  await expect(page.getByTestId("ocr-confirm")).toBeVisible();
  await page.getByTestId("ocr-confirm").click();

  await expect.poll(() =>
    operations.find((operation) => operation.op === "stroke_batch_add")?.strokes?.length ?? 0,
    { timeout: 20_000 },
  ).toBeGreaterThan(4);
}

test("hint is written directly on the board in AI ink different from student ink", async ({ page }) => {
  const operations: CapturedOp[] = [];
  await seedLesson(page, {
    captureOps: operations,
    aiMode: "hint",
    aiResponse: {
      text: "Подсказка",
      steps: [
        { text: "Сначала найди дискриминант.", kind: "text" },
        { text: "$$D=b^2-4ac$$", kind: "math" },
      ],
    },
  });

  await generateBoardMode(page, operations, "ai-hint");

  const batch = operations.find((operation) => operation.op === "stroke_batch_add");
  expect(batch?.strokes?.length).toBeGreaterThan(4);
  const colors = new Set(batch?.strokes?.map((stroke) => stroke.color.toUpperCase()) ?? []);
  expect(colors.size).toBe(1);
  const [aiColor] = [...colors];
  expect(aiColor).not.toBe("#FF0000");
  expect(["#2563EB", "#7C3AED", "#0891B2", "#60A5FA", "#A78BFA", "#22D3EE"]).toContain(aiColor);
});

test("check writes the first error on the board using error ink", async ({ page }) => {
  const operations: CapturedOp[] = [];
  await seedLesson(page, {
    captureOps: operations,
    aiMode: "check",
    aiResponse: {
      text: "Выполнено: 60%\n\n1. Ошибка: неверно вычислен дискриминант.",
      steps: [
        { text: "Ошибка: неверно вычислен дискриминант.", kind: "warning" },
        { text: "$$D=16-20=-4$$", kind: "math" },
      ],
    },
  });

  await generateBoardMode(page, operations, "ai-check");

  const batch = operations.find((operation) => operation.op === "stroke_batch_add");
  expect(batch?.strokes?.length).toBeGreaterThan(4);
  const colors = new Set(batch?.strokes?.map((stroke) => stroke.color.toUpperCase()) ?? []);
  expect(colors.size).toBe(1);
  const [aiColor] = [...colors];
  expect(aiColor).not.toBe("#FF0000");
  expect(["#D97706", "#DC2626", "#7C3AED", "#FBBF24", "#FB7185", "#C084FC"]).toContain(aiColor);
});


test("math handwriting uses geometric integral, radical bar and relation signs", async ({ page }) => {
  const operations: CapturedOp[] = [];
  await seedLesson(page, {
    captureOps: operations,
    aiResponse: {
      text: "Решение",
      steps: [
        {
          text: "$$\\int_{0}^{4}(3x^2+\\sqrt{x+1})\\,dx$$",
          kind: "math",
        },
        {
          text: "$$x<4,\\quad y\\ge2$$",
          kind: "result",
        },
      ],
    },
  });

  await generateSolution(page, operations);

  const batch = operations.find((operation) => operation.op === "stroke_batch_add");
  const strokes = batch?.strokes ?? [];
  expect(strokes.length).toBeGreaterThan(10);

  const radicalBar = strokes.find((stroke) => {
    if (stroke.points.length !== 2) return false;
    const [start, end] = stroke.points;
    return (
      Math.abs(start.y - end.y) < 0.01 &&
      Math.abs(end.x - start.x) > 20
    );
  });
  expect(radicalBar).toBeTruthy();

  const integralCurve = strokes.find((stroke) => {
    if (stroke.points.length < 25) return false;
    const ys = stroke.points.map((point) => point.y);
    return Math.max(...ys) - Math.min(...ys) > 30;
  });
  expect(integralCurve).toBeTruthy();

  const shortAngularStrokes = strokes.filter((stroke) => {
    if (stroke.points.length !== 2) return false;
    const [start, end] = stroke.points;
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    return dx > 6 && dy > 6 && dx < 40 && dy < 40;
  });
  expect(shortAngularStrokes.length).toBeGreaterThanOrEqual(4);
});
