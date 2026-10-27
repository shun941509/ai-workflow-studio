// Operational helper: no network, no implicit permissions, no writes to input files.
const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' && value.trim().length > 0;
const stable = (value) => JSON.stringify(Array.isArray(value) ? value.map(v => JSON.parse(stable(v))) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]))])) : value);
const unique = (values) => new Set(values).size === values.length;
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 1048576) fail('Input exceeds 1 MiB.'); chunks.push(chunk); }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!object(input)) fail('Expected a JSON object.');

  // The OS/host must authorize the path; SQLite readOnly is the actual no-write boundary.
  const { DatabaseSync } = await import('node:sqlite');
  const { isAbsolute } = await import('node:path');
  const { databasePath, sql, rowLimit=100 }=input;
  if (!string(databasePath) || !isAbsolute(databasePath) || !string(sql) || !Number.isInteger(rowLimit) || rowLimit<1 || rowLimit>100) fail('Absolute approved database path, SELECT and rowLimit 1..100 required.');
  if (!/^\s*SELECT\b/i.test(sql) || /;|--|\/\*|\b(?:insert|update|delete|replace|create|drop|alter|attach|detach|pragma|vacuum|reindex|load_extension|writefile|readfile)\b/i.test(sql)) fail('Only a restricted single SELECT is supported.');
  const db = new DatabaseSync(databasePath,{readOnly:true,allowExtension:false,enableDoubleQuotedStringLiterals:false});
  let result;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
    const statement=db.prepare(sql); statement.setReadBigInts(true);
    const rows=[]; let truncated=false;
    for (const row of statement.iterate()) {
      if(rows.length===rowLimit){truncated=true;break;}
      rows.push(Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?{integerDecimal:v.toString()}:v instanceof Uint8Array?{blobBase64:Buffer.from(v).toString('base64')}:v])));
    }
    result={rows,truncated,rowLimit,readOnly:true,integerEncoding:'integerDecimal strings preserve exact SQLite integers'};
  } finally { db.close(); }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
