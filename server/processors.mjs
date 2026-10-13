import { createHash } from 'node:crypto';

export const jobTypes = ['text-analysis', 'csv-summary', 'hash-chain'];

const integer = (value, name, min, max, fallback) => {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return result;
};

export function validateJob(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('A JSON job object is required.');
  if (!jobTypes.includes(body.type)) throw new Error(`Type must be ${jobTypes.join(', ')}.`);
  const input = body.input;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Input must be an object.');
  const field =
    body.type === 'text-analysis' ? 'text' : body.type === 'csv-summary' ? 'csv' : 'seed';
  if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 500_000)
    throw new Error(`${field} must contain 1–500,000 characters.`);
  const cleanInput = { [field]: input[field] };
  if (body.type === 'hash-chain')
    cleanInput.iterations = integer(input.iterations, 'Iterations', 1_000, 2_000_000, 100_000);
  const name = body.name ?? body.type;
  if (typeof name !== 'string' || !name.trim() || name.length > 100)
    throw new Error('Name must contain 1–100 characters.');
  const key = body.idempotencyKey;
  if (key != null && (typeof key !== 'string' || !key.trim() || key.length > 128))
    throw new Error('Idempotency key must contain 1–128 characters.');
  return {
    type: body.type,
    name: name.trim(),
    input: cleanInput,
    idempotencyKey: key ?? null,
    maxAttempts: integer(body.maxAttempts, 'Max attempts', 1, 5, 3),
    failFirst: integer(body.failFirst, 'Simulated failures', 0, 5, 0),
    delayMs: integer(body.delayMs, 'Delay', 0, 86_400_000, 0),
    backoffMs: integer(body.backoffMs, 'Backoff', 100, 60_000, 1_000),
  };
}

export function parseCsv(source) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  const pushCell = () => {
    row.push(cell);
    cell = '';
    closed = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else cell += char;
    } else if (char === '"') {
      if (cell || closed) throw new Error('CSV contains a quote inside an unquoted field.');
      quoted = true;
    } else if (char === ',') pushCell();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      pushCell();
      rows.push(row);
      row = [];
    } else {
      if (closed) throw new Error('CSV has characters after a closing quote.');
      cell += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  if (cell || row.length || closed) {
    pushCell();
    rows.push(row);
  }
  if (rows.length < 2) throw new Error('CSV needs a header and at least one data row.');
  const headers = rows
    .shift()
    .map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, '') : value).trim());
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length)
    throw new Error('CSV headers must be non-empty and unique.');
  if (rows.some((values) => values.length !== headers.length))
    throw new Error('CSV rows must match the number of header columns.');
  return { headers, rows };
}

export function processJob(type, input, onProgress = () => {}) {
  if (type === 'text-analysis') {
    const words = input.text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
    const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    onProgress(100);
    return {
      characters: [...input.text].length,
      words: words.length,
      uniqueWords: counts.size,
      sentences: input.text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.length ?? 0,
      readingTimeSeconds: Math.ceil((words.length / 200) * 60),
      topWords: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 10)
        .map(([word, count]) => ({ word, count })),
    };
  }
  if (type === 'csv-summary') {
    const { headers, rows } = parseCsv(input.csv);
    const columns = headers.map((name, index) => {
      const values = rows.map((row) => row[index]);
      const present = values.filter((value) => value.trim());
      const numeric =
        present.length > 0 && present.every((value) => Number.isFinite(Number(value)));
      const numbers = numeric ? present.map(Number) : [];
      const stats = numbers.reduce(
        (acc, value) => ({
          min: Math.min(acc.min, value),
          max: Math.max(acc.max, value),
          sum: acc.sum + value,
        }),
        { min: Infinity, max: -Infinity, sum: 0 },
      );
      return {
        name,
        type: numeric ? 'number' : 'text',
        missing: values.length - present.length,
        unique: new Set(present).size,
        ...(numeric ? { ...stats, mean: stats.sum / numbers.length } : {}),
      };
    });
    onProgress(100);
    return {
      rows: rows.length,
      columns,
      duplicateRows: rows.length - new Set(rows.map((row) => JSON.stringify(row))).size,
      preview: rows.slice(0, 5),
    };
  }
  if (type === 'hash-chain') {
    let digest = Buffer.from(input.seed);
    for (let i = 0; i < input.iterations; i++) {
      digest = createHash('sha256').update(digest).digest();
      if ((i + 1) % 10_000 === 0) onProgress(Math.floor(((i + 1) / input.iterations) * 100));
    }
    onProgress(100);
    return {
      algorithm: 'SHA-256 hash chain',
      iterations: input.iterations,
      seedBytes: Buffer.byteLength(input.seed),
      digest: digest.toString('hex'),
    };
  }
  throw new Error('Unknown processor.');
}
