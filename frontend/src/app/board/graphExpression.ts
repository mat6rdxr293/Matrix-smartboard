export type GraphExpressionProgram = {
  evaluate: (x: number) => number;
};

type Token =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "^" }
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "eof" };

type Ast =
  | { kind: "number"; value: number }
  | { kind: "x" }
  | { kind: "unary"; op: "+" | "-"; value: Ast }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: Ast; right: Ast }
  | { kind: "call"; name: string; argument: Ast };

const MAX_EXPRESSION_LENGTH = 120;
const MAX_TOKENS = 256;
const MAX_PROGRAM_CACHE = 128;
const programCache = new Map<string, GraphExpressionProgram>();

const FUNCTIONS: Record<string, (value: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  tg: Math.tan,
  cot: (value) => 1 / Math.tan(value),
  ctg: (value) => 1 / Math.tan(value),
  sec: (value) => 1 / Math.cos(value),
  csc: (value) => 1 / Math.sin(value),
  asin: Math.asin,
  arcsin: Math.asin,
  acos: Math.acos,
  arccos: Math.acos,
  atan: Math.atan,
  arctan: Math.atan,
  arctg: Math.atan,
  acot: (value) => Math.PI / 2 - Math.atan(value),
  arccot: (value) => Math.PI / 2 - Math.atan(value),
  arcctg: (value) => Math.PI / 2 - Math.atan(value),
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  coth: (value) => 1 / Math.tanh(value),
  ln: Math.log,
  log: Math.log10,
  lg: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
};

const isNameStart = (char: string) => /[A-Za-z_πΠ]/.test(char);
const isNamePart = (char: string) => /[A-Za-z0-9_πΠ]/.test(char);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.,]/.test(char)) {
      let raw = "";
      let separators = 0;
      while (index < source.length && /[0-9.,]/.test(source[index])) {
        if (source[index] === "." || source[index] === ",") separators += 1;
        raw += source[index];
        index += 1;
      }
      if (separators > 1 || raw === "." || raw === ",") throw new Error("Некорректное число");
      const value = Number(raw.replace(",", "."));
      if (!Number.isFinite(value)) throw new Error("Некорректное число");
      tokens.push({ kind: "number", value });
      continue;
    }
    if (isNameStart(char)) {
      let raw = char;
      index += 1;
      while (index < source.length && isNamePart(source[index])) {
        raw += source[index];
        index += 1;
      }
      tokens.push({ kind: "name", value: raw.toLowerCase() });
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen" });
      index += 1;
      continue;
    }
    if (char === "+" || char === "-" || char === "*" || char === "/" || char === "^") {
      tokens.push({ kind: "op", value: char });
      index += 1;
      continue;
    }
    throw new Error(`Недопустимый символ: ${char}`);
  }
  if (tokens.length > MAX_TOKENS) throw new Error("Слишком сложное выражение");
  return insertImplicitMultiplication(tokens);
}

const isValueEnd = (token: Token) => token.kind === "number" || token.kind === "name" || token.kind === "rparen";
const isValueStart = (token: Token) => token.kind === "number" || token.kind === "name" || token.kind === "lparen";

function insertImplicitMultiplication(tokens: Token[]): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const previous = result[result.length - 1];
    const previousIsFunction = previous?.kind === "name" && current.kind === "lparen" && previous.value in FUNCTIONS;
    if (previous && isValueEnd(previous) && isValueStart(current) && !previousIsFunction) {
      result.push({ kind: "op", value: "*" });
    }
    result.push(current);
  }
  result.push({ kind: "eof" });
  return result;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Ast {
    const ast = this.parseExpression(0);
    if (this.peek().kind !== "eof") throw new Error("Лишняя часть выражения");
    return ast;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? { kind: "eof" };
  }

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private parseExpression(minBindingPower: number): Ast {
    let left = this.parsePrefix();
    while (true) {
      const token = this.peek();
      if (token.kind !== "op") break;
      const binding = this.bindingPower(token.value);
      if (!binding || binding[0] < minBindingPower) break;
      this.take();
      const right = this.parseExpression(binding[1]);
      left = { kind: "binary", op: token.value, left, right };
    }
    return left;
  }

  private bindingPower(op: "+" | "-" | "*" | "/" | "^"): [number, number] {
    if (op === "+" || op === "-") return [10, 11];
    if (op === "*" || op === "/") return [20, 21];
    return [40, 40];
  }

  private parsePrefix(): Ast {
    const token = this.take();
    if (token.kind === "number") return { kind: "number", value: token.value };
    if (token.kind === "op" && (token.value === "+" || token.value === "-")) {
      return { kind: "unary", op: token.value, value: this.parseExpression(30) };
    }
    if (token.kind === "lparen") {
      const value = this.parseExpression(0);
      if (this.take().kind !== "rparen") throw new Error("Не закрыта скобка");
      return value;
    }
    if (token.kind === "name") {
      if (token.value === "x") return { kind: "x" };
      if (token.value === "pi" || token.value === "π") return { kind: "number", value: Math.PI };
      if (token.value === "e") return { kind: "number", value: Math.E };
      const fn = FUNCTIONS[token.value];
      if (!fn) throw new Error(`Неизвестное имя: ${token.value}`);
      if (this.take().kind !== "lparen") throw new Error(`После ${token.value} нужна скобка`);
      const argument = this.parseExpression(0);
      if (this.take().kind !== "rparen") throw new Error("Не закрыта скобка");
      return { kind: "call", name: token.value, argument };
    }
    if (token.kind === "rparen") throw new Error("Лишняя закрывающая скобка");
    throw new Error("Ожидалось число, x или функция");
  }
}

function evaluateAst(ast: Ast, x: number): number {
  if (ast.kind === "number") return ast.value;
  if (ast.kind === "x") return x;
  if (ast.kind === "unary") {
    const value = evaluateAst(ast.value, x);
    return ast.op === "-" ? -value : value;
  }
  if (ast.kind === "binary") {
    const left = evaluateAst(ast.left, x);
    const right = evaluateAst(ast.right, x);
    if (ast.op === "+") return left + right;
    if (ast.op === "-") return left - right;
    if (ast.op === "*") return left * right;
    if (ast.op === "/") return left / right;
    return left ** right;
  }
  return FUNCTIONS[ast.name](evaluateAst(ast.argument, x));
}

export function compileExpression(source: string): GraphExpressionProgram {
  const normalized = source.trim();
  if (!normalized) throw new Error("Введите выражение");
  if (normalized.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`Выражение длиннее ${MAX_EXPRESSION_LENGTH} символов`);
  }
  const cached = programCache.get(normalized);
  if (cached) {
    programCache.delete(normalized);
    programCache.set(normalized, cached);
    return cached;
  }
  const ast = new Parser(tokenize(normalized)).parse();
  const program = { evaluate: (x: number) => evaluateAst(ast, x) };
  programCache.set(normalized, program);
  if (programCache.size > MAX_PROGRAM_CACHE) {
    const oldest = programCache.keys().next().value;
    if (oldest !== undefined) programCache.delete(oldest);
  }
  return program;
}
