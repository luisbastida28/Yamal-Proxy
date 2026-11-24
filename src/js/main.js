const UNLOCK_STORAGE_KEY = 'yamal_unlocked';
const TAPE_STORAGE_KEY = 'calc_tape_history_v1';
const UNLOCK_CODE = '0000';

// Re-verify persisted unlock state immediately on boot
(async function syncPersistedUnlock() {
  try {
    if (localStorage.getItem(UNLOCK_STORAGE_KEY) === '1') {
      const res = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: UNLOCK_CODE }),
        credentials: 'same-origin',
      });
      if (res.ok) {
        window.location.replace('/unblocker.html');
        return;
      }
    }
  } catch {
    // Keep calculator interactive if request fails
  }
  document.documentElement.classList.remove('is-redirecting');
})();

const viewSections = document.querySelectorAll('.view-section');
const navLinks = document.querySelectorAll('.nav-link');
const headerClearBtn = document.getElementById('header-clear-btn');

const exprLineEl = document.getElementById('calc-expression-line');
const displayEl = document.getElementById('calc-display');
const calcClockEl = document.getElementById('calc-clock');
const calcDateEl = document.getElementById('calc-date');
const angleDegBtn = document.getElementById('angle-deg-btn');
const angleRadBtn = document.getElementById('angle-rad-btn');
const memIndicatorEl = document.getElementById('calc-memory-indicator');
const tapeListEl = document.getElementById('calc-tape-list');
const tapeEmptyEl = document.getElementById('tape-empty-msg');
const tapeClearBtn = document.getElementById('tape-clear-btn');

function updateHomeClock() {
  const now = new Date();
  if (calcClockEl) {
    calcClockEl.textContent = now.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  if (calcDateEl) {
    calcDateEl.textContent = now.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }
}

updateHomeClock();
window.setInterval(updateHomeClock, 1000);

let expression = '';
let lastAnswer = 0;
let memoryValue = 0;
let angleMode = 'deg';
let justEvaluated = false;
let errorState = false;
let tapeEntries = loadTape();

function loadTape() {
  try {
    const raw = localStorage.getItem(TAPE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 40) : [];
  } catch {
    return [];
  }
}

function saveTape() {
  try {
    localStorage.setItem(TAPE_STORAGE_KEY, JSON.stringify(tapeEntries.slice(0, 40)));
  } catch {
    // Ignore storage quota errors
  }
}

function showView(viewName) {
  viewSections.forEach((sec) => {
    sec.classList.toggle('is-visible', sec.id === `view-${viewName}`);
  });
  navLinks.forEach((link) => {
    link.classList.toggle('is-active', link.dataset.nav === viewName);
  });
}

function formatNumber(num) {
  if (!Number.isFinite(num)) return 'Error';
  if (Math.abs(num) < 1e-12) return '0';
  if (Math.abs(num) >= 1e12 || (Math.abs(num) > 0 && Math.abs(num) < 1e-9)) {
    return num.toExponential(8).replace(/\.?0+e/, 'e');
  }
  const rounded = Number(num.toPrecision(12));
  return String(rounded);
}

function formatExpressionForDisplay(expr) {
  if (!expr) return '0';
  return expr
    .replace(/\*/g, '×')
    .replace(/\//g, '÷')
    .replace(/-/g, '−');
}

function updateDisplay() {
  displayEl.textContent = errorState ? 'Error' : formatExpressionForDisplay(expression);
  if (memoryValue !== 0) {
    memIndicatorEl.hidden = false;
    memIndicatorEl.textContent = `M: ${formatNumber(memoryValue)}`;
  } else {
    memIndicatorEl.hidden = true;
  }
}

// Safe mathematical expression tokenizer + recursive-descent parser (no eval)
function tokenizeExpression(raw) {
  const tokens = [];
  let i = 0;
  const s = raw.replace(/\s+/g, '');

  while (i < s.length) {
    const ch = s[i];

    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let numStr = '';
      let dotCount = 0;
      while (i < s.length && ((s[i] >= '0' && s[i] <= '9') || s[i] === '.')) {
        if (s[i] === '.') dotCount += 1;
        if (dotCount > 1) throw new Error('Invalid number');
        numStr += s[i];
        i += 1;
      }
      if (numStr === '.') throw new Error('Invalid decimal');
      tokens.push({ type: 'num', value: Number(numStr) });
      continue;
    }

    if (ch === 'π') {
      tokens.push({ type: 'num', value: Math.PI });
      i += 1;
      continue;
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let ident = '';
      while (i < s.length && ((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= 'A' && s[i] <= 'Z'))) {
        ident += s[i];
        i += 1;
      }
      const lower = ident.toLowerCase();
      if (lower === 'pi') {
        tokens.push({ type: 'num', value: Math.PI });
      } else if (lower === 'e') {
        tokens.push({ type: 'num', value: Math.E });
      } else if (lower === 'ans') {
        tokens.push({ type: 'num', value: lastAnswer });
      } else {
        tokens.push({ type: 'fn', value: lower });
      }
      continue;
    }

    if ('+-*/^%!()'.includes(ch)) {
      tokens.push({ type: ch === '(' || ch === ')' ? 'paren' : 'op', value: ch });
      i += 1;
      continue;
    }

    throw new Error(`Unexpected character: ${ch}`);
  }

  // Insert implicit multiplication (e.g. 2pi, 3(4+5), (2)(3), 2sin(30))
  const expanded = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const curr = tokens[idx];
    const prev = expanded[expanded.length - 1];
    if (prev) {
      const prevEndsValue =
        prev.type === 'num' ||
        (prev.type === 'paren' && prev.value === ')') ||
        (prev.type === 'op' && prev.value === '!');
      const currStartsValue =
        curr.type === 'num' ||
        curr.type === 'fn' ||
        (curr.type === 'paren' && curr.value === '(');
      if (prevEndsValue && currStartsValue) {
        expanded.push({ type: 'op', value: '*' });
      }
    }
    expanded.push(curr);
  }
  return expanded;
}

function factorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 170) {
    throw new Error('Factorial domain error');
  }
  let res = 1;
  for (let k = 2; k <= n; k += 1) {
    res *= k;
  }
  return res;
}

function evaluateMath(raw) {
  const tokens = tokenizeExpression(raw);
  if (tokens.length === 0) return 0;
  let pos = 0;

  function peek() {
    return tokens[pos] || null;
  }

  function consume() {
    const tok = tokens[pos];
    pos += 1;
    return tok;
  }

  function toRadians(val) {
    return angleMode === 'deg' ? (val * Math.PI) / 180 : val;
  }

  function parseAddSub() {
    let left = parseMulDiv();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseMulDiv();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseMulDiv() {
    let left = parseUnary();
    while (
      peek() &&
      peek().type === 'op' &&
      (peek().value === '*' || peek().value === '/' || peek().value === '%')
    ) {
      const op = consume().value;
      const right = parseUnary();
      if (op === '*') left *= right;
      else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left /= right;
      } else {
        if (right === 0) throw new Error('Modulo by zero');
        left %= right;
      }
    }
    return left;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const val = parseUnary();
      return op === '-' ? -val : val;
    }
    return parsePower();
  }

  function parsePower() {
    const base = parsePostfix();
    if (peek() && peek().type === 'op' && peek().value === '^') {
      consume();
      const exp = parseUnary();
      return Math.pow(base, exp);
    }
    return base;
  }

  function parsePostfix() {
    let val = parsePrimary();
    while (peek() && peek().type === 'op' && peek().value === '!') {
      consume();
      val = factorial(val);
    }
    return val;
  }

  function applyFn(name, arg) {
    switch (name) {
      case 'sin':
        return Math.sin(toRadians(arg));
      case 'cos':
        return Math.cos(toRadians(arg));
      case 'tan':
        return Math.tan(toRadians(arg));
      case 'asin': {
        const res = Math.asin(arg);
        return angleMode === 'deg' ? (res * 180) / Math.PI : res;
      }
      case 'acos': {
        const res = Math.acos(arg);
        return angleMode === 'deg' ? (res * 180) / Math.PI : res;
      }
      case 'atan': {
        const res = Math.atan(arg);
        return angleMode === 'deg' ? (res * 180) / Math.PI : res;
      }
      case 'sqrt':
        if (arg < 0) throw new Error('Negative sqrt');
        return Math.sqrt(arg);
      case 'log':
        if (arg <= 0) throw new Error('Log domain error');
        return Math.log10(arg);
      case 'ln':
        if (arg <= 0) throw new Error('Ln domain error');
        return Math.log(arg);
      case 'abs':
        return Math.abs(arg);
      default:
        throw new Error(`Unknown function: ${name}`);
    }
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression');

    if (tok.type === 'num') {
      consume();
      return tok.value;
    }

    if (tok.type === 'fn') {
      const fnName = consume().value;
      if (peek() && peek().type === 'paren' && peek().value === '(') {
        consume();
        const inner = parseAddSub();
        if (!peek() || peek().type !== 'paren' || peek().value !== ')') {
          throw new Error('Missing closing parenthesis');
        }
        consume();
        return applyFn(fnName, inner);
      }
      const arg = parseUnary();
      return applyFn(fnName, arg);
    }

    if (tok.type === 'paren' && tok.value === '(') {
      consume();
      const inner = parseAddSub();
      if (!peek() || peek().type !== 'paren' || peek().value !== ')') {
        throw new Error('Missing closing parenthesis');
      }
      consume();
      return inner;
    }

    throw new Error('Unexpected token');
  }

  const result = parseAddSub();
  if (pos < tokens.length) {
    throw new Error('Trailing tokens');
  }
  if (!Number.isFinite(result)) {
    throw new Error('Non-finite result');
  }
  return result;
}

function renderTape() {
  tapeListEl.innerHTML = '';
  if (tapeEntries.length === 0) {
    tapeEmptyEl.hidden = false;
    return;
  }
  tapeEmptyEl.hidden = true;
  tapeEntries.forEach((entry) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tape-row';
    row.title = 'Click to reuse this result';

    const exprSpan = document.createElement('span');
    exprSpan.className = 'tape-expr mono-num';
    exprSpan.textContent = `${formatExpressionForDisplay(entry.expr)} =`;

    const resSpan = document.createElement('strong');
    resSpan.className = 'tape-result mono-num';
    resSpan.textContent = entry.result;

    row.append(exprSpan, resSpan);
    row.addEventListener('click', () => {
      if (errorState || justEvaluated || !expression) {
        expression = entry.result;
      } else {
        expression += entry.result;
      }
      justEvaluated = false;
      errorState = false;
      updateDisplay();
    });
    tapeListEl.appendChild(row);
  });
}

async function triggerAccessUnlock() {
  try {
    const res = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: UNLOCK_CODE }),
      credentials: 'same-origin',
    });
    if (res.ok) {
      localStorage.setItem(UNLOCK_STORAGE_KEY, '1');
      window.location.replace('/unblocker.html');
      return;
    }
  } catch {
    // Fall back to standard display behavior if unlock endpoint fails
  }
  expression = '0';
  justEvaluated = true;
  updateDisplay();
}

function appendDigit(digit) {
  if (errorState || justEvaluated) {
    expression = '';
    errorState = false;
    justEvaluated = false;
  }

  if (digit === '.') {
    // Prevent multiple decimals inside the current numeric segment
    const match = expression.match(/(\d*\.?\d*)$/);
    const segment = match ? match[1] : '';
    if (segment.includes('.')) return;
    expression += segment === '' ? '0.' : '.';
  } else {
    // Preserve sequential zeros literally so sequences like 0000 work cleanly
    expression += digit;
  }
  updateDisplay();
}

function appendOperator(op) {
  if (errorState) {
    expression = '0';
    errorState = false;
  }
  justEvaluated = false;
  if (!expression) {
    if (op === '-') {
      expression = '-';
      updateDisplay();
    }
    return;
  }
  if (/[+\-*/^%]$/.test(expression)) {
    expression = `${expression.slice(0, -1)}${op}`;
  } else {
    expression += op;
  }
  updateDisplay();
}

function appendToken(token) {
  if (errorState || justEvaluated) {
    expression = '';
    errorState = false;
    justEvaluated = false;
  }
  expression += token;
  updateDisplay();
}

function balanceParentheses(raw) {
  let open = 0;
  for (const ch of raw) {
    if (ch === '(') open += 1;
    else if (ch === ')' && open > 0) open -= 1;
  }
  return open > 0 ? `${raw}${')'.repeat(open)}` : raw;
}

function handleEquals() {
  const raw = expression.trim();
  if (!raw) return;

  if (raw === UNLOCK_CODE) {
    void triggerAccessUnlock();
    return;
  }

  try {
    const balanced = balanceParentheses(raw);
    const value = evaluateMath(balanced);
    const formatted = formatNumber(value);
    exprLineEl.textContent = `${formatExpressionForDisplay(balanced)} =`;
    lastAnswer = value;
    expression = formatted;
    justEvaluated = true;
    errorState = false;

    tapeEntries.unshift({ expr: balanced, result: formatted });
    if (tapeEntries.length > 40) tapeEntries = tapeEntries.slice(0, 40);
    saveTape();
    renderTape();
    updateDisplay();
  } catch {
    errorState = true;
    justEvaluated = true;
    exprLineEl.textContent = formatExpressionForDisplay(raw);
    updateDisplay();
  }
}

function handleAction(action) {
  switch (action) {
    case 'clear':
      expression = '';
      errorState = false;
      justEvaluated = false;
      exprLineEl.innerHTML = '&nbsp;';
      updateDisplay();
      break;
    case 'backspace':
      if (errorState || justEvaluated) {
        expression = '';
        errorState = false;
        justEvaluated = false;
      } else {
        expression = expression.slice(0, -1);
      }
      updateDisplay();
      break;
    case 'equals':
      handleEquals();
      break;
    case 'square':
      if (!expression || errorState) return;
      appendOperator('^');
      appendDigit('2');
      break;
    case 'reciprocal':
      if (!expression || errorState) return;
      expression = `1/(${expression})`;
      justEvaluated = false;
      updateDisplay();
      break;
    case 'factorial':
      if (!expression || errorState) return;
      expression += '!';
      justEvaluated = false;
      updateDisplay();
      break;
    case 'negate':
      if (errorState) return;
      if (!expression) {
        expression = '-';
      } else if (expression.startsWith('-')) {
        expression = expression.slice(1);
      } else if (/^[0-9.]+$/.test(expression)) {
        expression = `-${expression}`;
      } else {
        expression = `-(${expression})`;
      }
      justEvaluated = false;
      updateDisplay();
      break;
    case 'ans':
      appendToken('Ans');
      break;
    default:
      break;
  }
}

function handleMemory(op) {
  if (op === 'mc') {
    memoryValue = 0;
    updateDisplay();
    return;
  }
  if (op === 'mr') {
    appendToken(formatNumber(memoryValue));
    return;
  }

  let currentNum = lastAnswer;
  if (expression && !errorState) {
    try {
      currentNum = evaluateMath(balanceParentheses(expression));
    } catch {
      return;
    }
  }
  if (op === 'ms') memoryValue = currentNum;
  else if (op === 'mplus') memoryValue += currentNum;
  else if (op === 'mminus') memoryValue -= currentNum;
  updateDisplay();
}

// Calculator Events
document.querySelectorAll('.calc-key').forEach((btn) => {
  btn.addEventListener('click', () => {
    const { digit, op, fn, token, action } = btn.dataset;
    if (digit !== undefined) appendDigit(digit);
    else if (op !== undefined) appendOperator(op);
    else if (fn !== undefined) appendToken(fn);
    else if (token !== undefined) appendToken(token);
    else if (action !== undefined) handleAction(action);
  });
});

document.querySelectorAll('.mem-btn').forEach((btn) => {
  btn.addEventListener('click', () => handleMemory(btn.dataset.mem));
});

[angleDegBtn, angleRadBtn].forEach((btn) => {
  btn.addEventListener('click', () => {
    angleMode = btn.dataset.angle === 'rad' ? 'rad' : 'deg';
    angleDegBtn.classList.toggle('is-active', angleMode === 'deg');
    angleRadBtn.classList.toggle('is-active', angleMode === 'rad');
  });
});

tapeClearBtn.addEventListener('click', () => {
  tapeEntries = [];
  saveTape();
  renderTape();
});

headerClearBtn.addEventListener('click', () => {
  handleAction('clear');
});

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.addEventListener('click', (ev) => {
    ev.preventDefault();
    const target = el.dataset.nav;
    if (target) showView(target);
  });
});

document.addEventListener('keydown', (ev) => {
  const activeTag = document.activeElement ? document.activeElement.tagName : '';
  if (activeTag === 'INPUT' || activeTag === 'SELECT' || activeTag === 'TEXTAREA') return;
  if (!document.getElementById('view-calculator').classList.contains('is-visible')) return;

  if (ev.key >= '0' && ev.key <= '9') {
    ev.preventDefault();
    appendDigit(ev.key);
  } else if (ev.key === '.') {
    ev.preventDefault();
    appendDigit('.');
  } else if ('+-*/^%'.includes(ev.key)) {
    ev.preventDefault();
    appendOperator(ev.key);
  } else if (ev.key === '(' || ev.key === ')') {
    ev.preventDefault();
    appendToken(ev.key);
  } else if (ev.key === 'Enter' || ev.key === '=') {
    ev.preventDefault();
    handleAction('equals');
  } else if (ev.key === 'Backspace') {
    ev.preventDefault();
    handleAction('backspace');
  } else if (ev.key === 'Escape' || ev.key === 'Delete') {
    ev.preventDefault();
    handleAction('clear');
  }
});

// Unit Converter
const UNIT_DEFS = {
  length: {
    base: 'm',
    units: {
      m: { label: 'Meters (m)', factor: 1 },
      km: { label: 'Kilometers (km)', factor: 1000 },
      cm: { label: 'Centimeters (cm)', factor: 0.01 },
      mm: { label: 'Millimeters (mm)', factor: 0.001 },
      mi: { label: 'Miles (mi)', factor: 1609.344 },
      yd: { label: 'Yards (yd)', factor: 0.9144 },
      ft: { label: 'Feet (ft)', factor: 0.3048 },
      in: { label: 'Inches (in)', factor: 0.0254 },
    },
    defaults: ['km', 'mi'],
  },
  mass: {
    base: 'kg',
    units: {
      kg: { label: 'Kilograms (kg)', factor: 1 },
      g: { label: 'Grams (g)', factor: 0.001 },
      mg: { label: 'Milligrams (mg)', factor: 1e-6 },
      lb: { label: 'Pounds (lb)', factor: 0.45359237 },
      oz: { label: 'Ounces (oz)', factor: 0.028349523125 },
    },
    defaults: ['kg', 'lb'],
  },
  temperature: {
    units: {
      c: { label: 'Celsius (°C)' },
      f: { label: 'Fahrenheit (°F)' },
      k: { label: 'Kelvin (K)' },
    },
    defaults: ['c', 'f'],
  },
  angle: {
    base: 'deg',
    units: {
      deg: { label: 'Degrees (°)', factor: 1 },
      rad: { label: 'Radians (rad)', factor: 180 / Math.PI },
      grad: { label: 'Gradians (gon)', factor: 0.9 },
      turn: { label: 'Turns', factor: 360 },
    },
    defaults: ['deg', 'rad'],
  },
  data: {
    base: 'b',
    units: {
      b: { label: 'Bytes (B)', factor: 1 },
      kb: { label: 'Kilobytes (KB)', factor: 1024 },
      mb: { label: 'Megabytes (MB)', factor: 1024 ** 2 },
      gb: { label: 'Gigabytes (GB)', factor: 1024 ** 3 },
      tb: { label: 'Terabytes (TB)', factor: 1024 ** 4 },
    },
    defaults: ['gb', 'mb'],
  },
};

let activeConvCategory = 'length';
const convFromValue = document.getElementById('conv-from-value');
const convToValue = document.getElementById('conv-to-value');
const convFromUnit = document.getElementById('conv-from-unit');
const convToUnit = document.getElementById('conv-to-unit');
const convSwapBtn = document.getElementById('conv-swap-btn');
const convFormulaNote = document.getElementById('conv-formula-note');

function convertTemperature(val, from, to) {
  let celsius = val;
  if (from === 'f') celsius = ((val - 32) * 5) / 9;
  else if (from === 'k') celsius = val - 273.15;

  if (to === 'c') return celsius;
  if (to === 'f') return (celsius * 9) / 5 + 32;
  return celsius + 273.15;
}

function updateConversion() {
  const raw = Number(convFromValue.value);
  const from = convFromUnit.value;
  const to = convToUnit.value;
  if (!Number.isFinite(raw)) {
    convToValue.value = '';
    convFormulaNote.textContent = '';
    return;
  }

  let result;
  if (activeConvCategory === 'temperature') {
    result = convertTemperature(raw, from, to);
    convFormulaNote.textContent = `${raw} ${from.toUpperCase()} = ${formatNumber(result)} ${to.toUpperCase()}`;
  } else {
    const def = UNIT_DEFS[activeConvCategory];
    const fromFactor = def.units[from].factor;
    const toFactor = def.units[to].factor;
    result = (raw * fromFactor) / toFactor;
    const ratio = fromFactor / toFactor;
    convFormulaNote.textContent = `1 ${from} = ${formatNumber(ratio)} ${to}`;
  }
  convToValue.value = formatNumber(result);
}

function loadConverterCategory(cat) {
  activeConvCategory = cat;
  const def = UNIT_DEFS[cat];
  convFromUnit.innerHTML = '';
  convToUnit.innerHTML = '';
  Object.entries(def.units).forEach(([key, info]) => {
    const optA = document.createElement('option');
    optA.value = key;
    optA.textContent = info.label;
    const optB = optA.cloneNode(true);
    convFromUnit.appendChild(optA);
    convToUnit.appendChild(optB);
  });
  convFromUnit.value = def.defaults[0];
  convToUnit.value = def.defaults[1];
  updateConversion();
}

document.querySelectorAll('#converter-categories .filter-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#converter-categories .filter-tab').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    loadConverterCategory(btn.dataset.cat);
  });
});

convFromValue.addEventListener('input', updateConversion);
convFromUnit.addEventListener('change', updateConversion);
convToUnit.addEventListener('change', updateConversion);
convSwapBtn.addEventListener('click', () => {
  const prevFrom = convFromUnit.value;
  convFromUnit.value = convToUnit.value;
  convToUnit.value = prevFrom;
  updateConversion();
});

// Formula Sheet Solvers
function updateFormulas() {
  const a = Number(document.getElementById('quad-a').value);
  const b = Number(document.getElementById('quad-b').value);
  const c = Number(document.getElementById('quad-c').value);
  const quadEl = document.getElementById('quad-result');
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || a === 0) {
    quadEl.textContent = a === 0 ? 'Enter a ≠ 0' : 'Enter valid coefficients';
  } else {
    const disc = b * b - 4 * a * c;
    if (disc > 0) {
      const r1 = (-b + Math.sqrt(disc)) / (2 * a);
      const r2 = (-b - Math.sqrt(disc)) / (2 * a);
      quadEl.textContent = `x₁ = ${formatNumber(r1)}, x₂ = ${formatNumber(r2)}`;
    } else if (disc === 0) {
      quadEl.textContent = `x = ${formatNumber(-b / (2 * a))} (double root)`;
    } else {
      const real = formatNumber(-b / (2 * a));
      const imag = formatNumber(Math.sqrt(-disc) / (2 * a));
      quadEl.textContent = `x = ${real} ± ${imag}i`;
    }
  }

  const pa = Number(document.getElementById('pyth-a').value);
  const pb = Number(document.getElementById('pyth-b').value);
  const pythEl = document.getElementById('pyth-result');
  pythEl.textContent =
    Number.isFinite(pa) && Number.isFinite(pb)
      ? `c = ${formatNumber(Math.hypot(pa, pb))}`
      : 'Enter valid lengths';

  const r = Number(document.getElementById('circle-r').value);
  const circleEl = document.getElementById('circle-result');
  if (Number.isFinite(r) && r >= 0) {
    const area = Math.PI * r * r;
    const circ = 2 * Math.PI * r;
    const vol = (4 / 3) * Math.PI * r * r * r;
    circleEl.textContent = `A = ${formatNumber(area)} · C = ${formatNumber(circ)} · V = ${formatNumber(vol)}`;
  } else {
    circleEl.textContent = 'Enter radius ≥ 0';
  }

  const p = Number(document.getElementById('ci-p').value);
  const rate = Number(document.getElementById('ci-r').value) / 100;
  const n = Number(document.getElementById('ci-n').value);
  const t = Number(document.getElementById('ci-t').value);
  const ciEl = document.getElementById('ci-result');
  if (Number.isFinite(p) && Number.isFinite(rate) && Number.isFinite(n) && Number.isFinite(t) && n > 0 && t >= 0) {
    const total = p * Math.pow(1 + rate / n, n * t);
    ciEl.textContent = `Total = $${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else {
    ciEl.textContent = 'Enter valid parameters';
  }
}

['quad-a', 'quad-b', 'quad-c', 'pyth-a', 'pyth-b', 'circle-r', 'ci-p', 'ci-r', 'ci-n', 'ci-t'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateFormulas);
});

// Boot
updateDisplay();
renderTape();
loadConverterCategory('length');
updateFormulas();
